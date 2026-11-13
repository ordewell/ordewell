import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import type { LoopSubject } from '../../models/Loop';
import { LOOP_OUT_OF_ROUNDS, LOOP_PASSED } from '../../models/SkipOrigin';
import {
  afterFailure, checkStart, closedByEdit, closingSkips, LoopRounds, repeatDue,
  type AfterFailure, type CheckStart, type LoopRoundsHost, type RepeatingWait, type RoundSubject,
} from '../LoopRounds';
import type { StartWait } from '../readiness';

const FOUND_WANTING = { outcome: 'fail', reported: 'failed' } as const;
const NOBODY_AT_WORK = (): boolean => false;

/** A loop's check that found the work wanting in `round` of `maxRounds`. */
function failedCheck(round: number, maxRounds = 3, body = ['b1', 'b2']): RoundSubject {
  return { id: 'c', title: 'Check', status: 'failed', loop: { body, maxRounds }, loopRound: round, verdict: FOUND_WANTING };
}

function body(id: string, over: Partial<RoundSubject> = {}): RoundSubject {
  return { id, title: `Fix ${id}`, status: 'completed', ...over };
}

describe('afterFailure', () => {
  const ROWS: ReadonlyArray<[string, RoundSubject, RoundSubject[], AfterFailure['kind']]> = [
    ['a task with no loop', { id: 'c', title: 'Check', status: 'failed', verdict: FOUND_WANTING }, [], 'failure'],
    ['a check that could not run (ADR-0045 L2)', { ...failedCheck(1), verdict: { outcome: 'fail', reported: 'blocked' } }, [body('b1')], 'failure'],
    ['a check whose runner reported nothing', { ...failedCheck(1), verdict: { outcome: 'fail' } }, [body('b1')], 'failure'],
    ['a check that failed its last round', failedCheck(3), [body('b1')], 'out-of-rounds'],
    ['a check past its rounds after an edit lowered them', failedCheck(3, 2), [body('b1')], 'out-of-rounds'],
    ['a body task the user skipped (L7)', failedCheck(1), [body('b1', { status: 'skipped', skipOrigin: 'user' })], 'stopped'],
    ['a body task the supervisor skipped (L7)', failedCheck(1), [body('b1', { status: 'skipped', skipOrigin: 'supervisor' })], 'stopped'],
    ['a body task its own loop skipped', failedCheck(1), [body('b1', { status: 'skipped', skipOrigin: 'loop' })], 'round'],
    ['rounds left and the body passed', failedCheck(2), [body('b1'), body('b2')], 'round'],
  ];
  for (const [label, check, rows, kind] of ROWS) {
    it(`${label}: ${kind}`, () => {
      expect(afterFailure(check, rows, NOBODY_AT_WORK).kind).toBe(kind);
    });
  }

  it('reruns every repeatable body task that is not at work, reverted or waiting on the user', () => {
    const rows = [
      body('done'),
      body('failed', { status: 'failed' }),
      body('pending', { status: 'pending' }),
      body('skipped', { status: 'skipped', skipOrigin: 'loop' }),
      body('running', { status: 'running' }),
      body('awaiting', { status: 'awaiting_user' }),
      body('busy'),
      body('reverted', { status: 'pending', reverted: true }),
    ];
    const decision = afterFailure(failedCheck(1, 3, rows.map((r) => r.id)), rows, (id) => id === 'busy');
    expect(decision).toMatchObject({ kind: 'round', reruns: ['done', 'failed', 'pending', 'skipped'] });
  });

  it.each<[string, RoundSubject[], string]>([
    ['one fix', [body('b1')], 'Task "Check" failed round 1 of 3: "Fix b1" runs to fix what it found, then it checks again.'],
    ['two fixes', [body('b1'), body('b2')], 'Task "Check" failed round 1 of 3: "Fix b1" and "Fix b2" run to fix what it found, then it checks again.'],
    ['a fix and a reverted one', [body('b1'), body('b2', { reverted: true })], 'Task "Check" failed round 1 of 3: "Fix b1" runs to fix what it found, then it checks again. "Fix b2" was reverted, so the loop waits for you to start it again.'],
    ['only reverted ones', [body('b1', { reverted: true }), body('b2', { reverted: true })], 'Task "Check" failed round 1 of 3: "Fix b1" and "Fix b2" were reverted, so the loop waits for you to start them again.'],
  ])('says what a round runs: %s', (_label, rows, message) => {
    const decision = afterFailure(failedCheck(1), rows, NOBODY_AT_WORK);
    expect(decision.kind === 'round' && decision.message).toBe(message);
  });
});

