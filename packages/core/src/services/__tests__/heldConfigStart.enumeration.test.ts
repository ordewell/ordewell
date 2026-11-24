import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IsolationMergeResult, IsolationRemoval, IsolationRun, IsolationTaskRecord } from '../../interfaces/IWorktreeIsolation';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';
import type { Session } from '../createSession';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { McpAttachTimeout } from '../harness/ordewellBinding';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, patient } from '../../testing';
import { closeSessions, makeSession, taskOf, testWorkspace } from './sessionTestKit';

/**
 * Who may replace a run a start was held in for configuration (ADR-0028,
 * ADR-0013), enumerated at the session over every caller, command, kind of
 * task started, way the configuration reached the user's branch, state of the
 * run and what its records still say of what it landed, and over sequences: a
 * person's command that starts no task in a worktree, then each start a model
 * or Ordewell makes by itself, after a held start that dropped the only
 * landed record or not.
 * The isolation is a fake, so no start is truly held: what is observed is the
 * decision the hold follows from, whether the run is replaced by one from
 * HEAD (no hold) or continued (held again, as the real-git tests in
 * heldConfigStart*.e2e show). The held task is left as a hold leaves it: its
 * start refused before its runner, which holds it out of the scheduler, and
 * its record kept `active` with nothing in it.
 *
 * The expected outcome is computed from the rules:
 * - Rule 1: git says the user's branch holds everything the run landed (any
 *   merge, by anyone, or by hand) and nothing is live in it, whatever its
 *   records say: one a held start dropped, or a revert took, changes nothing.
 * - Rule 2: the start that decides the run is a person's own, of a task in a
 *   worktree whose launch the configuration check reads, and nothing else.
 */

afterEach(closeSessions);

const WHO = {
  user: { kind: 'user' },
  planner: { kind: 'planner-turn' },
  autorun: { kind: 'autorun' },
  supervisor: { kind: 'supervisor', level: 'act' },
} as const satisfies Record<string, ExecutionActor>;
type Who = keyof typeof WHO;
const COMMANDS = ['run_plan', 'run_task', 'force_start', 'retry_fresh', 'continue', 'mark_not_done_then_run_task', 'approve_review'] as const;
type Command = typeof COMMANDS[number];
/** What the command starts: the held task, another task in a worktree, or only an ops, read-only or script task. */
const STARTS = ['held', 'worktree', 'ops', 'readOnly', 'script'] as const;
type Starts = typeof STARTS[number];
const ROUTES = ['user-merge', 'supervisor-merge', 'auto-merge', 'by-hand', 'none'] as const;
type Route = typeof ROUTES[number];
/** `stopped`: the user's Stop; `closed`: a run of tasks started on their own, which closed itself; `open`: one a live task keeps open. */
const STATES = ['stopped', 'closed', 'open'] as const;
type RunState = typeof STATES[number];

/**
 * What the run's records still say of what it landed (the third review's F1
 * and F2). `record`: t1's landed record. `continued`: none, as the
 * supervisor's Continue of t1, held, replaced it with an `active` one, and
 * only the ledger and git still say t1 landed. `marked`: the same, by the
 * user's Mark not done of t1 and the planner's Start now of it, held.
 * `reverted`: t1's record, beside t7's landing, which the user reverted, so
 * the branch holds a revert no record names.
 */
const SHAPES = ['record', 'continued', 'marked', 'reverted'] as const;
type Shape = typeof SHAPES[number];

interface Case { who: Who; command: Command; starts: Starts; route: Route; state: RunState; shape: Shape }

const TARGET: Record<Starts, string> = { held: 't2', worktree: 't4', ops: 't3', readOnly: 't5', script: 't6' };

/**
 * What a case's command acts on. A held task has never run, so it has no
 * saved session to continue and no completion to take back: those commands
 * take the task that landed the configuration, whose next attempt is held
 * the same way (the second review's L1 and L2). Where a held start of that
 * task dropped its record, it is the task held, and the one after it waits
 * for it.
 */
function targetOf(c: Pick<Case, 'command' | 'starts' | 'shape'>): string {
  if (c.starts === 'held' && (dropped(c.shape) || c.command === 'continue' || c.command === 'mark_not_done_then_run_task')) return 't1';
  return TARGET[c.starts];
}

