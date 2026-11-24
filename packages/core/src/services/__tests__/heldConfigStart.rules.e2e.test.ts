import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanUp, hasGit, heldPlan, HOOK, ok, PLANNER, refExists, startsAgain, SUPERVISOR, USER } from './heldConfigKit';

/**
 * The second and third reviews' reproductions, on real git (ADR-0028,
 * ADR-0013): a run is replaced only when git confirms the user's branch holds
 * everything it landed (L1, L2), whatever its records still say of it (F1),
 * only by a person's own start of a task in a worktree, judged at the start
 * that activates the run (C1, C1', F1), a release is per run (C2), and it
 * follows from what the hold says, a run that reverted a task included (F2).
 */

afterEach(cleanUp);

const CONTINUE = { command: 'retry_task', task: 't1', from: 'session', message: 'go on' } as const;

/**
 * t0 lands the hook while t1 runs beside it; the user's Merge all brings the
 * hook into their branch while t1 still runs, and t1 then lands t1.txt, which
 * their branch lacks.
 */
async function landedBesideMerge() {
  const held = heldPlan([{ id: 't0', title: 'Add a hook', hook: true }, { id: 't1', title: 'Write t1' }], { holdOnce: ['t1'] });
  const { session } = held;
  await ok(session, { command: 'run_plan' }, USER);
  await vi.waitFor(() => expect(held.records().t0).toBe('merged'), { timeout: 20_000 });
  await ok(session, { command: 'merge_all' }, USER);
  expect(held.inCheckout(HOOK)).not.toBeNull();
  held.release('t1');
  await vi.waitFor(() => expect(held.records().t1).toBe('merged'), { timeout: 20_000 });
  await vi.waitFor(() => expect(held.statusOf('t1')).toBe('completed'), { timeout: 20_000 });
  expect(held.inCheckout('t1.txt')).toBeNull();
  return held;
}

/** The run in force, its records, t1's hold and spawns, and the landing its integration branch keeps. */
function keptWithItsLanding(held: Awaited<ReturnType<typeof landedBesideMerge>>, run: string | undefined) {
  expect(run).toBe('run1');
  expect(held.runId()).toBe(run);
  expect(held.spawns('t1')).toBe(1);
  expect(held.holdOf('t1')).toContain(HOOK);
  expect(refExists(held.root, `ordewell/${run}/integration`)).toBe(true);
  expect(held.fileOn(`ordewell/${run}/integration`, 't1.txt')).toBe('t1 attempt 1');
}

