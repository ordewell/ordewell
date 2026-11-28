import { describe, expect, it, vi } from 'vitest';
import { LANDED_BLOCKER_ADVICE, RETRY_ESCALATION, Supervisor, wakeUpDigest, type RunEventInput, type SupervisedRun, type SupervisorHost } from '../Supervisor';
import { boundedWakeUps, WAKE_MAX_CHARS, type RunEvent } from '../WakePolicy';

const describeTask = (taskId: string) => `#${taskId.slice(1)} "Task ${taskId}"`;

describe('wakeUpDigest', () => {
  it('names each event with its task and a short detail, never a log, then the passes since the last update', () => {
    const attention: RunEvent[] = [
      { kind: 'task_failed', taskId: 't1', at: 0, detail: 'The runner reported failure:\n  the tests fail' },
      { kind: 'waiting_input', taskId: 't2', at: 0, detail: 'Which database?' },
      { kind: 'waiting_approval', taskId: 't3', at: 0, detail: 'Bash(npm publish)' },
      { kind: 'task_idle', taskId: 't4', at: 0, detail: 'no output since 2026-10-11T18:05:00.000Z' },
      { kind: 'landing_conflict', taskId: 't5', at: 0 },
      { kind: 'auto_merge_stopped', taskId: 't6', at: 0, detail: 'it conflicts in .: a.ts' },
      { kind: 'usage_limit', taskId: 't7', taskIds: ['t7', 't8'], at: 0, runner: 'codex', resumeAt: null },
      { kind: 'run_finished', at: 0, detail: '5 of 8 tasks completed, 1 failed' },
    ];

    expect(wakeUpDigest({ attention, sinceLast: [{ kind: 'task_passed', taskId: 't9', at: 0 }] }, describeTask)).toBe([
      'Run update:',
      '- task #1 "Task t1" failed: The runner reported failure: the tests fail',
      '- task #2 "Task t2" is waiting for input: Which database?',
      '- task #3 "Task t3" is waiting for approval: Bash(npm publish)',
      '- task #4 "Task t4" has gone quiet (no output since 2026-10-11T18:05:00.000Z)',
      '- task #5 "Task t5" finished, but its work conflicts and could not land',
      '- automatic Merge all at the merge gate of task #6 "Task t6" stopped: it conflicts in .: a.ts; the gate waits for the user',
      '- codex\'s usage limit paused 2 tasks, which wait for a retry, as the reset time could not be read: #7 "Task t7" and #8 "Task t8"',
      '- the run finished: 5 of 8 tasks completed, 1 failed',
      'Since the last update:',
      '- task #9 "Task t9" passed',
    ].join('\n'));
  });

  it('names an automatic Merge all at the run\'s end, which has no task, as the run\'s', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'auto_merge_stopped', at: 0, detail: 'it conflicts in .: a.ts' }], sinceLast: [] }, describeTask);

    expect(digest.split('\n')[1]).toBe('- automatic Merge all at the end of the run stopped: it conflicts in .: a.ts; the run is handed over to the user to merge');
  });

  it('cuts a long detail to one short line', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_failed', taskId: 't1', at: 0, detail: 'x'.repeat(1000) }], sinceLast: [] }, describeTask);

    expect(digest.split('\n')[1].length).toBeLessThan(300);
    expect(digest).toMatch(/…$/);
  });

  // Recorded: woken for an opening task running long, the supervisor saw edits outside its brief and had it revert what its role allowed.
  describe('a task with a role in a fan-out (ADR-0072 R5)', () => {
    const OPENING = 'the opening task, which may edit any file to make the project import and its tests collect';
    const role = (taskId: string) => (taskId === 't1' ? OPENING : undefined);
    const MINUTE = 60_000;

    it('names the role after what the task did, running long, at its context threshold or failed', () => {
      const lines = wakeUpDigest({ attention: [
        { kind: 'running_long', taskId: 't1', at: 0, runningLong: { reason: 'duration', elapsedMs: 30 * MINUTE, thresholdMs: 30 * MINUTE, compactions: 0, attempt: 1 } },
        { kind: 'task_failed', taskId: 't1', at: 0, detail: 'the tests do not collect' },
        { kind: 'task_failed', taskId: 't2', at: 0, detail: 'the tests fail' },
        { kind: 'running_long', taskId: 't1', at: 0, runningLong: { reason: 'context', elapsedMs: 40 * MINUTE, thresholdMs: 60 * MINUTE, contextThreshold: 200_000, contextTokens: 210_000, contextWindow: 400_000, compactions: 0, attempt: 1 } },
      ], sinceLast: [] }, describeTask, () => [], role).split('\n');

      expect(lines.slice(1, 4)).toEqual([
        `- task #1 "Task t1" has run long: 30m 00s running, past its 30m 00s threshold (the 30m 00s floor); it is ${OPENING}`,
        `- task #1 "Task t1" failed: the tests do not collect; it is ${OPENING}`,
        '- task #2 "Task t2" failed: the tests fail',
      ]);
      expect(lines[4]).toMatch(new RegExp(`^- task #1 "Task t1"'s context reached its threshold: .*; it is ${OPENING}$`));
    });

    it('keeps the line\'s own facts as long as they were, the role beside them', () => {
      const event: RunEvent = { kind: 'task_failed', taskId: 't1', at: 0, detail: 'x'.repeat(1000) };
      const bare = wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1];
      const named = wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask, () => [], role).split('\n')[1];

      expect(named).toBe(`${bare}; it is ${OPENING}`);
    });
  });

  describe('a task running long (ADR-0018 W1)', () => {
    const MINUTE = 60_000;
    const runningLong = (taskId: string, facts: Partial<NonNullable<RunEvent['runningLong']>> = {}): RunEvent => ({
      kind: 'running_long', taskId, at: 0,
      runningLong: { reason: 'duration', elapsedMs: 65 * MINUTE, thresholdMs: 60 * MINUTE, compactions: 0, attempt: 1, ...facts },
    });
    const ADVICE = 'Running long is advice, never a verdict: read the task\'s output with task_output; if its brief\'s done criterion holds, or it is stuck on what that criterion does not need or the workspace cannot tell it, message_task it to commit what works, call task_complete and list the rest; if the brief is too large, stop_task it and split it; otherwise let it go on.';

    it('names its running time, the threshold and the task it was computed from, its context and its compactions, then what the supervisor can do', () => {
      const event = runningLong('t4', {
        basis: { taskId: 't2', runningMs: 20 * MINUTE }, contextTokens: 150_000, contextWindow: 200_000, peakContextTokens: 190_000, compactions: 1,
      });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')).toEqual([
        'Run update:',
        '- task #4 "Task t4" has run long: 1h 05m running, past its 1h 00m threshold (3× the 20m 00s task #2 "Task t2" passed in); context 150k of 200k tokens, peak 190k; compacted once',
        ADVICE,
      ]);
    });

    it('names a window no catalog or listing stated as assumed', () => {
      const event = runningLong('t4', { contextTokens: 90_000, contextWindow: 128_000, contextWindowAssumed: true });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toContain('; context 90k of an assumed 128k tokens');
    });

    it('names an assumed window when the context flag fires against it', () => {
      const event = runningLong('t4', { reason: 'context', elapsedMs: 40 * MINUTE, thresholdMs: 60 * MINUTE, contextThreshold: 200_000, contextTokens: 210_000, contextWindow: 400_000, contextWindowAssumed: true });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toContain('context 210k of an assumed 400k window, past 200k');
    });

    it('names the landed task a blocker is reported in, the first reports by reference and the closing check, then says once what to do', () => {
      const event: RunEvent = {
        kind: 'landed_blocker',
        at: 0,
        taskId: 't1',
        landedBlocker: { owner: 't1', reporters: 4, reports: [{ reporter: 't5', finding: 'F2', title: 'tokenize() drops the last token' }, { reporter: 't7', finding: 'F1', title: 'same' }], closer: 't9' },
      };
      const lines = wakeUpDigest({ attention: [event, { ...event, taskId: 't2', landedBlocker: { owner: 't2', reporters: 1, reports: [{ reporter: 't3', finding: 'F1', title: 'x' }] } }], sinceLast: [] }, describeTask).split('\n');

      expect(lines[1]).toBe('- task #1 "Task t1" has landed, and 4 tasks report a blocker in its work: #5/F2 "tokenize() drops the last token"; #7/F1 "same" and 2 more; the closing check is #9 "Task t9"');
      expect(lines[2]).toBe('- task #2 "Task t2" has landed, and 1 task reports a blocker in its work: #3/F1 "x"');
      expect(lines.filter((line) => line === LANDED_BLOCKER_ADVICE)).toHaveLength(1);
    });

    it('names the floor when no AI task has passed', () => {
      const event = runningLong('t4', { elapsedMs: 30 * MINUTE, thresholdMs: 30 * MINUTE });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4" has run long: 30m 00s running, past its 30m 00s threshold (the 30m 00s floor)');
    });

    it('names the median the passed tasks took when it set the threshold, and still what the task holds back', () => {
      const event = runningLong('t4', { elapsedMs: 22 * MINUTE, thresholdMs: 22 * MINUTE, median: { passed: 12, runningMs: 440_000 } });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask, () => ['t7']).split('\n')[1])
        .toBe('- task #4 "Task t4" has run long: 22m 00s running, past its 22m 00s threshold (the 12 tasks that have passed took a median of 7m 20s; 3× that, 19m 00s at least); it blocks task #7 "Task t7"');
    });

    it('names the median rule\'s floor when it set a first flag', () => {
      const event = runningLong('t4', { elapsedMs: 19 * MINUTE, thresholdMs: 19 * MINUTE, median: { passed: 5, runningMs: 2 * MINUTE } });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4" has run long: 19m 00s running, past its 19m 00s threshold (the 5 tasks that have passed took a median of 2m 00s; 3× that, 19m 00s at least)');
    });

    it('names the earlier flag a later one is twice, whatever the threshold reads now', () => {
      // A flag at 19 minutes, then passes raise the median's threshold to 45: the next is still due at 38.
      const event = runningLong('t4', { elapsedMs: 38 * MINUTE, thresholdMs: 38 * MINUTE, previousMs: 19 * MINUTE, median: { passed: 9, runningMs: 15 * MINUTE } });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4" has run long: 38m 00s running, past its 38m 00s threshold (twice the 19m 00s its last flag was due at)');
    });

    it('names the earlier attempt a retry\'s threshold was its running time of', () => {
      const event = runningLong('t4', { elapsedMs: 42 * MINUTE, thresholdMs: 42 * MINUTE, attempt: 2, retryOf: { attempt: 1, runningMs: 42 * MINUTE, outcome: 'failed' } });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4" has run long: 42m 00s running, past its 42m 00s threshold (the 42m 00s attempt 1 ran before it failed)');
    });

    it('names an automatic compaction of its runner\'s session, whatever the time', () => {
      const event = runningLong('t4', { reason: 'compaction', elapsedMs: 12 * MINUTE, thresholdMs: 30 * MINUTE, contextTokens: 30_000, contextWindow: 200_000, peakContextTokens: 190_000, compactions: 2 });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4"\'s runner compacted its context on its own, 2 times this attempt, after 12m 00s running; context 30k of 200k tokens, peak 190k');
    });

    it('names the window the task compacts at, beside its model\'s, when Ordewell sets one', () => {
      const event = runningLong('t4', { reason: 'compaction', elapsedMs: 12 * MINUTE, thresholdMs: 30 * MINUTE, contextTokens: 16_000, contextWindow: 1_000_000, compactionWindow: 150_000, peakContextTokens: 117_000, compactions: 3 });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4"\'s runner compacted its context on its own, 3 times this attempt, after 12m 00s running; context 16k of a 150k compaction window (model window 1000k), peak 117k');
    });

    it('names the compaction window on an unknown context too, and without a model window when none is known', () => {
      const event = runningLong('t4', { reason: 'duration', elapsedMs: 65 * MINUTE, thresholdMs: 60 * MINUTE, compactionWindow: 150_000, peakContextTokens: 117_000, compactions: 1 });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toContain('; context unknown since compacting, peak 117k of a 150k compaction window');
    });

    it('still names the peak and the window when the compaction stated no size, as on Codex and OpenCode', () => {
      const event = runningLong('t4', { reason: 'compaction', elapsedMs: 12 * MINUTE, thresholdMs: 30 * MINUTE, contextWindow: 200_000, peakContextTokens: 190_000, compactions: 1 });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4"\'s runner compacted its context on its own, once this attempt, after 12m 00s running; context unknown since compacting, peak 190k of 200k tokens');
    });

    it('names no compaction for an unknown context when the attempt never compacted, as after a /clear', () => {
      const event = runningLong('t4', { reason: 'duration', elapsedMs: 65 * MINUTE, thresholdMs: 60 * MINUTE, contextWindow: 200_000, peakContextTokens: 150_000, compactions: 0 });

      const line = wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1];
      expect(line).toContain('; context unknown, peak 150k of 200k tokens');
      expect(line).not.toContain('compacting');
    });

    it('names a context that reached its threshold, against the model\'s window, then what the supervisor can do', () => {
      const event = runningLong('t4', { reason: 'context', elapsedMs: 40 * MINUTE, thresholdMs: 60 * MINUTE, contextThreshold: 400_000, contextTokens: 412_000, contextWindow: 1_000_000, peakContextTokens: 412_000 });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')).toEqual([
        'Run update:',
        '- task #4 "Task t4"\'s context reached its threshold: context 412k of a 1000k window, past 400k (40% of the window, 150k at least), after 40m 00s running',
        ADVICE,
      ]);
    });

    it('names a context threshold doubled by an earlier flag, the compaction window it was measured against, and the compactions so far', () => {
      const event = runningLong('t4', { reason: 'context', elapsedMs: 40 * MINUTE, thresholdMs: 60 * MINUTE, contextThreshold: 320_000, contextTokens: 330_000, contextWindow: 1_000_000, compactionWindow: 400_000, compactions: 1 });

      expect(wakeUpDigest({ attention: [event], sinceLast: [] }, describeTask).split('\n')[1])
        .toBe('- task #4 "Task t4"\'s context reached its threshold: context 330k of a 400k compaction window (model window 1000k), past 320k (40% of the window, 150k at least, doubled after each earlier flag), after 40m 00s running; compacted once');
    });

    it('says what the supervisor can do once however many tasks run long, and not at all when none does', () => {
      const digest = wakeUpDigest({ attention: [runningLong('t4'), { kind: 'task_idle', taskId: 't5', at: 0 }, runningLong('t6')], sinceLast: [] }, describeTask);

      expect(digest.split('\n').filter((line) => line === ADVICE)).toHaveLength(1);
      expect(wakeUpDigest({ attention: [{ kind: 'task_idle', taskId: 't5', at: 0 }], sinceLast: [] }, describeTask)).not.toContain('Running long');
    });

    it('counts a flag left out of a full wake as running long', () => {
      const failures: RunEvent[] = Array.from({ length: 200 }, (_, i) => ({ kind: 'waiting_input', taskId: `t${i}`, at: 0, detail: 'x'.repeat(200) }));
      const digest = wakeUpDigest({ attention: [...failures, runningLong('t999')], sinceLast: [] }, describeTask);

      expect(digest).toMatch(/1 running long/);
    });
  });

  it('names each passed task once', () => {
    const pass = (taskId: string): RunEvent => ({ kind: 'task_passed', taskId, at: 0 });
    const digest = wakeUpDigest({ attention: [{ kind: 'run_finished', at: 0 }], sinceLast: [pass('t1'), pass('t2'), pass('t1'), pass('t3')] }, describeTask);

    expect(digest.split('\n').slice(2)).toEqual(['Since the last update:', '- task #1 "Task t1" passed', '- task #2 "Task t2" passed', '- task #3 "Task t3" passed']);
  });
});

