import { describe, expect, it } from 'vitest';
import type { IsolationRun, IsolationTaskRecord, IsolationTaskStatus } from '../../interfaces/IWorktreeIsolation';
import { createTask } from '../../models/Task';
import {
  alsoLandedBy, carriedTipsIn, dependentsOf, forgetReverted, freshLedger, hasLandingIn, hasReverted, isCarried, keepLandedOn, landedIn,
  landedOnOf, landedReposOf, landedTaskOf, landedTitleOf, landedWork, landingsIn, landingsOf, marksRevertible, mayHaveLanded, mergedIn,
  recordCarried, recordLanding, recordlessRevertible, revertReach, startedOlder, unreadLanding,
} from '../LandingLedger';

// The ledger's rules over plain runs: no git, no worktree, no fake isolation.

const record = (taskId: string, status: IsolationTaskStatus = 'merged', repos: Record<string, { changed?: boolean; landedTip?: string }> = { '.': { changed: true } }): IsolationTaskRecord => ({
  taskId, order: Number(taskId.replace(/\D/g, '')) || 1, title: `Task ${taskId}`, branch: `ordewell/r1/${taskId}`, workspace: `/wt/${taskId}`, status,
  repos: Object.fromEntries(Object.entries(repos).map(([repo, entry]) => [repo, { worktree: `/wt/${taskId}/${repo}`, linked: [], ...entry }])),
});

const runOf = (over: Partial<IsolationRun> = {}): IsolationRun => ({
  id: 'r1', workspaceRoot: '/work', repos: [], shared: [], sharedRepos: [], tasks: {}, ...freshLedger(), ...over,
});

/** A run as a build before the ledger saved it: no `carried`, no `keepsEveryLanding`. */
const olderRun = (over: Partial<IsolationRun> = {}): IsolationRun => ({ id: 'r1', workspaceRoot: '/work', repos: [], shared: [], sharedRepos: [], tasks: {}, ...over });

describe('freshLedger and startedOlder', () => {
  it('starts a run keeping every landing, with an empty carried record', () => {
    expect(freshLedger()).toEqual({ keepsEveryLanding: true, carried: {} });
    expect(startedOlder(runOf())).toBe(false);
  });

  it('reads a run with no carried record as started by an older build', () => {
    expect(startedOlder(olderRun())).toBe(true);
  });

  it('gives each run its own carried record', () => {
    expect(freshLedger().carried).not.toBe(freshLedger().carried);
  });
});

describe('recordLanding', () => {
  it('sets the tip on the record and keeps every merge, newest last, once', () => {
    const run = runOf();
    const r = record('t1', 'merged', { '.': { changed: true }, lib: { changed: true } });
    run.tasks.t1 = r;
    recordLanding(run, r, [['.', 'm1'], ['lib', 'l1']]);
    recordLanding(run, r, [['.', 'm2']]);
    recordLanding(run, r, [['.', 'm1']]);
    expect(r.repos['.'].landedTip).toBe('m1');
    expect(r.repos.lib.landedTip).toBe('l1');
    expect(run.landings).toEqual({ t1: { '.': ['m2', 'm1'], lib: ['l1'] } });
    expect(run.landedTasks).toEqual({ t1: { taskId: 't1', order: 1, title: 'Task t1' } });
  });

  it('keeps the commit a task landed with, and nothing else of its record', () => {
    const run = runOf();
    const r = { ...record('t2'), commit: { subject: 'Add x' }, conflictFiles: ['a.ts'] };
    recordLanding(run, r, [['.', 'm1']]);
    expect(run.landedTasks?.t2).toEqual({ taskId: 't2', order: 2, title: 'Task t2', commit: { subject: 'Add x' } });
  });

  it('starts the ledger of a run saved before landings were kept at this landing, the record tip moved first', () => {
    const run = olderRun();
    const r = record('t1', 'merged', { '.': { changed: true, landedTip: 'old' } });
    run.tasks.t1 = r;
    recordLanding(run, r, [['.', 'new']]);
    expect(r.repos['.'].landedTip).toBe('new');
    expect(run.landings?.t1['.']).toEqual(['new']);
  });

  it('records a merge in a repo the record has no entry for, without inventing one', () => {
    const run = runOf();
    const r = record('t1');
    recordLanding(run, r, [['lib', 'l1']]);
    expect(r.repos.lib).toBeUndefined();
    expect(run.landings?.t1.lib).toEqual(['l1']);
  });

  it('records nothing for a landing that made no merge', () => {
    const run = runOf();
    recordLanding(run, record('t1'), []);
    expect(run.landings).toBeUndefined();
    expect(run.landedTasks).toBeUndefined();
  });
});