describe.skipIf(!hasGit)('rule 1: a run whose landed work the user\'s branch lacks is kept, whatever its records say', () => {
  it('L1: the user\'s Continue of a task that landed after their Merge all, held, then Stop and the same Continue', async () => {
    const held = await landedBesideMerge();
    const { session } = held;

    await startsAgain(held, 't1', () => ok(session, CONTINUE, USER));
    expect(held.holdOf('t1')).toContain(HOOK);
    // The held start's prepare dropped t1's landed record: only git still says its work is on the branch.
    expect(held.records()).toEqual({ t0: 'merged', t1: 'active' });
    const run = held.runId();

    await ok(session, { command: 'stop_run' }, USER);
    await startsAgain(held, 't1', () => ok(session, CONTINUE, USER));

    keptWithItsLanding(held, run);
  });

  it('L2: the user\'s Mark not done of that task and their Start now, held, then Stop and the same Start now', async () => {
    const held = await landedBesideMerge();
    const { session } = held;

    await ok(session, { command: 'stop_run' }, USER);
    await ok(session, { command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' }, USER);
    await startsAgain(held, 't1', () => ok(session, { command: 'run_task', task: 't1' }, USER));
    expect(held.holdOf('t1')).toContain(HOOK);
    expect(held.records()).toEqual({ t0: 'merged', t1: 'active' });
    const run = held.runId();

    await ok(session, { command: 'stop_run' }, USER);
    await startsAgain(held, 't1', () => ok(session, { command: 'run_task', task: 't1' }, USER));

    keptWithItsLanding(held, run);
  });
});

/** t1 lands the hook; t2, after it, is held; t3, an ops task after t1, waits at its merge gate and, once started, keeps running. */
async function heldBesideOps() {
  const held = heldPlan([
    { id: 't1', title: 'Add a hook', hook: true },
    { id: 't2', title: 'Check the hook', dependencies: ['t1'] },
    { id: 't3', title: 'Run the hook', dependencies: ['t1'], ops: true },
  ], { hold: ['t3'] });
  await ok(held.session, { command: 'run_plan' }, USER);
  await vi.waitFor(() => expect(held.holdOf('t2')).toContain(HOOK), { timeout: 20_000 });
  return held;
}

/** The user's own start of t3 alone, an ops task, which keeps running; then the supervisor's start of t2. */
async function opsThenSupervisor(held: Awaited<ReturnType<typeof heldBesideOps>>) {
  const { session } = held;
  const run = held.runId();
  const t3 = held.spawns('t3');
  await ok(session, { command: 'retry_task', task: 't3', from: 'fresh' }, USER);
  await vi.waitFor(() => expect(held.spawns('t3')).toBe(t3 + 1), { timeout: 20_000 });
  await startsAgain(held, 't2', () => ok(session, { command: 'run_task', task: 't2' }, SUPERVISOR));
  expect({ run: held.runId(), t2: held.hookFor('t2') }).toEqual({ run, t2: [] });
  expect(held.holdOf('t2')).toContain(HOOK);
}

describe.skipIf(!hasGit)('rule 2: only a person\'s own start of a task in a worktree, as it activates the run, replaces it', () => {
  it('C1: the user\'s Merge all and Stop, their start of an ops task alone, then the supervisor\'s run_task', async () => {
    const held = await heldBesideOps();
    await ok(held.session, { command: 'merge_all' }, USER);
    await ok(held.session, { command: 'stop_run' }, USER);
    expect(held.inCheckout(HOOK)).not.toBeNull();
    await opsThenSupervisor(held);
  });

  it('C1\': the supervisor\'s Stop and Merge all, the user\'s start of an ops task alone, then the supervisor\'s run_task', async () => {
    const held = await heldBesideOps();
    await ok(held.session, { command: 'stop_run' }, SUPERVISOR);
    await ok(held.session, { command: 'merge_all' }, SUPERVISOR);
    expect(held.inCheckout(HOOK)).not.toBeNull();
    await opsThenSupervisor(held);
  });
});

describe.skipIf(!hasGit)('rule 3: a release is per run', () => {
  it('C2: once the user\'s Start now of one held task begins a run from their branch, the supervisor\'s run_task of another starts it there', async () => {
    const held = heldPlan([
      { id: 't1', title: 'Add a hook', hook: true },
      { id: 't2', title: 'Check the hook', dependencies: ['t1'] },
      { id: 't4', title: 'Use the hook', dependencies: ['t1'] },
    ]);
    const { session } = held;
    await ok(session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect([held.holdOf('t2'), held.holdOf('t4')]).toEqual([expect.stringContaining(HOOK), expect.stringContaining(HOOK)]), { timeout: 20_000 });
    await ok(session, { command: 'merge_all' }, USER);
    await ok(session, { command: 'stop_run' }, USER);

    await startsAgain(held, 't4', () => ok(session, { command: 'run_task', task: 't4' }, USER));
    const run = held.runId();
    expect(run).toBe('run2');
    expect(held.hookFor('t4')).toEqual([true]);

    await startsAgain(held, 't2', () => ok(session, { command: 'run_task', task: 't2' }, SUPERVISOR));
    expect({ run: held.runId(), t2: held.hookFor('t2') }).toEqual({ run, t2: [true] });
  });
});

describe.skipIf(!hasGit)('rule 4: what the hold offers at the root starts the task', () => {
  it('removing the configuration: the user reverts and skips the task that added it, then starts the held one, in the same run', async () => {
    const held = heldPlan([
      { id: 't1', title: 'Add a hook', hook: true },
      { id: 't2', title: 'Check the hook', dependencies: ['t1'] },
    ]);
    const { session } = held;
    await ok(session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.holdOf('t2')).toContain(HOOK), { timeout: 20_000 });
    const run = held.runId();
    await ok(session, { command: 'stop_run' }, USER);

    // t2 never landed, so the revert takes t1 alone.
    await ok(session, { command: 'revert_task', task: 't1', confirmed: true, seen: ['t1'] }, USER);
    await ok(session, { command: 'skip_task', task: 't1' }, USER);
    await startsAgain(held, 't2', () => ok(session, { command: 'run_task', task: 't2' }, USER));

    expect({ run: held.runId(), t2: held.hookFor('t2') }).toEqual({ run, t2: [false] });
  });
});

/** t1 lands the hook; t2, after it, is held. */
async function heldAfterHook() {
  const held = heldPlan([{ id: 't1', title: 'Add a hook', hook: true }, { id: 't2', title: 'Check the hook', dependencies: ['t1'] }]);
  await ok(held.session, { command: 'run_plan' }, USER);
  await vi.waitFor(() => expect(held.holdOf('t2')).toContain(HOOK), { timeout: 20_000 });
  return held;
}

/** run1 in force, t1 held in it with no attempt past its first, and its landing still on run1's integration branch. */
function keptWithHook(held: Awaited<ReturnType<typeof heldAfterHook>>) {
  expect(held.runId()).toBe('run1');
  expect(held.hookFor('t1')).toEqual([false]);
  expect(held.holdOf('t1')).toContain(HOOK);
  expect(held.fileOn('ordewell/run1/integration', HOOK)).not.toBeNull();
}

describe.skipIf(!hasGit)('F1: a run whose only landed record a held start dropped is kept, as its ledger still names the landing', () => {
  it('(a) the user\'s Merge all and Stop, then the supervisor\'s Continue of the task that landed, held, and the same Continue', async () => {
    const held = await heldAfterHook();
    const { session } = held;
    await ok(session, { command: 'merge_all' }, USER);
    await ok(session, { command: 'stop_run' }, USER);

    await startsAgain(held, 't1', () => ok(session, CONTINUE, SUPERVISOR));
    // The held start's prepare dropped t1's landed record: only the ledger and git still say its work is on the branch.
    expect(held.records()).toEqual({ t1: 'active', t2: 'active' });
    await startsAgain(held, 't1', () => ok(session, CONTINUE, SUPERVISOR));

    keptWithHook(held);
    // What the hold offers still releases it: the user's own start of the task held, which t2 now waits for, begins a run from their branch.
    await startsAgain(held, 't1', () => ok(session, CONTINUE, USER));
    expect({ run: held.runId(), t1: held.hookFor('t1') }).toEqual({ run: 'run2', t1: [false, true] });
  });

  it('(b) the user\'s Stop with nothing merged, then the supervisor\'s Continue of the task that landed, held, and the same Continue', async () => {
    const held = await heldAfterHook();
    const { session } = held;
    await ok(session, { command: 'stop_run' }, USER);

    await startsAgain(held, 't1', () => ok(session, CONTINUE, SUPERVISOR));
    expect(held.records()).toEqual({ t1: 'active', t2: 'active' });
    await startsAgain(held, 't1', () => ok(session, CONTINUE, SUPERVISOR));

    keptWithHook(held);
  });

  it('(c) the user\'s Merge all, Stop and Mark not done of the task that landed, then the planner\'s run_task of it, held, and again', async () => {
    const held = await heldAfterHook();
    const { session } = held;
    await ok(session, { command: 'merge_all' }, USER);
    await ok(session, { command: 'stop_run' }, USER);
    await ok(session, { command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' }, USER);

    await startsAgain(held, 't1', () => ok(session, { command: 'run_task', task: 't1' }, PLANNER));
    expect(held.records()).toEqual({ t1: 'active', t2: 'active' });
    await startsAgain(held, 't1', () => ok(session, { command: 'run_task', task: 't1' }, PLANNER));

    keptWithHook(held);
  });

  it('(d) the user\'s Stop and Mark not done of the task that landed, with nothing merged, then their own Start now of it, held, and again', async () => {
    const held = await heldAfterHook();
    const { session } = held;
    await ok(session, { command: 'stop_run' }, USER);
    await ok(session, { command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' }, USER);

    await startsAgain(held, 't1', () => ok(session, { command: 'run_task', task: 't1' }, USER));
    expect(held.records()).toEqual({ t1: 'active', t2: 'active' });
    await ok(session, { command: 'stop_run' }, USER);
    await startsAgain(held, 't1', () => ok(session, { command: 'run_task', task: 't1' }, USER));

    keptWithHook(held);
  });
});

describe.skipIf(!hasGit)('F2: a run that reverted a task is replaced as the hold says, once the user\'s branch holds it all', () => {
  it.each([
    ['their Start now', { command: 'run_task', task: 't2' }],
    ['their Retry', { command: 'retry_task', task: 't2', from: 'fresh' }],
    ['their Run', { command: 'run_plan' }],
  ] as const)('the user\'s Stop, revert of a sibling, Merge all and Stop, then %s of the held task', async (_name, start) => {
    const held = heldPlan([
      { id: 't1', title: 'Add a hook', hook: true },
      { id: 't5', title: 'Write t5' },
      { id: 't2', title: 'Check the hook', dependencies: ['t1'] },
    ]);
    const { session } = held;
    await ok(session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.holdOf('t2')).toContain(HOOK), { timeout: 20_000 });
    await vi.waitFor(() => expect(held.records().t5).toBe('merged'), { timeout: 20_000 });
    await ok(session, { command: 'stop_run' }, USER);
    await ok(session, { command: 'revert_task', task: 't5', confirmed: true, seen: ['t5'] }, USER);
    expect(held.records()).toEqual({ t1: 'merged', t2: 'active' });
    await ok(session, { command: 'merge_all' }, USER);
    await ok(session, { command: 'stop_run' }, USER);
    expect(held.inCheckout(HOOK)).not.toBeNull();
    // The revert came to the user's branch with the landing it took back.
    expect(held.inCheckout('t5.txt')).toBeNull();

    await startsAgain(held, 't2', () => ok(session, start, USER));

    expect({ run: held.runId(), t2: held.hookFor('t2') }).toEqual({ run: 'run2', t2: [true] });
    expect(refExists(held.root, 'ordewell/run1/integration')).toBe(false);
  });
});