describe('a wake\'s size (ADR-0057 R5)', () => {
  const failed = (taskId: string, detail = 'broke'): RunEvent => ({ kind: 'task_failed', taskId, at: 0, detail });
  const pass = (taskId: string): RunEvent => ({ kind: 'task_passed', taskId, at: 0 });
  const named = (taskId: string) => `#${taskId} "${'A rather long task title '.repeat(4)}"`;
  const ids = (count: number, prefix = 't') => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
  const lines = (digest: string) => digest.split('\n');

  it('takes each event that rode along in one line of at most 120', () => {
    const digest = wakeUpDigest({ attention: [failed('t1', 'x'.repeat(500)), { kind: 'task_idle', taskId: 't2', at: 0, detail: 'y'.repeat(500) }], sinceLast: [pass('t3')] }, named);

    const body = lines(digest).filter((l) => l.startsWith('- '));
    expect(body).toHaveLength(3);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(120);
  });

  it('keeps the detail of what woke it, past a ride-along\'s length', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'waiting_input', taskId: 't1', at: 0, detail: 'q'.repeat(200) }], sinceLast: [] }, describeTask);

    expect(digest).toContain('q'.repeat(200));
  });

  it('names the first few of a failure\'s blocked tasks and counts the rest', () => {
    const digest = wakeUpDigest({ attention: [failed('t1')], sinceLast: [] }, describeTask, () => ids(1000, 'b'));

    expect(digest).toContain('it blocks tasks #1 "Task b1", #2 "Task b2", #3 "Task b3" and 997 more');
    expect(digest).not.toContain('b4');
    expect(digest.length).toBeLessThan(300);
  });

  it('keeps a short list whole', () => {
    expect(wakeUpDigest({ attention: [failed('t1')], sinceLast: [] }, describeTask, () => ['b1', 'b2', 'b3'])).toContain('tasks #1 "Task b1", #2 "Task b2" and #3 "Task b3"');
  });

  it('names the first few tasks a usage limit paused and counts the rest', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'usage_limit', taskId: 't1', taskIds: ids(50), at: 0, runner: 'codex', resumeAt: null }], sinceLast: [] }, describeTask);

    expect(digest).toContain('codex\'s usage limit paused 50 tasks');
    expect(digest).toContain('and 47 more');
  });

  it('stays inside the cap however many tasks passed, and points at what reads the rest', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'run_finished', at: 0 }], sinceLast: ids(5000).map(pass) }, named);

    expect(digest.length).toBeLessThanOrEqual(WAKE_MAX_CHARS);
    expect(digest).toContain('- the run finished');
    expect(lines(digest).at(-1)).toMatch(/^\+\d+ more: \d+ passed; task_query reads them\.$/);
  });

  it('shows what woke it ahead of what rode along, whatever order they came in', () => {
    const noise = ids(1000).map((id) => failed(id, 'z'.repeat(500)));
    const question: RunEvent = { kind: 'waiting_input', taskId: 'ask', at: 0, detail: 'Which database?' };

    const digest = wakeUpDigest({ attention: [...noise, question], sinceLast: ids(1000, 'p').map(pass) }, named);

    expect(digest.length).toBeLessThanOrEqual(WAKE_MAX_CHARS);
    expect(digest).toContain('Which database?');
    expect(lines(digest).at(-1)).toMatch(/passed/);
  });

  it('keeps a report whole until the cap, then counts it, and never cuts one', () => {
    const report = (taskId: string): RunEvent => ({ kind: 'task_report', taskId, at: 0, report: { authority: 'supervisor', text: 'r'.repeat(10_000), passed: true } });

    const digest = wakeUpDigest({ attention: [report('t1'), report('t2'), report('t3')], sinceLast: [] }, describeTask);

    expect(digest.length).toBeLessThanOrEqual(WAKE_MAX_CHARS);
    expect(digest.match(/r{10000}/g)).toHaveLength(2);
    expect(lines(digest).at(-1)).toBe('+1 more: 1 reported; task_query reads them.');
  });

  it('builds a turn\'s message from every update that waited, within the cap', () => {
    const digests = ['a'.repeat(10_000), 'b'.repeat(10_000), 'c'.repeat(10_000), 'd'];

    expect(boundedWakeUps(digests)).toEqual(['+1 earlier run update left out.', digests[1], digests[2], digests[3]]);
    expect(boundedWakeUps(['short'])).toEqual(['short']);
  });

  it('reads the plan once for a whole digest, not once per name', () => {
    const describe = vi.fn(describeTask);
    wakeUpDigest({ attention: [failed('t1')], sinceLast: [] }, describe, () => ids(10_000, 'b'));

    expect(describe.mock.calls.length).toBeLessThan(10);
  });
});