describe('closingSkips (ADR-0045 L6)', () => {
  it('skips what of the body has not run or did not pass, and leaves what passed, was skipped or is at work', () => {
    const rows: LoopSubject[] = ['pending', 'approved', 'failed', 'completed', 'skipped', 'running', 'awaiting_user']
      .map((status) => ({ id: status, status }));
    rows.push({ id: 'busy', status: 'pending' });
    expect(closingSkips(rows, (id) => id === 'busy')).toEqual(['pending', 'approved', 'failed']);
  });
});

describe('closedByEdit (ADR-0045 L6)', () => {
  const ROWS: ReadonlyArray<[string, LoopSubject | undefined, LoopSubject, boolean]> = [
    ['a lowered round limit', failedCheck(2, 3), failedCheck(2, 2), true],
    ['a loop given to a check that had outrun it', { ...failedCheck(2), loop: undefined }, failedCheck(2, 2), true],
    ['a check new to the plan, already out of rounds', undefined, failedCheck(3), true],
    ['a check out of rounds before the edit too', failedCheck(3), failedCheck(3), false],
    ['a raised round limit', failedCheck(3, 3), failedCheck(3, 4), false],
    ['a check between rounds still', failedCheck(1), failedCheck(1), false],
  ];
  for (const [label, before, after, closes] of ROWS) {
    it(`${label}: ${closes ? 'closes' : 'leaves it'}`, () => {
      expect(closedByEdit(before ? [before] : [], [after])).toEqual(closes ? ['c'] : []);
    });
  }
});

describe('repeatDue (ADR-0045 L5)', () => {
  const ROWS: ReadonlyArray<[boolean, boolean, boolean, boolean]> = [
    // driven, atWork, bodyLanded → due
    [true, false, true, true],
    [false, false, true, false],
    [true, true, true, false],
    [true, false, false, false],
  ];
  for (const [driven, atWork, bodyLanded, due] of ROWS) {
    it(`driven ${driven}, at work ${atWork}, body landed ${bodyLanded}: ${due ? 'due' : 'not due'}`, () => {
      expect(repeatDue(failedCheck(1), { driven, atWork, bodyLanded })).toBe(due);
    });
  }

  it('is never due for a task with no loop', () => {
    expect(repeatDue({ id: 'c', status: 'failed' }, { driven: true, atWork: false, bodyLanded: true })).toBe(false);
  });
});

describe('checkStart (ADR-0045 L5, L7)', () => {
  const landed: RepeatingWait = { kind: 'repeating', round: 2, maxRounds: 3, waiting: [] };
  const unlanded: RepeatingWait = { kind: 'repeating', round: 2, maxRounds: 3, waiting: ['b1'] };
  const ROWS: ReadonlyArray<[string, RepeatingWait | undefined, boolean, CheckStart]> = [
    ['not between rounds', undefined, false, { kind: 'own' }],
    ['not between rounds, in a run', undefined, true, { kind: 'own' }],
    ['between rounds in a run, fix landed', landed, true, { kind: 'loop-runs-it', wait: landed }],
    ['between rounds in a run, fix unlanded', unlanded, true, { kind: 'loop-runs-it', wait: unlanded }],
    ['between rounds with no run, fix unlanded', unlanded, false, { kind: 'fix-unlanded', wait: unlanded }],
    ['between rounds with no run, fix landed', landed, false, { kind: 'next-round', wait: landed }],
  ];
  for (const [label, wait, runsOn, start] of ROWS) {
    it(`${label}: ${start.kind}`, () => {
      expect(checkStart(wait, runsOn)).toEqual(start);
    });
  }
});

const task = (id: string, over: Partial<Task> = {}): Task =>
  createTask({ id, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });

/** A plan of a check `c` and its body `b1`, `b2`, behind a host whose facts each test sets. */
function harness(check: Partial<Task> = {}, bodies: Partial<Record<'b1' | 'b2', Partial<Task>>> = {}) {
  const tasks = [
    task('b1', { status: 'completed', ...bodies.b1 }),
    task('b2', { status: 'completed', ...bodies.b2 }),
    task('c', {
      title: 'Check', status: 'failed', dependencies: ['b1', 'b2'], loop: { body: ['b1', 'b2'], maxRounds: 3 },
      loopRound: 1, verdict: { ...FOUND_WANTING, reason: 'wanting', checks: [], decidedAt: '' }, ...check,
    }),
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const said: string[] = [];
  const skipped: [string, string][] = [];
  const started: string[] = [];
  const facts = { scheduling: false, scheduledRun: false, atWork: new Set<string>(), unlanded: new Set<string>(), waits: [] as StartWait[] };
  const retry = (id: string): void => {
    const t = byId.get(id);
    if (!t) return;
    t.status = 'pending';
    delete t.verdict;
  };
  const host: LoopRoundsHost = {
    store: {
      get: (id) => byId.get(id),
      allTasks: tasks,
      planTasks: tasks,
      retry,
      repeat: (id) => {
        const t = byId.get(id);
        if (!t) return;
        const round = (t.loopRound ?? 1) + 1;
        retry(id);
        t.loopRound = round;
      },
      startRoundsOver: (id) => { delete byId.get(id)?.loopRound; },
      isFailed: (id) => byId.get(id)?.status === 'failed',
    },
    atWork: (id) => facts.atWork.has(id),
    scheduling: () => facts.scheduling,
    scheduledRun: () => facts.scheduledRun,
    landed: (id) => byId.get(id)?.status === 'completed' && !facts.unlanded.has(id),
    startWaits: () => facts.waits,
    roundStarted: (id) => { started.push(id); },
    skip: (id, reason) => {
      skipped.push([id, reason]);
      const t = byId.get(id);
      if (t) t.status = 'skipped';
    },
    tell: (message) => { said.push(message); },
    info: (message) => { said.push(message); },
  };
  return { rounds: new LoopRounds(host), byId, facts, said, skipped, started };
}

const LANDED_WAIT: StartWait = { kind: 'repeating', round: 2, maxRounds: 3, waiting: [] };
const UNLANDED_WAIT: StartWait = { kind: 'repeating', round: 2, maxRounds: 3, waiting: ['b1'] };

describe('LoopRounds: a failed check', () => {
  it('starts a round: reruns its body, says so, and the failure is the round\'s', () => {
    const { rounds, byId, said, started } = harness();
    expect(rounds.checkFailed('c', false)).toBe(true);
    expect(byId.get('b1')!.status).toBe('pending');
    expect(byId.get('b2')!.status).toBe('pending');
    expect(started).toEqual(['b1', 'b2']);
    expect(said).toEqual(['Task "Check" failed round 1 of 3: "Task b1" and "Task b2" run to fix what it found, then it checks again.']);
    expect(rounds.anyCarried).toBe(false);
  });

  it('carries the loop a run with no scheduler started (L5)', () => {
    const { rounds } = harness();
    rounds.checkFailed('c', true);
    expect(rounds.anyCarried).toBe(true);
    expect(rounds.runsOn('c')).toBe(true);
  });

  it('out of rounds, closes the loop: the body left undone ends skipped, and the failure is the task\'s', () => {
    const { rounds, skipped, said } = harness({ loopRound: 3 }, { b1: { status: 'failed' } });
    expect(rounds.checkFailed('c', true)).toBe(false);
    expect(skipped).toEqual([['b1', LOOP_OUT_OF_ROUNDS]]);
    expect(said).toEqual([]);
    expect(rounds.anyCarried).toBe(false);
  });

  it('stopped by a body task the user skipped (L7): the skip stands, and nothing runs again', () => {
    const { rounds, started, skipped } = harness({}, { b1: { status: 'skipped', skipOrigin: 'user' } });
    expect(rounds.checkFailed('c', true)).toBe(false);
    expect(started).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('a check gone from the plan is the task\'s failure', () => {
    const { rounds } = harness();
    expect(rounds.checkFailed('gone', true)).toBe(false);
  });
});

describe('LoopRounds: the close (ADR-0045 L6)', () => {
  it('skips the body left undone, leaves what is at work, and carries the loop no more', () => {
    const { rounds, byId, facts, skipped } = harness({}, { b1: { status: 'pending' }, b2: { status: 'pending' } });
    rounds.checkFailed('c', true);
    facts.atWork.add('b2');
    rounds.close(byId.get('c')!, LOOP_PASSED);
    expect(skipped).toEqual([['b1', LOOP_PASSED]]);
    expect(rounds.anyCarried).toBe(false);
  });

  it('closes the loops an edit left out of rounds, and names their checks', () => {
    const { rounds, byId, skipped } = harness({}, { b1: { status: 'failed' } });
    const before = [...byId.values()].map((t) => ({ ...t, loop: t.loop && { ...t.loop } }));
    byId.get('c')!.loop!.maxRounds = 1;
    expect(rounds.planEdited(before)).toEqual(['c']);
    expect(skipped).toEqual([['b1', LOOP_OUT_OF_ROUNDS]]);
  });

  it('an edit that leaves the rounds closes nothing', () => {
    const { rounds, byId, skipped } = harness();
    expect(rounds.planEdited([...byId.values()])).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe('LoopRounds: the repeat (ADR-0045 L5)', () => {
  it('runs the check again once its body has landed and a scheduler drives the plan, and hands the body the round before', () => {
    const { rounds, byId, facts, said, started } = harness({ outputSummary: { reviewReason: '', report: 'two bugs', logTail: '', capturedAt: '' } });
    facts.scheduling = true;
    expect(rounds.repeatDue()).toBe(true);
    expect(byId.get('c')).toMatchObject({ status: 'pending', loopRound: 2 });
    expect(started).toEqual(['c']);
    expect(rounds.previousRound('c')).toEqual({ round: 1, report: 'two bugs' });
    expect(said).toEqual(['The fix for task "Check" has landed: it checks again, round 2 of 3.']);
  });

  it('a carried loop repeats with no scheduler', () => {
    const { rounds, byId } = harness();
    rounds.checkFailed('c', true);
    for (const id of ['b1', 'b2']) byId.get(id)!.status = 'completed';
    expect(rounds.repeatDue()).toBe(true);
    expect(byId.get('c')!.loopRound).toBe(2);
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['nothing drives it', () => {}],
    ['a usage limit holds the scheduled run', (h) => { h.facts.scheduledRun = true; }],
    ['a body task has not landed', (h) => { h.facts.scheduling = true; h.facts.unlanded.add('b2'); }],
    ['the check is at work', (h) => { h.facts.scheduling = true; h.facts.atWork.add('c'); }],
    ['a body task the user skipped stopped it (L7)', (h) => { h.facts.scheduling = true; h.byId.get('b1')!.status = 'skipped'; h.byId.get('b1')!.skipOrigin = 'user'; }],
  ])('waits while %s', (_label, arrange) => {
    const h = harness();
    arrange(h);
    expect(h.rounds.repeatDue()).toBe(false);
    expect(h.byId.get('c')!.loopRound).toBe(1);
  });
});

describe('LoopRounds: what a start of the check does', () => {
  const ROWS: ReadonlyArray<[string, Partial<ReturnType<typeof harness>['facts']>, boolean, CheckStart['kind'], boolean]> = [
    // facts, carried → start, stranded
    ['not between rounds', { waits: [] }, false, 'own', false],
    ['between rounds in a scheduled run', { waits: [LANDED_WAIT], scheduledRun: true }, false, 'loop-runs-it', false],
    ['between rounds, carried', { waits: [UNLANDED_WAIT] }, true, 'loop-runs-it', false],
    ['between rounds with no run, fix unlanded', { waits: [UNLANDED_WAIT] }, false, 'fix-unlanded', true],
    ['between rounds with no run, fix landed', { waits: [LANDED_WAIT] }, false, 'next-round', true],
  ];
  for (const [label, facts, carried, kind, stranded] of ROWS) {
    it(`${label}: ${kind}${stranded ? ', stranded' : ''}`, () => {
      const h = harness();
      Object.assign(h.facts, facts);
      if (carried) h.rounds.checkFailed('c', true);
      expect(h.rounds.startOf(h.byId.get('c')!).kind).toBe(kind);
      expect(h.rounds.stranded('c')).toBe(stranded);
    });
  }

  it('a task with no loop starts as its own, whatever its waits say', () => {
    const h = harness();
    h.facts.waits = [LANDED_WAIT];
    expect(h.rounds.startOf(h.byId.get('b1')!)).toEqual({ kind: 'own' });
    expect(h.rounds.stranded('b1')).toBe(false);
    expect(h.rounds.stranded('gone')).toBe(false);
  });

  it('runs on with a scheduled run, held by a usage limit or not, or carried', () => {
    const h = harness();
    expect(h.rounds.runsOn('c')).toBe(false);
    h.facts.scheduledRun = true;
    expect(h.rounds.runsOn('c')).toBe(true);
  });
});

describe('LoopRounds: a force start of the check (ADR-0045 L5, L7)', () => {
  it('is its next round when nothing runs it and its fix has landed', () => {
    const h = harness();
    h.facts.waits = [LANDED_WAIT];
    h.rounds.forced('c');
    expect(h.byId.get('c')).toMatchObject({ status: 'pending', loopRound: 2 });
    expect(h.rounds.previousRound('c')).toEqual({ round: 1, report: undefined });
    expect(h.started).toEqual(['c']);
  });

  it.each<[string, Partial<ReturnType<typeof harness>['facts']>]>([
    ['its fix has not landed', { waits: [UNLANDED_WAIT] }],
    ['a run will run it', { waits: [LANDED_WAIT], scheduledRun: true }],
    ['it is not between rounds', { waits: [] }],
  ])('starts its rounds over when %s', (_label, facts) => {
    const h = harness({ loopRound: 2 });
    Object.assign(h.facts, facts);
    h.rounds.forced('c');
    expect(h.byId.get('c')!.loopRound).toBeUndefined();
    expect(h.started).toEqual([]);
  });

  it('leaves the rounds of a check that has not failed', () => {
    const h = harness({ status: 'pending', loopRound: 2 });
    h.rounds.forced('c');
    expect(h.byId.get('c')!.loopRound).toBe(2);
  });
});

describe('LoopRounds: the carried loops (ADR-0045 L5)', () => {
  it('carries nothing at first', () => {
    const h = harness();
    expect(h.rounds.anyCarried).toBe(false);
    expect(h.rounds.carriedOwed()).toEqual([]);
  });

  it('owes a carried loop while its check is between rounds or waits to start its round', () => {
    const h = harness();
    h.rounds.checkFailed('c', true);
    expect(h.rounds.carriedOwed()).toEqual(['c']);
    for (const id of ['b1', 'b2']) h.byId.get(id)!.status = 'completed';
    expect(h.rounds.repeatDue()).toBe(true);
    expect(h.byId.get('c')!.status).toBe('pending');
    expect(h.rounds.carriedOwed()).toEqual(['c']);
  });

  it('keeps carried, but owes nothing, a loop a body task the user stopped holds: its retry resumes it (L7)', () => {
    const h = harness();
    h.rounds.checkFailed('c', true);
    Object.assign(h.byId.get('b1')!, { status: 'skipped', skipOrigin: 'user' });
    expect(h.rounds.carriedOwed()).toEqual([]);
    expect(h.rounds.anyCarried).toBe(true);
    h.byId.get('b1')!.status = 'pending';
    expect(h.rounds.carriedOwed()).toEqual(['c']);
  });

  it('owes nothing for a carried check that lost its loop', () => {
    const h = harness();
    h.rounds.checkFailed('c', true);
    delete h.byId.get('c')!.loop;
    expect(h.rounds.carriedOwed()).toEqual([]);
    expect(h.rounds.anyCarried).toBe(false);
  });

  it('the run ending ends them', () => {
    const h = harness();
    h.rounds.checkFailed('c', true);
    h.rounds.runEnded();
    expect(h.rounds.anyCarried).toBe(false);
    expect(h.rounds.runsOn('c')).toBe(false);
  });

  it.each<[string, boolean, boolean, boolean]>([
    // edited, still a loop's check → carried
    ['an edit that keeps the loop', true, true, true],
    ['an edit that drops the loop', true, false, false],
    ['another plan', false, true, false],
  ])('a load, %s', (_label, edited, keepsLoop, carried) => {
    const h = harness();
    h.rounds.checkFailed('c', true);
    if (!keepsLoop) delete h.byId.get('c')!.loop;
    h.rounds.planLoaded(edited);
    // Read through the set itself: a check that lost its loop counts as carried by nothing else.
    expect(h.rounds.runsOn('c')).toBe(carried);
  });

  it('a load forgets the round before, edit or not', () => {
    const h = harness();
    h.facts.scheduling = true;
    h.rounds.repeatDue();
    expect(h.rounds.previousRound('c')).toBeDefined();
    h.rounds.planLoaded(true);
    expect(h.rounds.previousRound('c')).toBeUndefined();
  });
});