describe('recordCarried', () => {
  it('appends what a merge carried, by task and repo, and remembers what to call it', () => {
    const run = runOf();
    const t3 = { taskId: 't3', order: 3, title: 'Task t3' };
    recordCarried(run, [{ record: t3, repoPath: '.', tip: 'c1' }, { record: t3, repoPath: '.', tip: 'c2' }, { record: t3, repoPath: 'lib', tip: 'c3' }]);
    expect(run.carried).toEqual({ t3: { '.': ['c1', 'c2'], lib: ['c3'] } });
    expect(run.landedTasks?.t3).toEqual(t3);
  });

  it('starts no carried record on a run that began without one', () => {
    const run = olderRun();
    recordCarried(run, [{ record: { taskId: 't3', order: 3, title: 'Task t3' }, repoPath: '.', tip: 'c1' }]);
    expect(run.carried).toBeUndefined();
    expect(run.landedTasks).toBeUndefined();
    expect(startedOlder(run)).toBe(true);
  });
});

describe('reading who landed what', () => {
  it('names a task by its record, then by the ledger, then by its id', () => {
    const run = runOf({ tasks: { t1: record('t1') }, landedTasks: { t2: { taskId: 't2', order: 2, title: 'Gone' } } });
    expect(landedTaskOf(run, 't1')?.title).toBe('Task t1');
    expect(landedTaskOf(run, 't2')?.title).toBe('Gone');
    expect(landedTaskOf(null, 't1')).toBeUndefined();
    expect(landedTitleOf(run, 't9')).toBe('t9');
  });

  it('reads the merges of a task in a repo, falling back to the record tip', () => {
    const run = runOf({ tasks: { t1: record('t1', 'merged', { '.': { changed: true, landedTip: 'tip' } }) }, landings: { t2: { '.': ['a', 'b'] } } });
    expect(landingsOf(run, 't1', '.')).toEqual(['tip']);
    expect(landingsOf(run, 't2', '.')).toEqual(['a', 'b']);
    expect(landingsOf(run, 't2', 'lib')).toEqual([]);
    expect(landingsIn(run, '.')).toEqual([{ taskId: 't2', merge: 'a' }, { taskId: 't2', merge: 'b' }]);
    expect(landedReposOf(run, 't2')).toEqual(['.']);
    expect(landedReposOf(run, 't1')).toEqual([]);
  });

  it('says whether anything landed in a repo, by the ledger or a record tip', () => {
    expect(hasLandingIn(runOf({ landings: { t1: { '.': ['a'] } } }), '.')).toBe(true);
    expect(hasLandingIn(runOf({ landings: { t1: { '.': [] } } }), '.')).toBe(false);
    expect(hasLandingIn(runOf({ tasks: { t1: record('t1', 'merged', { lib: { landedTip: 'x' } }) } }), 'lib')).toBe(true);
    expect(hasLandingIn(runOf({ tasks: { t1: record('t1') } }), '.')).toBe(false);
  });

  it('reads what was carried, in one repo or any', () => {
    const run = runOf({ carried: { t3: { lib: ['c1'] } } });
    expect(isCarried(run, 't3')).toBe(true);
    expect(isCarried(run, 't3', 'lib')).toBe(true);
    expect(isCarried(run, 't3', '.')).toBe(false);
    expect(isCarried(undefined, 't3')).toBe(false);
    expect(carriedTipsIn(run, 'lib')).toEqual([{ taskId: 't3', tip: 'c1' }]);
    expect(carriedTipsIn(olderRun(), 'lib')).toEqual([]);
  });

  it('counts a task as landed in a repo by its merges, what carried it, or a merged record that changed it', () => {
    const run = runOf({
      tasks: { t1: record('t1'), t4: record('t4', 'conflict') },
      landings: { t2: { '.': ['a'] } },
      carried: { t3: { '.': ['c'] } },
    });
    expect(['t1', 't2', 't3', 't4'].map((id) => landedIn(run, id, '.'))).toEqual([true, true, true, false]);
    expect(landedIn(run, 't1', 'lib')).toBe(false);
  });

  it('reads a record as merged in a repo it changed or the ledger holds merges in', () => {
    const run = runOf({ landings: { t1: { lib: ['l'] } } });
    const r = record('t1', 'conflict', { '.': { changed: true }, lib: {}, docs: {} });
    expect(mergedIn(run, r, '.')).toBe(true);
    expect(mergedIn(run, r, 'lib')).toBe(true);
    expect(mergedIn(run, r, 'docs')).toBe(false);
  });

  it('counts work of a task\'s own, of this attempt or an earlier one', () => {
    const run = runOf({
      tasks: { t1: record('t1'), t2: record('t2', 'merged', { '.': {} }), t5: record('t5', 'active') },
      landings: { t5: { '.': ['a'] } },
      carried: { t3: { '.': ['c'] } },
    });
    expect(['t1', 't2', 't3', 't5', 't9'].map((id) => landedWork(run, id))).toEqual([true, false, true, true, false]);
    expect(landedWork(null, 't1')).toBe(false);
  });
});