/** Why a combination is refused before it starts anything; null when it can occur. */
function cannotOccur(c: Case): string | null {
  const userOnly = c.command === 'force_start' || c.command === 'mark_not_done_then_run_task' || c.command === 'approve_review';
  if (userOnly && c.who !== 'user') return 'a control only the user has';
  if (c.who === 'autorun' && c.command !== 'run_plan') return 'autorun only runs the plan';
  if (c.command === 'continue' && c.starts === 'script') return 'a script keeps no session to continue';
  if (c.command === 'mark_not_done_then_run_task' && c.state === 'open') return 'Mark not done waits for the run to stop';
  // ADR-0029: a model's retry of a failure needs a change; a script reads no note, so it is edited first.
  if (c.command === 'retry_fresh' && c.starts === 'script' && c.who !== 'user') return 'a model retries a failed script only once it has edited it';
  // A run kept open by a task started on its own neither ends nor has a scheduler reach a gate (heldConfigStart.e2e covers a gate's merge).
  if (c.route === 'auto-merge' && c.state === 'open') return 'automatic merging merges as a run ends, or at a gate a scheduler reaches';
  if (c.shape === 'marked' && c.state === 'open') return 'Mark not done waits for the run to stop';
  // Held again, t1 is not done, so there is nothing to mark not done.
  if (dropped(c.shape) && c.command === 'mark_not_done_then_run_task' && targetOf(c) === 't1') return 'a held task is not done';
  return null;
}

/** Whether a held start of t1 dropped its landed record, which only the ledger and git still speak for. */
const dropped = (shape: Shape) => shape === 'continued' || shape === 'marked';

/**
 * The tasks the command starts, by kind. A Run starts every task ready, and
 * the held one among them, since it begins the plan's run afresh and with it
 * lifts a hold a start that could not reach its runner left. An approval
 * starts what is ready and lifts no hold.
 */
function started(c: Case): Starts[] {
  if (c.command === 'run_plan') return ['held', c.starts];
  if (c.command === 'approve_review') return c.starts === 'held' ? [] : [c.starts];
  return [c.starts];
}

const inWorktree = (s: Starts) => s === 'held' || s === 'worktree';

function expectedReplaced(c: Case): boolean {
  const rule1 = c.route !== 'none' && c.state !== 'open';
  // Only an open run's own decision stands there: nothing in it decides again.
  const rule2 = c.who === 'user' && started(c).some(inWorktree) && c.state !== 'open';
  return rule1 && rule2;
}

/**
 * The fake as a held start leaves git: the release of a task whose start was
 * held keeps its record `active`, as a config hold keeps its worktree, and a
 * merge puts every tip in the user's branch.
 */
class HeldStartIsolation extends FakeWorktreeIsolation {
  readonly heldOnce = new Set<string>();
  override async release(run: IsolationRun, taskId: string, opts: { keep: boolean; record?: IsolationTaskRecord }): Promise<IsolationRemoval> {
    if (this.heldOnce.delete(taskId)) return { preserved: [], refused: [] };
    return super.release(run, taskId, opts);
  }
  override async mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
    const merged = await super.mergeIntoCheckedOut(run);
    if (merged.outcome === 'merged') this.branchHolds = true;
    return merged;
  }
}

const SCRIPT: Pick<Task, 'type' | 'commands'> = { type: 'script', commands: [['node', '-e', '0']] };

/**
 * t1 lands the configuration and t2, after it, is held. The tasks a case
 * starts otherwise need nothing: what a start decides never reads its
 * dependencies, and an ops or script task after t1 would wait at its merge
 * gate (ADR-0020) where the user's branch lacks t1's work. `only` keeps of
 * those the ones a case acts on, so a Run starts nothing it does not name.
 */
