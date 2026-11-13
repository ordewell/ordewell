import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { PlanStore } from '../PlanStore';
import { LimitPauses, RELAPSE_MS, type LimitedAttempt, type LimitPausesHost, type LimitWait, type ResumeNow } from '../LimitPauses';
import { heldFrom, nextRunState, type RunState } from '../runState';
import type { TurnFailure } from '../runnerExit';

// Claude Code's wording (#84), in UTC so the expected times do not depend on the machine's.
const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const LATER_LIMIT = "You've hit your session limit · resets 9:30pm (UTC)";
const NOW = new Date('2026-10-11T17:00:00Z');
const RESUME_AT = '2026-10-11T20:11:00.000Z';
const LATER_RESUME_AT = '2026-10-11T21:31:00.000Z';

function setup(opts: { run?: 'idle' | 'scheduling'; tasks?: Task[] } = {}) {
  const store = new PlanStore();
  store.load(opts.tasks ?? [
    createTask({ id: 't1', order: 1, title: 'One', prompt: 'p' }),
    createTask({ id: 't2', order: 2, title: 'Two', prompt: 'p' }),
  ], ['claude-code', 'codex']);
  for (const task of store.allTasks) store.markInProgress(task.id);
  // The orchestrator's own reducer, so the pause holds and releases the run as it does there.
  let state: RunState = { kind: opts.run ?? 'scheduling' };
  const steps: string[] = [];
  const waits: LimitWait[] = [];
  const told: { level: string; message: string }[] = [];
  const resumes: { taskId: string; now?: ResumeNow }[] = [];
  /** Tasks whose resume finds no slot: they stay paused. */
  const unstartable = new Set<string>();
  const host: LimitPausesHost = {
    store,
    run: {
      hold: () => { state = nextRunState(state, { type: 'hold' }); },
      heldFrom: () => heldFrom(state),
      release: () => { state = nextRunState(state, { type: 'release' }); },
    },
    tell: (level, message) => told.push({ level, message }),
    waitChanged: (wait) => waits.push(wait),
    changed: () => undefined,
    unawaited: (work) => { void work; },
    leaveWorktree: async (taskId) => { steps.push(`keep ${taskId}`); },
    settled: async (taskId) => { steps.push(`settled ${taskId}`); },
    resume: async (taskId, now) => {
      resumes.push({ taskId, ...(now ? { now } : {}) });
      if (unstartable.has(taskId)) return;
      store.retry(taskId, { sameRound: true });
      store.markInProgress(taskId);
    },
  };
  const pauses = new LimitPauses(host);
  return { store, pauses, steps, waits, told, resumes, unstartable, run: () => state.kind, task: (id: string): Readonly<Task> => store.get(id)! };
}