describe('mayHaveLanded', () => {
  const tried = createTask({ id: 't1', attempted: true });

  it('answers no for a run that kept every landing from the start', () => {
    expect(mayHaveLanded(runOf(), tried)).toBe(false);
  });

  it('answers yes for an attempted AI task of an older run with nothing to say it did not', () => {
    expect(mayHaveLanded(olderRun(), tried)).toBe(true);
    expect(mayHaveLanded(olderRun({ tasks: { t1: record('t1', 'kept') } }), createTask({ id: 't1' }))).toBe(true);
    expect(mayHaveLanded(null, tried)).toBe(true);
  });

  it('answers no for work it knows of, a task that never started, a read-only record, an ops or a manual task', () => {
    expect(mayHaveLanded(olderRun({ tasks: { t1: record('t1') } }), tried)).toBe(false);
    expect(mayHaveLanded(olderRun(), createTask({ id: 't1' }))).toBe(false);
    expect(mayHaveLanded(olderRun({ tasks: { t1: { ...record('t1', 'kept'), readOnly: true } } }), tried)).toBe(false);
    expect(mayHaveLanded(olderRun(), createTask({ id: 't1', attempted: true, ops: true }))).toBe(false);
    expect(mayHaveLanded(olderRun(), createTask({ id: 't1', attempted: true, type: 'user' }))).toBe(false);
  });
});

describe('unreadLanding', () => {
  it('names a landed task that left the plan with no record of what it stood on', () => {
    const run = runOf({ landings: { gone: { '.': ['a'] } }, landedTasks: { gone: { taskId: 'gone', order: 7, title: 'Gone task' } } });
    expect(unreadLanding(run, new Set())).toBe('Gone task');
    keepLandedOn(run, 'gone', []);
    expect(unreadLanding(run, new Set())).toBeUndefined();
  });

  it('falls back to the id for a landing nothing names', () => {
    const run = runOf({ carried: { gone: { '.': ['c'] } }, landedOn: { gone: [] } });
    expect(unreadLanding(run, new Set())).toBe('gone');
  });

  it('reads nothing of a task still in the plan, of one that landed nothing, or of no run', () => {
    const run = runOf({ tasks: { t1: record('t1'), t2: record('t2', 'kept') } });
    expect(unreadLanding(run, new Set(['t1']))).toBeUndefined();
    expect(unreadLanding(null, new Set())).toBeUndefined();
  });
});

describe('alsoLandedBy', () => {
  it('names another task recorded as landed by the same merge', () => {
    const run = runOf({
      tasks: { t1: record('t1', 'merged', { '.': { changed: true, landedTip: 'm' } }) },
      landings: { t2: { '.': ['m'] } },
      landedTasks: { t2: { taskId: 't2', order: 2, title: 'Other' } },
    });
    expect(alsoLandedBy(run, '.', 't1', 'm')).toBe('Other');
    expect(alsoLandedBy(run, '.', 't2', 'm')).toBe('Task t1');
    expect(alsoLandedBy(run, '.', 't1', 'z')).toBeUndefined();
    expect(alsoLandedBy(run, 'lib', 't1', 'm')).toBeUndefined();
  });
});

