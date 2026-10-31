import { describe, it, expect } from 'vitest';
import { createWakePolicy, planWakeFacts, UNKNOWN_CACHE_TTL_MS, wakeDue, type RunEvent, type WakeFacts } from '../WakePolicy';
import { createTask, type Task } from '../../models/Task';
import type { StartWait } from '../readiness';

const DEBOUNCE = 1000;

/** The plan has nothing left to wait for: what is held goes at the window, as all of it once did. */
const DUE: WakeFacts = { nothingCanStart: true, cohortDone: new Set(), blocksWork: new Set(), requestAt: null };
const QUIET: WakeFacts = { ...DUE, nothingCanStart: false };

function event(kind: RunEvent['kind'], at: number, taskId?: string): RunEvent {
  return { kind, at, taskId };
}

describe('createWakePolicy', () => {
  it('never wakes for passes alone, however long it waits', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_passed', 10, 't2'));

    expect(policy.poll(1_000_000)).toBeNull();
  });

  it.each(['task_failed', 'waiting_input', 'waiting_approval', 'task_idle', 'landing_conflict', 'auto_merge_stopped'] as const)(
    'wakes for %s',
    (kind) => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event(kind, 0, 't1'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([event(kind, 0, 't1')]);
    },
  );

  describe('debounce window', () => {
    it('merges attention events inside the window into one wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('waiting_input', 300, 't2'));
      policy.push(event('landing_conflict', 900, 't3'));

      expect(policy.poll(300 + DEBOUNCE - 1)).toBeNull();
      expect(policy.poll(300 + DEBOUNCE)?.attention).toEqual([
        event('task_failed', 0, 't1'),
        event('waiting_input', 300, 't2'),
        event('landing_conflict', 900, 't3'),
      ]);
    });

    it('wakes once the window has fully elapsed, and a pass does not open it', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('task_failed', 400, 't2'));

      expect(policy.poll(400 + DEBOUNCE - 1)).toBeNull();
      expect(policy.poll(400 + DEBOUNCE)).not.toBeNull();
    });

    it('runs the window from the first attention event, so a steady stream cannot hold the wake-up off', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('task_failed', 600, 't2'));

      expect(policy.poll(DEBOUNCE)?.attention).toHaveLength(2);
    });
  });

  describe('run_finished', () => {
    it('flushes without waiting for the window', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('task_passed', 10, 't2'));
      policy.push(event('run_finished', 20));

      expect(policy.poll(20)).toEqual({
        attention: [event('task_failed', 0, 't1'), event('run_finished', 20)],
        sinceLast: [event('task_passed', 10, 't2')],
      });
    });

    it('reports the run\'s end once however often it is announced', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('run_finished', 20));
      policy.push(event('run_finished', 21));

      expect(policy.poll(21)?.attention).toEqual([event('run_finished', 20)]);
    });

    it('wakes on its own with the passes, and leaves the policy open for a retry', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('run_finished', 20));

      expect(policy.poll(20)).toEqual({
        attention: [event('run_finished', 20)],
        sinceLast: [event('task_passed', 0, 't1')],
      });

      policy.push(event('waiting_input', 5000, 't1'));
      expect(policy.poll(5000 + DEBOUNCE)?.attention).toEqual([event('waiting_input', 5000, 't1')]);
    });
  });

  describe('idle de-duplication', () => {
    it('reports a task that goes idle twice in one window once, at its first place and stamp', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_idle', 0, 't1'));
      policy.push(event('task_failed', 100, 't2'));
      policy.push(event('task_idle', 200, 't1'));
      policy.push(event('task_idle', 300, 't3'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        event('task_idle', 0, 't1'),
        event('task_failed', 100, 't2'),
        event('task_idle', 300, 't3'),
      ]);
    });

    it('reports the same task idle again after a wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_idle', 0, 't1'));
      policy.poll(DEBOUNCE);

      policy.push(event('task_idle', 2000, 't1'));
      expect(policy.poll(2000 + DEBOUNCE)?.attention).toEqual([event('task_idle', 2000, 't1')]);
    });

    it('collapses only silence: two waiting_input events from one task both reach the supervisor', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push({ kind: 'waiting_input', taskId: 't1', at: 0, detail: 'Which database?' });
      policy.push({ kind: 'waiting_input', taskId: 't1', at: 300, detail: 'Overwrite the migration?' });

      expect(policy.poll(DEBOUNCE)?.attention.map((e) => e.detail)).toEqual([
        'Which database?',
        'Overwrite the migration?',
      ]);
    });

    it('keeps an idle report even when the task passes before the wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_idle', 0, 't1'));
      policy.push(event('task_passed', 500, 't1'));

      expect(policy.poll(DEBOUNCE)).toEqual({
        attention: [event('task_idle', 0, 't1')],
        sinceLast: [event('task_passed', 500, 't1')],
      });
    });
  });

  it('clears the batch on a wake-up, so each pass is reported once', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_failed', 10, 't2'));
    expect(policy.poll(10 + DEBOUNCE)?.sinceLast).toEqual([event('task_passed', 0, 't1')]);
    expect(policy.poll(10 + DEBOUNCE)).toBeNull();

    policy.push(event('task_failed', 2000, 't3'));
    expect(policy.poll(2000 + DEBOUNCE)?.sinceLast).toEqual([]);
  });

  describe('usage limits', () => {
    const limit = (at: number, taskId: string, runner: string, resumeAt: string | null): RunEvent =>
      ({ kind: 'usage_limit', taskId, at, runner, resumeAt });

    it('wakes for a task paused on its runner\'s limit, with the runner and the resume time', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(limit(0, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        { kind: 'usage_limit', taskId: 't1', taskIds: ['t1'], at: 0, runner: 'claude-code', resumeAt: '2026-10-11T20:10:00.000Z' },
      ]);
    });

    it('coalesces every task one runner\'s limit pauses into one entry, at the first one\'s place', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(limit(0, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));
      policy.push(event('task_failed', 100, 't9'));
      policy.push(limit(200, 't2', 'claude-code', '2026-10-11T20:10:00.000Z'));
      policy.push(limit(300, 't3', 'codex', null));
      policy.push(limit(400, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        { kind: 'usage_limit', taskId: 't1', taskIds: ['t1', 't2'], at: 0, runner: 'claude-code', resumeAt: '2026-10-11T20:10:00.000Z' },
        event('task_failed', 100, 't9'),
        { kind: 'usage_limit', taskId: 't3', taskIds: ['t3'], at: 300, runner: 'codex', resumeAt: null },
      ]);
    });

    it('keeps a known resume time when a later pause on the same limit could not read one', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(limit(0, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));
      policy.push(limit(10, 't2', 'claude-code', null));

      expect(policy.poll(DEBOUNCE)?.attention[0]).toMatchObject({ taskIds: ['t1', 't2'], resumeAt: '2026-10-11T20:10:00.000Z' });
    });
  });

  describe('dueAt', () => {
    it('is null while only passes wait, the window\'s end once attention waits, and at once after run_finished', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_passed', 0, 't1'));
      expect(policy.dueAt()).toBeNull();

      policy.push(event('task_failed', 50, 't2'));
      policy.push(event('waiting_input', 70, 't3'));
      expect(policy.dueAt()).toBe(70 + DEBOUNCE);

      policy.push(event('run_finished', 90));
      expect(policy.dueAt()).toBe(50);
      policy.poll(90);
      expect(policy.dueAt()).toBeNull();
    });
  });

  describe('a snapshot across a restart', () => {
    it('keeps the events inside the window and the passes, so the batch is delivered after a reload', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('waiting_input', 400, 't2'));
      policy.push(event('task_failed', 500, 't3'));

      const restarted = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      restarted.restore(policy.snapshot());

      expect(restarted.dueAt()).toBe(400 + DEBOUNCE);
      expect(restarted.poll(400 + DEBOUNCE)).toEqual({
        attention: [event('waiting_input', 400, 't2'), event('task_failed', 500, 't3')],
        sinceLast: [event('task_passed', 0, 't1')],
      });
    });

    it('restores nothing from a plan saved before the snapshot existed', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => DUE });
      policy.push(event('task_failed', 0, 't1'));

      policy.restore(undefined);

      expect(policy.dueAt()).toBeNull();
      expect(policy.poll(DEBOUNCE)).toBeNull();
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a debounce of %s', (debounceMs) => {
    expect(() => createWakePolicy({ debounceMs, facts: () => DUE })).toThrow(RangeError);
  });

  describe('a pass (ADR-0057 R4)', () => {
    it('starts no clock, and flushes nothing held, whatever the plan says', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => QUIET });
      policy.push(event('task_passed', 0, 't1'));
      expect(policy.dueAt()).toBeNull();

      policy.push(event('task_idle', 100, 't2'));
      const due = policy.dueAt();
      policy.push(event('task_passed', 200, 't3'));
      expect(policy.dueAt()).toBe(due);
    });
  });
});