function attempt(overrides: Partial<LimitedAttempt> = {}): LimitedAttempt {
  return { runner: 'claude-code', kind: { kind: 'change' }, worktree: true, autoResumed: false, startedAt: NOW.toISOString(), ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LimitPauses: the three ways a limit arrives are one pause', () => {
  // What each entry path hands over: an exit mid-turn passes the turn's words
  // (or its error, when the runner named the cause in a field), a failed turn
  // its error, and a refused start the refusal, with nothing printed.
  const paths: [string, string | TurnFailure, string, string][] = [
    ['an exit mid-turn, from its words', `working…\n${LIMIT}\n`, 'working…', 'claude-code hit its usage limit'],
    ['an exit mid-turn, from its error field', { message: LIMIT, usageLimit: { resetsAt: '2026-10-11T20:10:00Z' } }, 'working…', LIMIT],
    ['a turn that failed on it', { message: LIMIT }, 'working…', LIMIT],
    ['a start it refused', { message: LIMIT }, '', LIMIT],
  ];

  it.each(paths)('%s: the task waits on the user, with no verdict and nothing archived, and the run holds', async (_, said, output, reason) => {
    const { pauses, store, steps, waits, told, run, task } = setup();

    await pauses.pause('t1', attempt(), said, output);

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(task('t1').verdict).toBeUndefined();
    expect(store.getExecutionLog()).toEqual([]);
    expect(task('t1').outputSummary).toMatchObject({ reviewReason: reason, logTail: output });
    expect(run()).toBe('held');
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: RESUME_AT }]);
    expect(told).toEqual([{ level: 'info', message: expect.stringContaining('resumes on its own at') }]);
    expect(steps).toEqual(['keep t1', 'settled t1']);
  });

  it("leaves a delegated task's report through its repair's pause, and clears any other's", async () => {
    const { pauses, store, task } = setup();
    const repair = { kind: 'repair', repair: { n: 1, limit: 2 } } as const;
    const report = { summary: 'The report.', findings: [], findingCount: 0 };
    const paused = store.get('t1') as Task;
    paused.type = 'delegated';
    paused.handoff = report;
    await pauses.pause('t1', attempt({ kind: repair }), { message: LIMIT }, '');
    expect(task('t1').handoff).toEqual(report);
    paused.type = 'ai';
    await pauses.pause('t1', attempt({ kind: repair }), { message: LIMIT }, '');
    expect(task('t1').handoff).toBeUndefined();
  });

  it('keeps no worktree for an attempt that had none, and still settles', async () => {
    const { pauses, steps, told } = setup();

    await pauses.pause('t1', attempt({ worktree: false }), { message: LIMIT }, '');

    expect(steps).toEqual(['settled t1']);
    expect(told[0].message).not.toContain('worktree');
  });
});

describe('LimitPauses: waiting for the reset', () => {
  it('waits for the user, holding nothing, when the reset cannot be read', async () => {
    const { pauses, waits, told, run, task, resumes } = setup();

    await pauses.pause('t1', attempt(), { message: 'Usage limit reached.' }, '');

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    expect(run()).toBe('scheduling');
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: null }]);
    expect(told[0]).toMatchObject({ level: 'warn' });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resumes).toEqual([]);
  });

  it('does not resume on its own again an attempt it resumed a moment ago', async () => {
    const { pauses, run, task, told } = setup();
    vi.setSystemTime(NOW.getTime() + RELAPSE_MS - 1);

    await pauses.pause('t1', attempt({ autoResumed: true }), { message: LIMIT }, '');

    expect(task('t1').resumeAt).toBeUndefined();
    expect(run()).toBe('scheduling');
    expect(told[0].message).toContain('again right after it was resumed');
  });

  it('resumes the tasks one runner paused together, at the latest of their resets', async () => {
    const { pauses, task, resumes, told } = setup();
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');
    await pauses.pause('t2', attempt(), { message: LATER_LIMIT }, '');

    expect(task('t1').resumeAt).toBe(LATER_RESUME_AT);
    expect(task('t2').resumeAt).toBe(LATER_RESUME_AT);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - NOW.getTime());
    expect(resumes).toEqual([]);
    await vi.advanceTimersByTimeAsync(Date.parse(LATER_RESUME_AT) - Date.parse(RESUME_AT));
    expect(resumes.map((r) => r.taskId)).toEqual(['t1', 't2']);
    expect(told.at(-1)?.message).toBe('The usage limit of claude-code has reset: resuming "One" and "Two".');
  });

  it('starts the scheduler\'s run again once the last task resumes, and lets a task started alone go on alone', async () => {
    const scheduled = setup();
    await scheduled.pauses.pause('t1', attempt(), { message: LIMIT }, '');
    scheduled.store.retry('t1', { sameRound: true });
    expect(scheduled.pauses.resumed()).toBe(true);
    // Left held: the run the caller starts again replaces the hold.
    expect(scheduled.run()).toBe('held');

    const alone = setup({ run: 'idle' });
    await alone.pauses.pause('t1', attempt(), { message: LIMIT }, '');
    alone.store.retry('t1', { sameRound: true });
    expect(alone.pauses.resumed()).toBe(false);
    expect(alone.run()).toBe('idle');
  });

  it('keeps holding the run while another task still waits on a reset', async () => {
    const { pauses, store, run } = setup({ tasks: [
      createTask({ id: 't1', order: 1, title: 'One', prompt: 'p' }),
      createTask({ id: 't2', order: 2, title: 'Two', prompt: 'p', assignedRunner: 'codex' }),
    ] });
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');
    await pauses.pause('t2', attempt({ runner: 'codex' }), { message: LIMIT, usageLimit: { resetsAt: '2026-10-11T22:00:00Z' } }, '');

    store.retry('t1', { sameRound: true });
    expect(pauses.resumed()).toBe(false);
    expect(run()).toBe('held');
  });
});

