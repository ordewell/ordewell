import { describe, it, expect, vi } from 'vitest';
import { IsolationRunController, type IsolationRunListener } from '../IsolationRunController';
import { createTask, type Task } from '../../models/Task';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/**
 * When a start replaces the plan's run with one from HEAD, enumerated at the
 * controller over everything it reads (ADR-0013, ADR-0028): each pair of
 * record states two tasks can leave, what git says of the user's branch, the
 * run's own flags, which task is live, and whether the start that decides is a
 * person's own of a task in a worktree. The expected outcome is computed from
 * the rules, never written per case:
 *
 * - Rule 1: a run is replaced only when git confirms the user's branch holds
 *   every integration tip and no record holds unlanded work, a kept attempt,
 *   a failed landing or a conflict, a live attempt, a child, or kept branches;
 *   nor may the run hold a landing cut short. A revert keeps nothing back:
 *   its commits are on the tip git finds. Records alone never decide, either
 *   way: git is asked last, and only of a start that consents, and a landing
 *   only the ledger still names keeps the run for every other start.
 * - Rule 2: only a person's own start of a task in a worktree, as it decides
 *   the run, replaces it. Who opened the run is not read.
 *
 * A run that is not continuable at all, its records all `active` with no child,
 * nothing reverted and no landing in its ledger, holds only superseded
 * attempts and is minted anew for any start, as on main.
 *
 * The git edges (several repositories with one merged, HEAD on another branch
 * or detached, an integration branch deleted by hand, a squash merge, a review
 * branch) are git's to answer, and `GitWorktreeIsolation.userBranch.e2e`
 * pins each; here git's answer is one yes or no.
 */

const STATES = ['absent', 'merged', 'active-empty', 'active-unlanded', 'kept', 'failed', 'conflict', 'child', 'merged-child', 'kept-branches'] as const;
type State = typeof STATES[number];
/** `ledger`: the ledger names a landing of t0's, whose record a held start dropped (the third review's F1). */
const FLAGS = ['none', 'reverted', 'landing', 'ledger'] as const;
type Flag = typeof FLAGS[number];
const LIVE = ['none', 't1', 't2'] as const;
type Live = typeof LIVE[number];

interface Case { t1: State; t2: State; git: boolean; flag: Flag; live: Live; consent: boolean }

function setup() {
  const isolation = new FakeWorktreeIsolation();
  const listener: IsolationRunListener = { changed: vi.fn(), blocked: vi.fn(), handoff: vi.fn(), closed: vi.fn(), ended: vi.fn(), notice: vi.fn(), resolversEnded: vi.fn() };
  const live = new Set<string>();
  const runs = new IsolationRunController({ isolation, config: fakeConfig(), notifications: fakeNotification(), workspaceRoot: () => '/repo', listener, liveTasks: () => live, landedOn: () => [] });
  return { runs, isolation, live };
}

const task = (id: string, order: number): Task => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}` });

/** The run a case starts from: its records left as `t1` and `t2` say, then the run interrupted, as a Stop leaves it. */
async function arrange(c: Case) {
  const env = setup();
  const { runs, isolation, live } = env;
  isolation.unlandedWork = new Set([c.t1 === 'active-unlanded' ? 't1' : '', c.t2 === 'active-unlanded' ? 't2' : ''].filter(Boolean));
  isolation.branchHolds = c.git;
  await runs.decide(async () => undefined);
  for (const [id, state, order] of [['t1', c.t1, 1], ['t2', c.t2, 2]] as const) {
    if (state === 'absent') continue;
    const t = task(id, order);
    if (state === 'failed' || state === 'conflict') isolation.outcomes.set(id, state);
    await runs.attemptCwd(t, 'fresh', runs.decision);
    if (state === 'child' || state === 'merged-child') runs.hostChild(id, () => `child-${id}`);
    if (state === 'merged' || state === 'merged-child' || state === 'failed' || state === 'conflict') await runs.integrate(t);
    if (state === 'kept') await runs.release(id, { keep: true });
    if (state === 'kept-branches') runs.planIsolation!.run.tasks[id].continuationWork = [{ repo: '.', branch: `ordewell-preserved/run1/${id}`, commit: 'abc1234' }];
  }
  const run = runs.planIsolation!.run;
  if (c.flag === 'reverted') run.reverted = true;
  if (c.flag === 'landing') run.landing = { taskId: 't1', tips: { '.': 'tip-before' } };
  if (c.flag === 'ledger') run.landings = { ...run.landings, t0: { '.': ['tip-t0'] } };
  if (c.live !== 'none') live.add(c.live);
  runs.interrupt();
  return env;
}

/** Rule 1 over the records, the flags and what is live; git's answer is read on its own. */
function recordsClear(c: Case): boolean {
  const states = [c.t1, c.t2];
  const liveRecord = c.live !== 'none' && c[c.live] !== 'absent';
  return c.flag !== 'landing' && !liveRecord && states.every((s) => s === 'absent' || s === 'merged' || s === 'active-empty');
}

/** The run is continued unless replaced: only a run with nothing but plain `active` records, no revert and nothing in its ledger is superseded for anyone. */
function continuable(c: Case): boolean {
  return c.flag === 'reverted' || c.flag === 'ledger' || [c.t1, c.t2].some((s) => s !== 'absent' && s !== 'active-empty' && s !== 'active-unlanded' && s !== 'kept-branches');
}

function expectedReplaced(c: Case): boolean {
  if (!continuable(c)) return true;
  return c.consent && recordsClear(c) && c.git;
}

const cases = (consent: boolean, git: boolean, flag: Flag, live: Live): Case[] =>
  STATES.flatMap((t1) => STATES.map((t2) => ({ t1, t2, git, flag, live, consent })));

describe('which start replaces a run that may be spent (enumerated)', () => {
  const groups = [true, false].flatMap((consent) => [true, false].flatMap((git) => FLAGS.flatMap((flag) => LIVE.map((live) => ({ consent, git, flag, live })))));

  it.each(groups)('consent $consent, git says the branch holds it $git, run flag $flag, live $live: every pair of record states', async ({ consent, git, flag, live }) => {
    const wrong: string[] = [];
    for (const c of cases(consent, git, flag, live)) {
      const { runs, isolation } = await arrange(c);
      const before = runs.planIsolation!.run.id;
      await runs.decide(async () => undefined, c.consent);
      const replaced = runs.planIsolation?.run.id !== before;
      const askedGit = isolation.calls.some((call) => call.op === 'userBranchHolds');
      const want = expectedReplaced(c);
      if (replaced !== want) wrong.push(`${c.t1}/${c.t2}: replaced ${replaced}, want ${want}`);
      // Git is asked only of a start that consents, and only once the records leave nothing.
      if (askedGit && !(c.consent && recordsClear(c) && continuable(c))) wrong.push(`${c.t1}/${c.t2}: asked git`);
    }
    expect(wrong).toEqual([]);
  });

  it('covers every state of two records under each combination', () => {
    expect(groups).toHaveLength(2 * 2 * FLAGS.length * LIVE.length);
    expect(cases(true, true, 'none', 'none')).toHaveLength(STATES.length ** 2);
  });
});