describe('wakeDue (ADR-0057 R4)', () => {
  const TTL = 60 * 60_000;
  const facts = (over: Partial<WakeFacts> = {}) => () => ({ ...QUIET, ...over });
  const none = () => { throw new Error('The plan is not walked for an event due at once.'); };

  it.each(['waiting_input', 'waiting_approval', 'landing_conflict', 'auto_merge_stopped', 'usage_limit', 'task_report'] as const)('%s wakes at once, and the plan is not read', (kind) => {
    expect(wakeDue([event(kind, 500, 't1')], none, DEBOUNCE)).toEqual({ at: 500 + DEBOUNCE, reason: 'at_once' });
  });

  it('a run\'s end goes with no merge window, with what was held', () => {
    expect(wakeDue([event('task_idle', 5, 't1'), event('run_finished', 900)], none, DEBOUNCE)).toEqual({ at: 5, reason: 'run_ended' });
  });

  it('an event due at once takes what was held with it, its window its own', () => {
    expect(wakeDue([event('task_failed', 0, 't1'), event('waiting_input', 90_000, 't2')], none, DEBOUNCE)).toEqual({ at: 90_000 + DEBOUNCE, reason: 'at_once' });
  });

  it.each(['task_failed', 'task_idle'] as const)('%s with nothing else to go by waits for the cache\'s age, and an unknown cache reads as five minutes', (kind) => {
    expect(wakeDue([event(kind, 1000, 't1')], facts(), DEBOUNCE)).toEqual({ at: 1000 + 0.8 * UNKNOWN_CACHE_TTL_MS, reason: 'max_age' });
    expect(UNKNOWN_CACHE_TTL_MS).toBe(300_000);
  });

  it('counts the age as the provider does, from the start of the last request, while its prefix is warm', () => {
    const warm = facts({ ttlMs: 100_000, requestAt: 10_000 });
    expect(wakeDue([event('task_failed', 50_000, 't1')], warm, DEBOUNCE)).toEqual({ at: 90_000, reason: 'max_age' });
  });

  it('gives an event its whole age once the prefix is cold, there being nothing to save', () => {
    const cold = facts({ ttlMs: 100_000, requestAt: 10_000 });
    expect(wakeDue([event('task_failed', 200_000, 't1')], cold, DEBOUNCE)).toEqual({ at: 280_000, reason: 'max_age' });
  });

  it('is a maximum age: requests made since cannot hold a held event off', () => {
    const talked = facts({ ttlMs: 100_000, requestAt: 500_000 });
    expect(wakeDue([event('task_failed', 400_000, 't1')], talked, DEBOUNCE)).toEqual({ at: 480_000, reason: 'max_age' });
  });

  it('never goes inside the merge window, however close the cache runs', () => {
    expect(wakeDue([event('task_failed', 79_999, 't1')], facts({ ttlMs: 100_000, requestAt: 0 }), DEBOUNCE)).toEqual({ at: 80_999, reason: 'max_age' });
  });

  it('flushes once nothing can start without a decision', () => {
    expect(wakeDue([event('task_failed', 0, 't1')], facts({ nothingCanStart: true, ttlMs: TTL }), DEBOUNCE)).toEqual({ at: DEBOUNCE, reason: 'nothing_can_start' });
  });

  it('flushes once a held task\'s cohort is done', () => {
    expect(wakeDue([event('task_failed', 0, 't1')], facts({ cohortDone: new Set(['t1']), ttlMs: TTL }), DEBOUNCE)).toEqual({ at: DEBOUNCE, reason: 'cohort_done' });
    expect(wakeDue([event('task_failed', 0, 't1')], facts({ cohortDone: new Set(['t9']), ttlMs: TTL }), DEBOUNCE)?.reason).toBe('max_age');
  });

  it('flushes a failure that blocks work, and not silence', () => {
    expect(wakeDue([event('task_failed', 0, 't1')], facts({ blocksWork: new Set(['t1']), ttlMs: TTL }), DEBOUNCE)).toEqual({ at: DEBOUNCE, reason: 'failure_blocks_work' });
    expect(wakeDue([event('task_idle', 0, 't1')], facts({ blocksWork: new Set(['t1']), ttlMs: TTL }), DEBOUNCE)?.reason).toBe('max_age');
  });

  it('is due for nothing while nothing is held', () => {
    expect(wakeDue([], none, DEBOUNCE)).toBeNull();
  });
});