describe('LimitPauses: ending a wait early', () => {
  it('cancel: the task waits for a retry, its runner\'s wait goes, and the hold with it', async () => {
    const { pauses, waits, run, task, resumes } = setup();
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');

    expect(pauses.cancel('t1')).toBe(true);

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    expect(waits.at(-1)).toEqual({ taskId: 't1', runner: 'claude-code', resumeAt: null, cancelled: true });
    expect(run()).toBe('scheduling');
    expect(pauses.cancel('t1')).toBe(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resumes).toEqual([]);
  });

  it('cancelAll: a stopped run starts nothing at the reset', async () => {
    const { pauses, run, resumes } = setup();
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');
    await pauses.pause('t2', attempt(), { message: LIMIT }, '');

    pauses.cancelAll();

    expect(run()).toBe('scheduling');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resumes).toEqual([]);
  });

  it('recount: a task that left the plan releases the hold and its runner\'s wait', async () => {
    const { pauses, store, run, resumes } = setup();
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');

    store.load([createTask({ id: 't2', order: 1, title: 'Two', prompt: 'p' })], ['claude-code']);
    pauses.recount();

    expect(run()).toBe('scheduling');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resumes).toEqual([]);
  });

  it('moved: a run the scheduler drove goes on, though another task still waits', async () => {
    const { pauses, run, task } = setup();
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');
    await pauses.pause('t2', attempt(), { message: LIMIT }, '');

    expect(pauses.moved('t1')).toBe('scheduling');

    expect(run()).toBe('scheduling');
    expect(task('t2').resumeAt).toBe(RESUME_AT);
  });

  it('moved: a task started alone is left to its caller, and a run held for another stays held', async () => {
    const { pauses, run } = setup({ run: 'idle' });
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');
    await pauses.pause('t2', attempt(), { message: LIMIT }, '');

    expect(pauses.moved('t1')).toBe('idle');
    expect(run()).toBe('held');
  });

  it('resumeNow: the asked task first, every task on its runner swept along, and one that did not resume waits again', async () => {
    const { pauses, unstartable, task, resumes } = setup();
    await pauses.pause('t1', attempt(), { message: LIMIT }, '');
    await pauses.pause('t2', attempt(), { message: LIMIT }, '');

    unstartable.add('t1');
    await pauses.resumeNow({ taskId: 't2', origin: 'user', message: 'go on' });

    expect(resumes.map((r) => [r.taskId, r.now?.taskId])).toEqual([['t2', 't2'], ['t1', 't2']]);
    expect(task('t1').resumeAt).toBe(RESUME_AT);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - NOW.getTime());
    expect(resumes.map((r) => r.taskId)).toEqual(['t2', 't1', 't1']);
  });
});

describe('LimitPauses: a loaded plan', () => {
  it('rearms the waits it still owes, resuming at once one whose time passed while nothing ran', async () => {
    const { pauses, store, resumes, task } = setup();
    store.markAwaitingUser('t1', 'usage-limit');
    store.setTaskResumeAt('t1', new Date(NOW.getTime() - 60_000).toISOString());
    store.markAwaitingUser('t2', 'usage-limit');
    store.setTaskResumeAt('t2', 'not a time');

    pauses.rearm();

    expect(task('t2').resumeAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(resumes.map((r) => r.taskId)).toEqual(['t1']);
  });
});