describe('Supervisor', () => {
  /** What each delivery says and whose it is; which tasks it is about is its own test's. */
  const delivered = (h: { deliver: ReturnType<typeof vi.fn> }) => h.deliver.mock.calls.map((call) => call.slice(0, call[2] ? 3 : 2));

  function host(run: SupervisedRun | null): SupervisorHost & { deliver: ReturnType<typeof vi.fn>; dropToWatch: ReturnType<typeof vi.fn> } {
    return {
      run: () => run, deliver: vi.fn(async () => undefined), pump: vi.fn(), saveState: vi.fn(), stoppedByUser: () => false, digestReader: () => ({ describe: describeTask, blockedBy: () => [] }),
      // Nothing left to wait for: what is held goes at the window, as the tests here want it to (WakePolicy.test.ts holds the rest).
      wakeFacts: () => ({ nothingCanStart: true, cohortDone: new Set<string>(), blocksWork: new Set<string>(), blocksAny: new Set<string>(), requestAt: null }), readBudget: () => 12, retryLimit: () => 2,
      restartPlanner: vi.fn(), abandonTurn: vi.fn(), goUnsupervised: vi.fn(), wakeUpEnded: vi.fn(), inputsWait: () => true, dropToWatch: vi.fn(), notice: vi.fn(),
    };
  }

  it.each<[string, SupervisedRun | null]>([
    ['no run has started', null],
    ['the run is Off', { level: 'off' }],
    ['the supervisor failed in a run the user set to Off', { level: 'off', unsupervised: 'its report turn failed twice' }],
  ])('gathers nothing while %s', async (_case, run) => {
    vi.useFakeTimers();
    const h = host(run);
    const supervisor = new Supervisor(h, { debounceMs: 10 });

    expect(supervisor.observe({ kind: 'task_failed', taskId: 't1' })).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    expect(h.deliver).not.toHaveBeenCalled();
    expect(supervisor.mayWake()).toBe(false);
    vi.useRealTimers();
  });

  it('keeps what happens once the supervisor failed in the run, at once and with the inputs that wait, opening no turn (ADR-0029)', async () => {
    vi.useFakeTimers();
    const h = host({ level: 'act', unsupervised: 'it failed twice' });
    const supervisor = new Supervisor(h, { debounceMs: 10 });

    expect(supervisor.observe({ kind: 'task_failed', taskId: 't1', detail: 'broke' })).toBe(true);

    expect(h.deliver).toHaveBeenCalledWith(expect.stringMatching(/^Run update:\n- task #1 "Task t1" failed: broke/), undefined, undefined, ['t1']);
    expect(supervisor.mayWake()).toBe(false);
    expect(supervisor.wakeOwed).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  describe('reading the plan for a wave of held events (ADR-0058)', () => {
    it('reads it once for a window, however many failures land in it, and still wakes at the window', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const wakeFacts = vi.fn(h.wakeFacts);
      const supervisor = new Supervisor({ ...h, wakeFacts }, { debounceMs: 10 });

      for (let i = 1; i <= 100; i++) supervisor.observe({ kind: 'task_failed', taskId: `t${i}`, detail: 'broke' });
      await vi.advanceTimersByTimeAsync(9);
      expect(h.deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(wakeFacts).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('holds past the window what the plan does not call for, and wakes when it is due', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const wakeFacts = () => ({ nothingCanStart: false, cohortDone: new Set<string>(), blocksWork: new Set<string>(), blocksAny: new Set<string>(), ttlMs: 1000, requestAt: null });
      const supervisor = new Supervisor({ ...h, wakeFacts }, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't1', detail: 'broke' });
      await vi.advanceTimersByTimeAsync(100);
      expect(h.deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(h.deliver).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it.each<[SupervisedRun['level'], number]>([['act', 1], ['watch', 0]])('at %s, a failure other tasks depend on wakes at the window %i time(s), while the rest runs', async (level, wakes) => {
      vi.useFakeTimers();
      const h = host({ level });
      const wakeFacts = () => ({ nothingCanStart: false, cohortDone: new Set<string>(), blocksWork: new Set<string>(), blocksAny: new Set(['t1']), ttlMs: 1_000_000, requestAt: null });
      const supervisor = new Supervisor({ ...h, wakeFacts }, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't1', detail: 'broke' });
      await vi.advanceTimersByTimeAsync(9);
      expect(h.deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(h.deliver).toHaveBeenCalledTimes(wakes);
      vi.useRealTimers();
    });

    it('wakes at once past the window when an event makes the held ones due', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const cohortDone = new Set<string>();
      const wakeFacts = () => ({ nothingCanStart: false, cohortDone, blocksWork: new Set<string>(), blocksAny: new Set<string>(), ttlMs: 1_000_000, requestAt: null });
      const supervisor = new Supervisor({ ...h, wakeFacts }, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't1', detail: 'broke' });
      await vi.advanceTimersByTimeAsync(100);
      expect(h.deliver).not.toHaveBeenCalled();

      cohortDone.add('t1');
      supervisor.observe({ kind: 'task_passed', taskId: 't2' });
      await vi.advanceTimersByTimeAsync(0);

      expect(h.deliver).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('does not put off what is due at once to the plan\'s read', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const wakeFacts = vi.fn(h.wakeFacts);
      const supervisor = new Supervisor({ ...h, wakeFacts }, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't1', detail: 'broke' });
      await vi.advanceTimersByTimeAsync(5);
      supervisor.observe({ kind: 'waiting_input', taskId: 't2', detail: 'Which database?' });
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(wakeFacts).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  // Recorded: a skip in the turn on the run's end continued the run, nothing started, and the same end woke the supervisor again.
  describe('the run\'s end, told once (ADR-0029, ADR-0057 R4)', () => {
    const END = '1 of 3 tasks completed, 1 failed, 1 skipped';

    it('is not told again by an end of the run its own turn continued, when nothing happened in between', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'run_finished', detail: END });
      await vi.advanceTimersByTimeAsync(10);
      supervisor.runStarted(true);
      supervisor.observe({ kind: 'run_finished', detail: END });
      await vi.advanceTimersByTimeAsync(100);

      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(supervisor.awaitsRunEnd).toBe(false);
      vi.useRealTimers();
    });

    it('is told again once anything happened since: a retried task failing again is a new end', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'run_finished', detail: END });
      await vi.advanceTimersByTimeAsync(10);
      supervisor.runStarted(true);
      supervisor.observe({ kind: 'task_failed', taskId: 't2', detail: 'still wrong' });
      supervisor.observe({ kind: 'run_finished', detail: END });
      await vi.advanceTimersByTimeAsync(100);

      expect(h.deliver).toHaveBeenCalledTimes(2);
      expect(h.deliver.mock.calls[1][0]).toContain('the run finished');
      vi.useRealTimers();
    });

    it('is told again to a run the user started, which has its own end', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'run_finished', detail: END });
      await vi.advanceTimersByTimeAsync(10);
      supervisor.runStarted(false);
      supervisor.observe({ kind: 'run_finished', detail: END });
      await vi.advanceTimersByTimeAsync(100);

      expect(h.deliver).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe('a report the planner asked for (ADR-0037)', () => {
    const report = (authority: 'user' | 'supervisor', taskId = 't1'): RunEventInput => ({ kind: 'task_report', taskId, report: { authority, text: 'It passed.\nIt printed nothing.', passed: true } });

    it('is gathered and delivered at Off, with whose authority, its result whole', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'off' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe(report('user'));
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver).toHaveBeenCalledWith('Run update:\n- task #1 "Task t1", whose result you asked for, has ended. It passed.\n  It printed nothing.', 'user', undefined, ['t1']);
      expect(supervisor.mayWake()).toBe(false);
      expect(supervisor.mayReport()).toBe(true);
      vi.useRealTimers();
    });

    it('goes to a turn of its own when owed to the user\'s turn, apart from the supervisor\'s events in its window', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't2', detail: 'broke' });
      supervisor.observe(report('user'));
      supervisor.observe(report('supervisor', 't3'));
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([
        [expect.stringMatching(/^Run update:\n- task #2 "Task t2" failed: broke\n- task #3 "Task t3", whose result you asked for/), 'supervisor'],
        [expect.stringMatching(/^Run update:\n- task #1 "Task t1", whose result you asked for/), 'user'],
      ]);
      vi.useRealTimers();
    });

    it('carries the run\'s end its task caused in its own turn, when that end is all the supervisor has to say', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_passed', taskId: 't2' });
      supervisor.observe(report('user'));
      supervisor.observe({ kind: 'run_finished', detail: '4 of 4 tasks completed' });
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[[
        'Run update:',
        '- task #1 "Task t1", whose result you asked for, has ended. It passed.',
        '  It printed nothing.',
        '- the run finished: 4 of 4 tasks completed',
        'Since the last update:',
        '- task #2 "Task t2" passed',
      ].join('\n'), 'user']]);
      expect(supervisor.awaitsRunEnd).toBe(false);
      expect(h.wakeUpEnded).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('leaves the run\'s end with the supervisor\'s other events, in their turn', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe(report('user'));
      supervisor.observe({ kind: 'task_failed', taskId: 't2', detail: 'broke' });
      supervisor.observe({ kind: 'run_finished', detail: '1 of 2 tasks completed, 1 failed' });
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([
        ['Run update:\n- task #2 "Task t2" failed: broke\n- the run finished: 1 of 2 tasks completed, 1 failed', undefined],
        [expect.stringMatching(/^Run update:\n- task #1 "Task t1", whose result you asked for[^]*It printed nothing\.$/), 'user'],
      ]);
      vi.useRealTimers();
    });

    it('outlives a new run the user starts, which drops the supervisor\'s own undelivered events', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'watch' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't2' });
      supervisor.observe(report('user'));
      supervisor.runStarted();
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[expect.not.stringContaining('failed'), 'user']]);
      vi.useRealTimers();
    });

    it('is delivered once due after a restart that restored it, opening a turn of its own while the supervisor\'s events go idle', async () => {
      vi.useFakeTimers();
      const before = new Supervisor(host({ level: 'watch' }), { debounceMs: 10 });
      before.observe({ kind: 'task_failed', taskId: 't2' });
      before.observe(report('user'));
      const saved = before.snapshot();
      before.reset();
      const h = host({ level: 'watch' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.restore(saved);
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([
        [expect.stringMatching(/task #2 "Task t2" failed/), undefined, true],
        [expect.stringMatching(/^Run update:\n- task #1 "Task t1", whose result you asked for/), 'user'],
      ]);
      expect(supervisor.snapshot().policy.attention).toEqual([]);
      vi.useRealTimers();
    });

    it('takes a restored failure into the turn a restored report of the supervisor\'s opens', async () => {
      vi.useFakeTimers();
      const before = new Supervisor(host({ level: 'act' }), { debounceMs: 10 });
      before.observe({ kind: 'task_failed', taskId: 't2' });
      before.observe(report('supervisor', 't3'));
      const saved = before.snapshot();
      before.reset();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.restore(saved);
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[expect.stringMatching(/failed\n- task #3 "Task t3", whose result you asked for/), 'supervisor']]);
      vi.useRealTimers();
    });

    it('calls a failed report turn of the user\'s a report turn, in the retry and in the give-up', async () => {
      const h = host({ level: 'off' });
      const supervisor = new Supervisor(h);
      const fail = () => supervisor.turn(async () => { throw new Error('planner exited'); }, undefined, 'user');

      await expect(fail()).rejects.toThrow('planner exited');
      expect(h.notice).toHaveBeenCalledWith('warn', 'The planner\'s report turn failed (planner exited). Retrying once with the planner restarted.');
      await expect(fail()).rejects.toThrow('planner exited');
      expect(h.goUnsupervised).toHaveBeenCalledWith('the planner\'s report turn failed twice (planner exited)');
    });

    it('opens no turn once the turns opened without the user have failed for the run', () => {
      expect(new Supervisor(host({ level: 'off', unsupervised: 'its wake-up turn failed twice' })).mayReport()).toBe(false);
    });

    it('acts for the user\'s turn in a report turn of theirs, and refuses it nothing that turn could do', () => {
      const turn = new Supervisor(host({ level: 'watch' })).wakeUpTurn('user');

      expect(turn.actor?.()).toEqual({ kind: 'planner-turn' });
      expect(turn.refused('edit')).toBeUndefined();
      expect(turn.refused('plan')).toBeUndefined();
      expect(turn.brief?.whole).toContain('You act as in that turn');
    });

    it('acts at the run\'s level now for the supervisor, read at each call', () => {
      const run: SupervisedRun = { level: 'act' };
      const turn = new Supervisor({ ...host(null), run: () => run }).wakeUpTurn();
      run.level = 'watch';

      expect(turn.actor?.()).toEqual({ kind: 'supervisor', level: 'watch' });
    });
  });

  describe('what a restart restored, with no report among it', () => {
    const restored = (run: SupervisedRun = { level: 'act' }) => {
      const before = new Supervisor(host({ level: 'watch' }), { debounceMs: 10 });
      before.observe({ kind: 'task_failed', taskId: 't1' });
      const saved = before.snapshot();
      before.reset();
      const h = host(run);
      const supervisor = new Supervisor(h, { debounceMs: 10 });
      supervisor.restore(saved);
      return { h, supervisor };
    };

    it('goes out idle once due and leaves the policy: a session opening is not a run event', async () => {
      vi.useFakeTimers();
      const { h, supervisor } = restored();

      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[expect.stringContaining('task #1 "Task t1" failed'), undefined, true]]);
      expect(supervisor.snapshot().policy.attention).toEqual([]);
      expect(h.wakeUpEnded).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('wakes nobody for a running-long flag it restored, and keeps it for the next wake', async () => {
      vi.useFakeTimers();
      const before = new Supervisor(host({ level: 'act' }), { debounceMs: 10 });
      before.observe({ kind: 'running_long', taskId: 't1', runningLong: { reason: 'duration', elapsedMs: 1_800_000, thresholdMs: 1_800_000, compactions: 0, attempt: 1 } });
      const saved = before.snapshot();
      before.reset();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });
      supervisor.restore(saved);

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(delivered(h)).toEqual([[expect.stringContaining('task #1 "Task t1" has run long'), undefined, true]]);
      expect(supervisor.snapshot().wakeUps).toEqual([]);
      vi.useRealTimers();
    });

    it('does not count as a wake-up', async () => {
      vi.useFakeTimers();
      const { supervisor } = restored();

      await vi.advanceTimersByTimeAsync(10);

      expect(supervisor.snapshot().wakeUps).toEqual([]);
      vi.useRealTimers();
    });

    it('wakes the supervisor with a run event that joins it', async () => {
      vi.useFakeTimers();
      const { h, supervisor } = restored();

      supervisor.observe({ kind: 'waiting_input', taskId: 't3' });
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[expect.stringMatching(/failed\n- task #3 "Task t3" is waiting for input$/), undefined]]);
      vi.useRealTimers();
    });

    it('wakes the supervisor once a run carries on past it', async () => {
      vi.useFakeTimers();
      const { h, supervisor } = restored();

      supervisor.runStarted(true);
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[expect.stringContaining('failed'), undefined]]);
      vi.useRealTimers();
    });

    it('goes out idle with a pass beside it: a pass wakes nobody', async () => {
      vi.useFakeTimers();
      const { h, supervisor } = restored();

      supervisor.observe({ kind: 'task_passed', taskId: 't2' });
      await vi.advanceTimersByTimeAsync(10);

      expect(delivered(h)).toEqual([[expect.stringContaining('failed'), undefined, true]]);
      vi.useRealTimers();
    });
  });

  it('tells a wake-up turn at Watch its read budget, and refuses every change to the plan', () => {
    const turn = new Supervisor(host({ level: 'watch' })).wakeUpTurn();

    expect(turn.readBudget).toBe(12);
    expect(turn.refused('edit')).toMatch(/^Plan edits are refused in a wake-up turn: you are the supervisor at Watch/);
    expect(turn.refused('plan')).toMatch(/^Plan edits are refused in a wake-up turn/);
    expect(turn.brief?.whole).toMatch(/up to 12 reads this turn/);
    expect(turn.brief?.whole).toMatch(/At Watch you only suggest/);
  });

  it('lets a wake-up turn at Act edit the plan, but not replace it, and tells it its guards', () => {
    const turn = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn();

    expect(turn.refused('edit')).toBeUndefined();
    expect(turn.refused('plan')).toMatch(/^A whole new plan is refused in a wake-up turn: .*edit_plan/);
    expect(turn.brief?.whole).toMatch(/At Act you may act/);
    expect(turn.brief?.whole).toMatch(/up to 3 times/);
  });

  it('tells a wake-up turn at Act to narrow a task that failed part-way to what works, rather than retry the same goal (ADR-0029)', () => {
    const whole = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn().brief?.whole ?? '';

    expect(whole).toMatch(/report shows part of its brief working and committed, with evidence that the rest cannot be done from what the workspace holds, do not retry the same goal/);
    expect(whole).toMatch(/edit_plan it so its done criterion is what works, then retry it/);
    expect(whole).not.toMatch(/name the rest as a follow-up task or in the task that checks the whole/);
    expect(whole).toMatch(/Never give a retry a done criterion its own limits cannot meet/);
    expect(whole).toMatch(/nor call the rest solvable without evidence from the report/);
    expect(whole).toMatch(/The verdict is still its runner's task_complete, and nothing lands without a pass/);
  });

  // A cheaper model that gave up within minutes was retried unchanged, chain after chain.
  it('tells a wake-up turn at Act to move a task that gave up fast on a cheaper model to a stronger one or split it', () => {
    const whole = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn().brief?.whole ?? '';

    expect(whole).toContain(RETRY_ESCALATION);
    expect(RETRY_ESCALATION).toBe('When a task fails within minutes, or hands off incomplete, on a cheaper model, retry it on a stronger model or split it, rather than retrying it unchanged.');
    expect(whole.indexOf(RETRY_ESCALATION)).toBeGreaterThan(whole.indexOf('Loop guards hold you'));
  });

  it('tells a wake-up turn at Act that a remainder shown undoable is a known gap with no task, and adds none for it once the run has ended (ADR-0029)', () => {
    const whole = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn().brief?.whole ?? '';

    expect(whole).toMatch(/A rest the report shows cannot be done gets no task: record it as a known gap in the brief of the task that checks the whole and in your message to the user/);
    expect(whole).toMatch(/A follow-up task is only for a rest that can be done, and gets only that scope/);
    expect(whole).toMatch(/Once the run's last task has ended, add no task for a rest shown undoable unless new evidence makes it reachable/);
  });

  it('tells a wake-up turn at Act that it answers checkpoints, and leaves the ones that need the user\'s judgement to them', () => {
    const turn = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn();

    expect(turn.brief?.whole).toMatch(/answer_checkpoint/);
    expect(turn.brief?.whole).toMatch(/irreversible or outward effect.*escalate it to the user rather than approving it/);
    expect(turn.brief?.whole).toMatch(/When you reject, give the reason/);
  });

  it('does not offer the checkpoint tool to a wake-up turn at Watch, which only suggests', () => {
    const turn = new Supervisor({ ...host({ level: 'watch' }), retryLimit: () => 3 }).wakeUpTurn();

    expect(turn.brief?.whole).not.toMatch(/answer_checkpoint/);
  });

  it('applies a level lowered during the turn at once', () => {
    let run: SupervisedRun = { level: 'act' };
    const turn = new Supervisor({ ...host(null), run: () => run }).wakeUpTurn();
    expect(turn.refused('edit')).toBeUndefined();

    run = { level: 'watch' };
    expect(turn.refused('edit')).toMatch(/you are the supervisor at Watch/);
    run = { level: 'off' };
    expect(turn.refused('edit')).toMatch(/^Plan edits are refused: the supervisor was turned off for this run/);
    run = { level: 'act', unsupervised: 'it failed twice' };
    expect(turn.refused('edit')).toMatch(/turned off for this run/);
  });

  describe('the user\'s Stop (ADR-0029)', () => {
    const report = { kind: 'task_report', taskId: 't1', report: { authority: 'user', text: 'done', passed: true } } as const;

    it('acts at Off and opens nothing, whatever the run\'s level', () => {
      const supervisor = new Supervisor(host({ level: 'act' }));

      supervisor.userStopped();

      expect(supervisor.level).toBe('off');
      expect(supervisor.mayWake()).toBe(false);
      expect(supervisor.mayReport()).toBe(false);
      supervisor.userStarted();
      expect(supervisor.level).toBe('act');
      expect(supervisor.mayReport()).toBe(true);
    });

    it('hands what it held to the waiting inputs, and what comes after, with the wake-up rate untouched', () => {
      const h = host({ level: 'act' });
      const wakeUps: number[] = [];
      const supervisor = new Supervisor({ ...h, dropToWatch: () => wakeUps.push(1) }, { wakeUpRate: { max: 0, windowMs: 60_000 } });

      supervisor.observe({ kind: 'task_failed', taskId: 't1' });
      supervisor.userStopped();
      supervisor.observe({ kind: 'waiting_input', taskId: 't2' });
      supervisor.observe(report);
      supervisor.observe({ kind: 'run_finished', detail: '1 of 2 tasks completed' });

      expect(delivered(h).map(([digest]) => digest)).toEqual([
        expect.stringContaining('failed'),
        expect.stringContaining('waiting for input'),
        expect.stringContaining('done'),
        expect.stringContaining('the run finished'),
      ]);
      expect(supervisor.awaitsRunEnd).toBe(false);
      expect(wakeUps).toEqual([]);
    });

    it('stands through a save', () => {
      const stopped = new Supervisor(host({ level: 'act' }));
      stopped.userStopped();
      const reloaded = new Supervisor(host({ level: 'act' }));

      reloaded.restore(stopped.snapshot());

      expect(reloaded.level).toBe('off');
      expect(reloaded.mayReport()).toBe(false);
    });

    it('takes a report turn\'s authority away at once, so it cannot start again what was stopped', () => {
      const supervisor = new Supervisor(host({ level: 'off' }));
      const turn = supervisor.wakeUpTurn('user');
      expect(turn.actor?.()).toEqual({ kind: 'planner-turn' });
      expect(turn.refused('edit')).toBeUndefined();

      supervisor.userStopped();

      expect(turn.actor?.()).toEqual({ kind: 'supervisor', level: 'off' });
      expect(turn.refused('edit')).toMatch(/^Plan edits are refused/);
    });

    it('counts no wake-up for an update about tasks the user stopped alone', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const dropToWatch = vi.fn();
      const supervisor = new Supervisor({ ...h, dropToWatch, stoppedByUser: () => true }, { wakeUpRate: { max: 0, windowMs: 60_000 } });

      supervisor.observe({ kind: 'waiting_input', taskId: 't1' });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(h.deliver).toHaveBeenCalledWith(expect.any(String), undefined, undefined, ['t1']);
      expect(dropToWatch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('names no tasks for an update about the run', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h);

      supervisor.observe({ kind: 'waiting_input', taskId: 't1' });
      supervisor.observe({ kind: 'run_finished', detail: 'over' });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(h.deliver).toHaveBeenCalledWith(expect.any(String), undefined, undefined, undefined);
      vi.useRealTimers();
    });
  });

  describe('the wake-up rate guard', () => {
    const rate = { max: 2, windowMs: 60_000 };

    async function wakes(supervisor: Supervisor, events: RunEventInput[]): Promise<void> {
      for (const event of events) {
        supervisor.observe(event);
        await vi.advanceTimersByTimeAsync(20);
      }
    }
    const input = (taskId: string): RunEventInput => ({ kind: 'waiting_input', taskId });

    it('drops an Act supervisor to Watch on the wake-up past the rate, before it is delivered', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const order: string[] = [];
      h.deliver.mockImplementation(async () => { order.push('deliver'); });
      h.dropToWatch.mockImplementation(() => { order.push('drop'); });
      const supervisor = new Supervisor(h, { debounceMs: 10, wakeUpRate: rate });

      await wakes(supervisor, [input('t1'), input('t2'), input('t3')]);

      expect(order).toEqual(['deliver', 'deliver', 'drop', 'deliver']);
      expect(h.dropToWatch).toHaveBeenCalledWith('woke 3 times in 1 minute with no task passing in between');
      vi.useRealTimers();
    });

    it('starts counting again after a pass, and ignores wake-ups outside the window', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10, wakeUpRate: rate });

      await wakes(supervisor, [input('t1'), input('t2'), { kind: 'task_passed', taskId: 't9' }, input('t3')]);
      await vi.advanceTimersByTimeAsync(rate.windowMs);
      await wakes(supervisor, [input('t4'), input('t5')]);

      expect(h.deliver).toHaveBeenCalledTimes(5);
      expect(h.dropToWatch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('leaves a Watch supervisor be: it has nothing to lower', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'watch' });
      const supervisor = new Supervisor(h, { debounceMs: 10, wakeUpRate: rate });

      await wakes(supervisor, [input('t1'), input('t2'), input('t3'), input('t4')]);

      expect(h.dropToWatch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