describe('what the plan says for a wake (ADR-0057 R4)', () => {
  const ready = (id: string, over: Partial<Task> = {}) => createTask({ id, order: 1, title: id, prompt: id, ...over });
  const failed = (id: string, over: Partial<Task> = {}) => ready(id, { status: 'failed', ...over });
  const running = (id: string, over: Partial<Task> = {}) => ready(id, { status: 'in_progress', ...over });
  const done = (id: string, over: Partial<Task> = {}) => ready(id, { status: 'completed', ...over });
  const STARTED: StartWait = { kind: 'started' };

  it('in a chain, a failed task\'s dependent is work it blocks, and nothing can start', () => {
    const plan = [failed('a'), ready('b', { dependencies: ['a'] }), ready('c', { dependencies: ['b'] })];
    const waits = new Map<string, StartWait[]>([
      ['a', [STARTED]],
      ['b', [{ kind: 'blocked', failed: ['a'] }, { kind: 'dependencies', waiting: ['a'] }]],
      ['c', [{ kind: 'blocked', failed: ['a'] }, { kind: 'dependencies', waiting: ['b'] }]],
    ]);

    const facts = planWakeFacts(plan, waits, true);
    expect(facts.blocksWork).toEqual(new Set(['a']));
    expect(facts.nothingCanStart).toBe(true);
    expect(facts.cohortDone.has('a')).toBe(true);
  });

  it('a dependent that still waits on work under way is not held back by the failure yet', () => {
    const plan = [failed('a'), running('b'), ready('c', { dependencies: ['a', 'b'] })];
    const waits = new Map<string, StartWait[]>([
      ['a', [STARTED]],
      ['b', [STARTED]],
      ['c', [{ kind: 'blocked', failed: ['a'] }, { kind: 'dependencies', waiting: ['a', 'b'] }]],
    ]);

    const facts = planWakeFacts(plan, waits, true);
    expect(facts.blocksWork).toEqual(new Set());
    expect(facts.nothingCanStart).toBe(false);
    expect(facts.cohortDone.has('a')).toBe(false);
  });

  it('a fan-out is one cohort: done once the last of them has ended, a slow sibling holding it', () => {
    const plan = (last: Task) => [done('root'), failed('a', { dependencies: ['root'] }), last];
    const waits = new Map<string, StartWait[]>([['root', [STARTED]], ['a', [STARTED]], ['b', [STARTED]]]);

    expect(planWakeFacts(plan(running('b', { dependencies: ['root'] })), waits, true).cohortDone.has('a')).toBe(false);
    expect(planWakeFacts(plan(done('b', { dependencies: ['root'] })), waits, true).cohortDone.has('a')).toBe(true);
  });

  it('a sibling waiting to start holds its cohort open while a scheduler would start it, and not after', () => {
    const plan = [failed('a'), ready('b')];
    const waits = new Map<string, StartWait[]>([['a', [STARTED]], ['b', []]]);

    expect(planWakeFacts(plan, waits, true)).toMatchObject({ nothingCanStart: false });
    expect(planWakeFacts(plan, waits, false)).toMatchObject({ nothingCanStart: true });
  });

  it.each<[string, StartWait]>([
    ['its approval', { kind: 'unapproved' }],
    ['a hold', { kind: 'on-hold' }],
    ['a merge gate', { kind: 'merge-gate', unmerged: ['a'] }],
    ['a person', { kind: 'by-hand' }],
  ])('a task waiting on %s moves nothing', (_name, wait) => {
    expect(planWakeFacts([failed('a'), ready('b')], new Map([['a', [STARTED]], ['b', [wait]]]), true).nothingCanStart).toBe(true);
  });

  it.each<[string, StartWait]>([
    ['a planner turn\'s hold', { kind: 'start-hold' }],
    ['a merge', { kind: 'merging' }],
    ['its runner\'s reset', { kind: 'usage-limit', runner: 'codex' }],
  ])('a task waiting on %s starts by itself', (_name, wait) => {
    expect(planWakeFacts([failed('a'), ready('b')], new Map([['a', [STARTED]], ['b', [wait]]]), true).nothingCanStart).toBe(false);
  });

  it('a task behind a failed subtask is read through the tree', () => {
    const plan = [ready('parent', { subtasks: [failed('sub')] }), ready('after', { dependencies: ['sub'] })];
    const waits = new Map<string, StartWait[]>([
      ['parent', [STARTED]],
      ['sub', [STARTED]],
      ['after', [{ kind: 'blocked', failed: ['sub'] }, { kind: 'dependencies', waiting: ['sub'] }]],
    ]);

    expect(planWakeFacts(plan, waits, true).blocksWork).toEqual(new Set(['sub']));
  });
});

describe('a flat run\'s events, end to end through the policy (ADR-0057 R4)', () => {
  it('holds a failure that blocks nothing, wakes when its cohort ends, and lets the passes ride along', () => {
    let facts = QUIET;
    const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => facts });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_failed', 100, 't2'));
    expect(policy.poll(100 + DEBOUNCE)).toBeNull();

    facts = { ...QUIET, cohortDone: new Set(['t2']) };
    policy.push(event('task_passed', 60_000, 't3'));
    expect(policy.poll(60_000)).toEqual({
      attention: [event('task_failed', 100, 't2')],
      sinceLast: [event('task_passed', 0, 't1'), event('task_passed', 60_000, 't3')],
    });
  });

  it('gives back a batch of what was held when the owner stands down, whatever it was waiting for', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE, facts: () => QUIET });
    policy.push(event('task_idle', 0, 't1'));

    expect(policy.poll(Number.POSITIVE_INFINITY)?.attention).toHaveLength(1);
  });
});