function plan(state: RunState, only: readonly string[] | null, readOnlyFirst = false, shape: Shape = 'record'): LegacyPlanState {
  const now = new Date().toISOString();
  const kept = (task: Task) => only === null || ['t1', 't2', 'keep', 't0', 't7'].includes(task.id) || only.includes(task.id);
  return {
    tasks: [
      // Ahead of every other task, a read-only one is the first a Run starts.
      ...(readOnlyFirst ? [createTask({ id: 't0', order: 0, title: 'Read the repository', prompt: 'read it', taskMode: 'plan', assignedRunner: 'claude-code' })] : []),
      createTask({ id: 't1', order: 1, title: 'Add a hook', prompt: 'add it' }),
      createTask({ id: 't2', order: 2, title: 'Check the hook', prompt: 'check it', dependencies: ['t1'] }),
      createTask({ id: 't3', order: 3, title: 'Run the hook', prompt: 'run it', ops: true }),
      createTask({ id: 't4', order: 4, title: 'Use the hook', prompt: 'use it' }),
      createTask({ id: 't5', order: 5, title: 'Read the hook', prompt: 'read it', taskMode: 'plan', assignedRunner: 'claude-code' }),
      createTask({ id: 't6', order: 6, title: 'Script the hook', ...SCRIPT }),
      ...(state === 'open' ? [createTask({ id: 'keep', order: 7, title: 'Keep the run open', prompt: 'keep going' })] : []),
      ...(shape === 'reverted' ? [createTask({ id: 't7', order: 8, title: 'Write beside the hook', prompt: 'write it' })] : []),
      createTask({ id: 't9', order: 9, title: 'Follow the hook', prompt: 'follow it', dependencies: ['t3'] }),
    ].filter(kept),
    generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now,
  };
}

/**
 * A runner whose sessions finish at once, but for those `hold` keeps until
 * {@link release}, and those `fail` fails once; `refuse` refuses a task's
 * first attach, which holds its start as a start that cannot reach its
 * runner is held.
 */