describe('marksRevertible and recordlessRevertible', () => {
  it('marks landed work with a merge of its own in every repo it changed', () => {
    const run = runOf({ landings: { t1: { '.': ['m'] } } });
    expect(marksRevertible(record('t1'), run)).toBe(true);
    expect(marksRevertible(record('t2', 'merged', { '.': { changed: true, landedTip: 'm' } }), runOf())).toBe(true);
  });

  it('marks a later attempt\'s record that did not land, over merges the ledger keeps', () => {
    expect(marksRevertible(record('t1', 'conflict', { '.': {} }), runOf({ landings: { t1: { '.': ['m'] } } }))).toBe(true);
  });

  it('leaves the mark off work at hand, in the user\'s branch, carried, unmerged or with no run that keeps the record', () => {
    const run = runOf({ landings: { t1: { '.': ['m'] } }, carried: {} });
    expect(marksRevertible(record('t1', 'active'), run)).toBe(false);
    expect(marksRevertible(record('t1', 'repairing'), run)).toBe(false);
    expect(marksRevertible({ ...record('t1'), inHead: true }, run)).toBe(false);
    expect(marksRevertible(record('t1'), runOf({ landings: { t1: { '.': ['m'] } }, carried: { t1: { '.': ['c'] } } }))).toBe(false);
    expect(marksRevertible(record('t1'), olderRun({ landings: { t1: { '.': ['m'] } } }))).toBe(false);
    expect(marksRevertible(record('t1'))).toBe(false);
    expect(marksRevertible(record('t2', 'merged', { '.': {} }), run)).toBe(false);
    expect(marksRevertible(record('t2', 'merged', { '.': { changed: true }, lib: { changed: true, landedTip: 'l' } }), run)).toBe(false);
  });

  it('offers the landings a retry dropped the record of, unless a merge carried them or the run is older', () => {
    expect(recordlessRevertible(runOf({ landings: { t1: { '.': ['a'] }, t2: { '.': ['b'] } }, carried: { t2: { '.': ['c'] } } }))).toEqual(['t1']);
    expect(recordlessRevertible(olderRun({ landings: { t1: { '.': ['a'] } } }))).toEqual([]);
  });
});

describe('what a task stands on, and what stands on it', () => {
  const a = createTask({ id: 'a' });
  const b = createTask({ id: 'b', dependencies: ['a'] });
  const c = createTask({ id: 'c', dependencies: ['b'] });
  const check = createTask({ id: 'check', loop: { body: ['c'], maxRounds: 3 } });
  const tasks = [a, b, c, check];

  it('reads what a task depends on, directly or not, a check counting on its body', () => {
    expect(landedOnOf('c', tasks).sort()).toEqual(['a', 'b']);
    expect(landedOnOf('check', tasks).sort()).toEqual(['a', 'b', 'c']);
    expect(landedOnOf('a', tasks)).toEqual([]);
    expect(landedOnOf('missing', tasks)).toEqual([]);
  });

  it('reads everything that depends on a task, by the plan and by what the ledger kept', () => {
    expect([...dependentsOf(tasks, null, 'a')].sort()).toEqual(['b', 'c', 'check']);
    const run = runOf({ landedOn: { gone: ['a'], later: ['gone'] } });
    expect([...dependentsOf([a], run, 'a')].sort()).toEqual(['gone', 'later']);
    expect([...dependentsOf(tasks, run, 'check')]).toEqual([]);
  });

  it('reaches the task itself and everything standing on it', () => {
    expect([...revertReach('b', tasks, null)].sort()).toEqual(['b', 'c', 'check']);
  });

  it('keeps every link a task ever had, a plan edit taking none off', () => {
    const run = runOf();
    keepLandedOn(run, 'c', ['a', 'b']);
    keepLandedOn(run, 'c', ['b', 'x']);
    expect(run.landedOn).toEqual({ c: ['a', 'b', 'x'] });
  });
});

describe('forgetReverted', () => {
  it('drops a landed record, ends a conflict as kept, lets the ledger go of each and marks the run', () => {
    const conflict: IsolationTaskRecord = { ...record('t2', 'conflict'), conflictRepo: '.', conflictFiles: ['a.ts'], repairBase: { '.': 'x' }, repairs: 1 };
    const run = runOf({
      tasks: { t1: record('t1'), t2: conflict, t3: record('t3', 'kept'), t4: record('t4') },
      landings: { t1: { '.': ['a'] }, t2: { '.': ['b'] }, t4: { '.': ['d'] } },
      landedTasks: { t1: { taskId: 't1', order: 1, title: 'Task t1' }, gone: { taskId: 'gone', order: 9, title: 'Gone' } },
      landedOn: { t1: [], gone: ['t1'] },
      carried: { t5: { '.': ['c'] } },
    });
    expect(hasReverted(run)).toBe(false);
    forgetReverted(run, ['t1', 't2', 't3', 'gone']);
    expect(Object.keys(run.tasks).sort()).toEqual(['t2', 't3', 't4']);
    expect(run.tasks.t2).toEqual({ ...record('t2', 'kept'), repairs: 1 });
    expect(run.tasks.t3.status).toBe('kept');
    expect(run.landings).toEqual({ t4: { '.': ['d'] } });
    expect(run.landedTasks).toEqual({});
    expect(run.landedOn).toEqual({});
    expect(run.carried).toEqual({ t5: { '.': ['c'] } });
    expect(hasReverted(run)).toBe(true);
  });

  it('marks a run reverted even when it kept no ledger', () => {
    const run = olderRun();
    forgetReverted(run, []);
    expect(run.reverted).toBe(true);
  });
});
