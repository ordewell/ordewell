import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanUp, hasGit, heldPlan, HOOK, ok, refExists, startsAgain, USER } from './heldConfigKit';

/**
 * The second review's reproductions, on real git (ADR-0028, ADR-0013): a run
 * is replaced only when git confirms the user's branch holds everything it
 * landed (L1, L2), only by a person's own start of a task in a worktree,
 * judged at the start that activates the run (C1, C1'), and a release is per
 * run (C2).
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