function runners() {
  const hold = new Set<string>();
  const fail = new Set<string>();
  const refuse = new Set<string>();
  const waiting = new Map<string, () => void>();
  const make = (): IRunner => ({
    spawn: vi.fn(async (opts) => {
      if (refuse.delete(opts.taskId)) throw new McpAttachTimeout('the runner never connected');
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      const failing = fail.delete(opts.taskId);
      const finish = () => session.reportComplete(failing ? { status: 'blocked', summary: 'Not done.', reason: 'It failed.' } : { status: 'done', summary: 'Done.' });
      if (hold.delete(opts.taskId)) waiting.set(opts.taskId, finish);
      else setTimeout(finish, 1);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  });
  return { runner: make(), scriptRunner: make(), hold, fail, refuse, release: (id: string) => waiting.get(id)?.() };
}

async function ok(session: Session, command: Parameters<Session['execute']>[0], actor: ExecutionActor = WHO.user) {
  const outcome = await session.execute(command, actor);
  expect(outcome, `${command.command}: ${outcome.message}`).toMatchObject({ ok: true });
}

const statusOf = (session: Session, id: string) => taskOf(session, id)?.status;
const WAIT = { timeout: patient(5_000), interval: 2 };

/**
 * The world a case's command meets: t1 landed the configuration; the case's
 * target done, failed or not started, as its command needs; t2's start held,
 * its record left `active`; t7's landing reverted, in the `reverted` shape;
 * the configuration brought into the user's branch by the case's route; the
 * run stopped, closed or kept open; and then, in the `continued` and `marked`
 * shapes, t1's landed record dropped by a start of t1 that is held.
 */
async function world(c: Case, { readOnlyFirst = false, every = false } = {}) {
  const isolation = new HeldStartIsolation();
  isolation.unlandedWork = new Set();
  const r = runners();
  const session = makeSession({
    runner: r.runner, scriptRunner: r.scriptRunner, isolation, config: fakeConfig({ worktreeIsolation: true, autonomousMode: true, maxParallelSessions: 8 }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', mergeAtGatesAutomatically: c.route === 'auto-merge' } }),
  });
  const target = targetOf(c);
  session.loadPlan(plan(c.state, every ? null : [target], readOnlyFirst, c.shape), 'goal', testWorkspace, { persist: false });

  // t1 runs while the rest is set up, so t2's held start comes in the run t1 lands in, before that run can close and be cleared up.
  r.hold.add('t1');
  await ok(session, { command: 'run_task', task: 't1' });
  if (c.state === 'open') {
    r.hold.add('keep');
    await ok(session, { command: 'run_task', task: 'keep' });
  }
  if (c.shape === 'reverted') {
    await ok(session, { command: 'run_task', task: 't7' });
    await vi.waitFor(() => expect(statusOf(session, 't7')).toBe('completed'), WAIT);
  }
  if (target !== 't1' && target !== 't2' && (c.command === 'continue' || c.command === 'mark_not_done_then_run_task' || c.command === 'retry_fresh')) {
    if (c.command === 'retry_fresh') r.fail.add(target);
    await ok(session, { command: 'run_task', task: target });
    await vi.waitFor(() => expect(statusOf(session, target)).toBe(c.command === 'retry_fresh' ? 'failed' : 'completed'), WAIT);
  }
  isolation.heldOnce.add('t2');
  r.refuse.add('t2');
  await ok(session, { command: 'force_start', task: 't2' });
  r.release('t1');
  await vi.waitFor(() => expect(session.runSnapshot().tasks.find((t) => t.id === 't2')?.holdReason).toBeTruthy(), WAIT);
  expect(session.planState?.isolation?.run.tasks).toMatchObject({ t1: { status: 'merged' }, t2: { status: 'active' } });
  if (c.shape === 'reverted') {
    await ok(session, { command: 'revert_task', task: 't7', confirmed: true, seen: ['t7'] });
    expect(session.planState?.isolation?.run).toMatchObject({ reverted: true, tasks: { t1: { status: 'merged' } } });
  }

  if (c.route === 'user-merge') await ok(session, { command: 'merge_all' });
  if (c.route === 'supervisor-merge') await ok(session, { command: 'merge_all' }, WHO.supervisor);
  // By hand, the user merges the whole integration branch, as Merge all does.
  if (c.route === 'by-hand') { for (const id of Object.keys(session.planState?.isolation?.run.tasks ?? {})) isolation.mergedByHand.add(id); isolation.branchHolds = true; }
  if (c.route === 'auto-merge') await vi.waitFor(() => expect(isolation.branchHolds).toBe(true), WAIT);
  if (c.state === 'stopped') await ok(session, { command: 'stop_run' });
  if (dropped(c.shape)) await dropLanded(session, isolation, r, c.shape);
  if (c.command === 'mark_not_done_then_run_task') await ok(session, { command: 'mark_not_done', task: target, confirmed: true, seen: 'completed' });
  return { session, isolation, r, runs: () => isolation.calls.filter((call) => call.op === 'startRun').length };
}

/**
 * A start of t1 that is held, as its worktree is cut from a tip that holds
 * the configuration it landed: its record goes `active`, and only the ledger
 * and git still say t1 landed. The supervisor's Continue, or the user's Mark
 * not done and then the planner's Start now: no start a model makes decides
 * to replace a run, so the run it comes in is the run held.
 */
async function dropLanded(session: Session, isolation: HeldStartIsolation, r: Runners, shape: 'continued' | 'marked') {
  const run = session.planState?.isolation?.run;
  isolation.heldOnce.add('t1');
  r.refuse.add('t1');
  if (shape === 'continued') await ok(session, { command: 'retry_task', task: 't1', from: 'session', message: 'go on' }, WHO.supervisor);
  else {
    await ok(session, { command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' });
    await ok(session, { command: 'run_task', task: 't1' }, WHO.planner);
  }
  await vi.waitFor(() => expect(session.runSnapshot().tasks.find((t) => t.id === 't1')?.holdReason).toBeTruthy(), WAIT);
  expect(session.planState?.isolation?.run).toBe(run);
  expect(run?.tasks.t1?.status).toBe('active');
  expect(run?.landings?.t1).toBeDefined();
}

/** The case's command, as its caller sends it. */
function commandOf(c: Case): Parameters<Session['execute']>[0] {
  const task = targetOf(c);
  switch (c.command) {
    case 'run_plan': return { command: 'run_plan' };
    case 'run_task': case 'mark_not_done_then_run_task': return { command: 'run_task', task };
    case 'force_start': return { command: 'force_start', task };
    // A model's retry of a failure carries its note, which its identical-retry guard asks for (ADR-0029); the user's takes none.
    case 'retry_fresh': return { command: 'retry_task', task, from: 'fresh', ...(c.who === 'user' ? {} : { message: 'Try it another way.' }) };
    case 'continue': return { command: 'retry_task', task, from: 'session', message: 'go on' };
    case 'approve_review': return { command: 'approve_review' };
  }
}

/** Whether the command's start decided the run: replaced by one from HEAD, or not. */
async function decides(c: Case): Promise<{ refused: string | null; replaced: boolean }> {
  const { session, runs } = await world(c);
  const before = runs();
  const outcome = await session.execute(commandOf(c), WHO[c.who]);
  if (!outcome.ok) return { refused: outcome.message, replaced: false };
  // Settled: every start it asked for has decided, or none will.
  await vi.waitFor(() => expect(session.runSnapshot().tasks.some((t) => t.status === 'in_progress' && t.id !== 'keep')).toBe(false), WAIT);
  return { refused: null, replaced: runs() > before };
}

const ALL: Case[] = SHAPES.flatMap((shape) => (Object.keys(WHO) as Who[]).flatMap((who) => COMMANDS.flatMap((command) => STARTS.flatMap((starts) => ROUTES.flatMap((route) => STATES.map((state) => ({ who, command, starts, route, state, shape })))))));

/** What a case is called; the `record` shape's names are the ones the table had before it had shapes. */
const nameOf = (shape: Shape, rest: string) => (shape === 'record' ? rest : `${shape}: ${rest}`);

describe('who replaces a run a start was held in for configuration (enumerated)', () => {
  it.each(ALL.filter((c) => cannotOccur(c) === null).map((c) => [nameOf(c.shape, `${c.who} ${c.command} of ${c.starts}, ${c.route}, ${c.state}`), c] as const))('%s', async (_name, c) => {
    const { refused, replaced } = await decides(c);
    expect({ refused, replaced }).toEqual({ refused: null, replaced: expectedReplaced(c) });
  });
});

/**
 * A person's command that starts no task in a worktree. Kept live where it
 * starts one, so the run it opens is still undecided when the next start
 * comes, as in the second review's C1. A command that needs a task waiting on
 * the user, a question or a usage limit (message_task, answer_approval,
 * answer_checkpoint, cancel_resume) starts nothing and opens no run, so it is
 * the Stop case here.
 */
const FIRSTS = {
  'stop': (s: Session) => ok(s, { command: 'stop_run' }),
  'merge again': (s: Session) => ok(s, { command: 'merge_all' }),
  'Start now of an ops task, kept running': (s: Session, r: Runners) => { r.hold.add('t3'); return ok(s, { command: 'run_task', task: 't3' }); },
  'Start now of an ops task, finished': (s: Session) => ok(s, { command: 'run_task', task: 't3' }),
  'force start of an ops task, kept running': (s: Session, r: Runners) => { r.hold.add('t3'); return ok(s, { command: 'force_start', task: 't3' }); },
  'Start now of a read-only task, kept running': (s: Session, r: Runners) => { r.hold.add('t5'); return ok(s, { command: 'run_task', task: 't5' }); },
  'Start now of a script task, kept running': (s: Session, r: Runners) => { r.hold.add('t6'); return ok(s, { command: 'run_task', task: 't6' }); },
  'skip of another task': (s: Session) => ok(s, { command: 'skip_task', task: 't4' }),
  'Mark not done of the task that landed': (s: Session) => ok(s, { command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' }),
  'Mark complete of another task': (s: Session) => ok(s, { command: 'mark_complete', task: 't4', confirmed: true, seen: 'pending' }),
} as const satisfies Record<string, (s: Session, r: Runners) => Promise<void>>;
type Runners = ReturnType<typeof runners>;

/**
 * Each start a model or Ordewell makes by itself, of `held`, the task whose
 * start the configuration holds. `drained` is a start queued behind t3 that
 * its finish makes, which waits on a first step that keeps t3 running.
 */
const SECONDS = {
  'planner run_task': (s: Session, _r: Runners, held: string) => ok(s, { command: 'run_task', task: held }, WHO.planner),
  'planner retry_task fresh': (s: Session, _r: Runners, held: string) => ok(s, { command: 'retry_task', task: held, from: 'fresh' }, WHO.planner),
  'supervisor run_task': (s: Session, _r: Runners, held: string) => ok(s, { command: 'run_task', task: held }, WHO.supervisor),
  'supervisor retry_task fresh': (s: Session, _r: Runners, held: string) => ok(s, { command: 'retry_task', task: held, from: 'fresh', message: 'Try it another way.' }, WHO.supervisor),
  'supervisor run_plan': (s: Session) => ok(s, { command: 'run_plan' }, WHO.supervisor),
  'autorun run_plan': (s: Session) => ok(s, { command: 'run_plan' }, WHO.autorun),
  'a queued start its dependency\'s finish makes': async (s: Session, r: Runners) => { await ok(s, { command: 'force_start', task: 't9' }); r.release('t3'); },
} as const satisfies Record<string, (s: Session, r: Runners, held: string) => Promise<void>>;

const keepsT3 = (first: keyof typeof FIRSTS) => first.includes('ops task, kept running');

const SEQUENCES = SHAPES.flatMap((shape) => (Object.keys(FIRSTS) as (keyof typeof FIRSTS)[])
  // Held again, t1 is not done, so there is nothing to mark not done.
  .filter((first) => !(dropped(shape) && first.startsWith('Mark not done')))
  .flatMap((first) => (Object.keys(SECONDS) as (keyof typeof SECONDS)[])
    // A queued start needs its dependency still running, which only those first steps leave.
    .filter((second) => !second.startsWith('a queued') || keepsT3(first))
    .flatMap((second) => (['user-merge', 'auto-merge', 'by-hand'] as const).flatMap((route) => (['stopped', 'closed'] as const).map((state) => ({ first, second, route, state, shape }))))));

/** Per second step, how many sequences it was the start that decided the run in: what makes the table more than a run of no-ops. */
const decidedBy = new Map<string, number>();

describe('a person\'s command that starts no task in a worktree, then a start a model or Ordewell makes (enumerated)', () => {
  it.each(SEQUENCES.map((q) => [nameOf(q.shape, `${q.first}, then ${q.second}; ${q.route}, ${q.state}`), q] as const))('%s: the run goes on', async (_name, q) => {
    const c: Case = { who: 'user', command: 'run_task', starts: 'held', route: q.route, state: q.state, shape: q.shape };
    const { session, isolation, r, runs } = await world(c, { every: true });
    // Marked not done, or held again, t1 holds back t2, and its own next attempt is the one held (the second review's L2).
    const held = q.first.startsWith('Mark not done') || dropped(q.shape) ? 't1' : 't2';
    const before = runs();
    const assessed = () => isolation.calls.filter((call) => call.op === 'isActive').length;
    await FIRSTS[q.first](session, r);
    const afterFirst = assessed();
    await SECONDS[q.second](session, r, held);
    if (q.second.startsWith('a queued')) await vi.waitFor(() => expect(statusOf(session, 't9')).toBe('completed'), WAIT);
    // Settled: whatever the second step started has decided the run.
    await vi.waitFor(() => expect(session.runSnapshot().tasks.some((t) => t.status === 'in_progress' && !['keep', 't3', 't5', 't6'].includes(t.id))).toBe(false), WAIT);
    if (assessed() > afterFirst) decidedBy.set(q.second, (decidedBy.get(q.second) ?? 0) + 1);
    expect({ replaced: runs() > before, askedGit: isolation.calls.some((call) => call.op === 'userBranchHolds') }).toEqual({ replaced: false, askedGit: false });
  });

  it('has each kind of second start decide the run in some sequence', () => {
    expect([...decidedBy.keys()].sort()).toEqual(Object.keys(SECONDS).sort());
  });
});

describe('a person\'s Run whose first start is a read-only task\'s', () => {
  it.each([
    ['run_plan', 'held'],
    ['approve_review', 'worktree'],
  ] as const)('%s still replaces the spent run, as it starts a task in a worktree too, though the read-only start decides it', async (command, starts) => {
    const { session, isolation, runs } = await world({ who: 'user', command, starts, route: 'user-merge', state: 'stopped', shape: 'record' }, { readOnlyFirst: true });
    const other = TARGET[starts];
    const before = runs();
    await ok(session, { command });
    await vi.waitFor(() => expect([statusOf(session, 't0'), statusOf(session, other)]).toEqual(['completed', 'completed']), WAIT);
    // The read-only task is the first start of the new run, so its start decided it.
    const minted = isolation.calls.map((call) => call.op).lastIndexOf('startRun');
    expect(isolation.calls.slice(minted).find((call) => call.op === 'prepare')).toEqual({ op: 'prepare', taskId: 't0' });
    expect(runs()).toBe(before + 1);
  });
});
