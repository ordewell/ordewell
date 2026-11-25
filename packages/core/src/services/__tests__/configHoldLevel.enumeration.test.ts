import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createTask, type Task } from '../../models/Task';
import { PlanStore } from '../PlanStore';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { SkillsService } from '../SkillsService';
import { Attempts, type AttemptEnded, type AttemptsDeps, type AttemptsHost } from '../Attempts';
import type { IsolationRunController, TaskRepo } from '../IsolationRunController';
import type { LandingOutcome } from '../Landing';
import { LocalWorktreeLease } from '../LocalWorktreeLease';
import { SlotPool } from '../SlotPool';
import type { IRunner } from '../../interfaces/IRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { linkPath } from '../worktreeLink';
import { FakeRunnerSession, removeDir } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/**
 * Which launches the configuration check holds and which go ahead with a
 * notice (ADR-0028), enumerated over every built-in runner, every mode its
 * manifest declares, both autonomy levels, every kind of attempt the check
 * reads, and where the difference sits: in a worktree's tree against the
 * run's base (git), in the checkout against the run's first look at it, or
 * in the `.claude` or `.opencode` a worktree links from the checkout. Each
 * case is one Attempts over real directories, the base case on real git, and
 * each is also run with no difference at all.
 *
 * The expected outcome is computed from the rule, not from the code:
 * - The check reads what main read: every kind but a read-only attempt, which
 *   a change task in its runner's read-only mode is (ADR-0046); an ops task,
 *   a repair and a delegated task keep their kind in any mode.
 * - It sees what the runner reads: a task in the checkout its checkout and
 *   what is linked from it, a task in a worktree its tree and its links.
 * - A launch it would hold goes ahead only when the level is Full and the
 *   mode the runner starts in is one its manifest tags for Full: the task's
 *   own, or for a delegated task's repair the level's (ADR-0055 D14). A
 *   delegated task's own start, a child plan, has no mode, so it is held.
 */

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const KINDS = ['change', 'carryOver', 'continuation', 'ops', 'opsContinuation', 'repair', 'delegated', 'delegatedRepair'] as const;
type Kind = typeof KINDS[number];
const WHERES = ['base', 'checkout', 'linked .claude', 'linked .opencode'] as const;
type Where = typeof WHERES[number];
/** What a case writes where it differs. */
const FILE: Record<Where, string> = {
  base: '.claude/settings.json',
  checkout: '.mcp.json',
  'linked .claude': '.claude/settings.json',
  'linked .opencode': '.opencode/agents/build.md',
};

interface Case { runner: string; mode: string; full: boolean; kind: Kind; where: Where; differs: boolean }

const inCheckout = (kind: Kind) => kind === 'ops' || kind === 'opsContinuation';
const delegatedTask = (kind: Kind) => kind === 'delegated' || kind === 'delegatedRepair';

function expected(c: Case): { held: boolean; notice: boolean } {
  const modes = BUILTIN_MANIFESTS.find((m) => m.name === c.runner)?.modes ?? [];
  const readOnlyMode = modes.find((m) => m.readOnly)?.id === c.mode;
  const checked = !(readOnlyMode && (c.kind === 'change' || c.kind === 'carryOver' || c.kind === 'continuation'));
  const seen = c.differs && (inCheckout(c.kind) ? c.where !== 'base' : c.where !== 'checkout');
  const launchMode = c.kind === 'delegatedRepair' ? modes.find((m) => (c.full ? m.autonomous : m.safe))?.id : c.mode;
  const unasked = c.full && c.kind !== 'delegated' && modes.some((m) => m.id === launchMode && m.autonomous === true);
  const found = checked && seen;
  return { held: found && !unasked, notice: found && unasked };
}

/** What beforeAll makes, which afterAll removes; a case removes its own as it ends. */
const shared: string[] = [];
const dir = (name: string, owner: string[] = shared) => {
  // Native, as git names a path: on Windows the JS realpath keeps the 8.3 short name of the temp folder.
  const made = realpathSync.native(mkdtempSync(join(tmpdir(), `ordewell-hold-level-${name}-`)));
  owner.push(made);
  return made;
};
const write = (root: string, file: string, body = '{}\n') => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
};

/**
 * The base case's repository: its checkout, and a worktree of it with
 * configuration its base lacks and one without; and the directory every
 * case's first launch runs in, which nothing writes to.
 */
let base: { root: string; baseRef: string; differs: string; clean: string };
let first: string;

beforeAll(() => {
  if (!hasGit) return;
  const root = dir('repo');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'README.md', 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  const baseRef = git(root, 'rev-parse', 'HEAD');
  const worktrees = dir('worktrees');
  const differs = join(worktrees, 'differs');
  const clean = join(worktrees, 'clean');
  git(root, 'worktree', 'add', '-q', '-b', 'differs', differs, baseRef);
  git(root, 'worktree', 'add', '-q', '-b', 'clean', clean, baseRef);
  write(differs, FILE.base);
  base = { root, baseRef, differs, clean };
  first = dir('first');
});

afterAll(async () => {
  while (shared.length) await removeDir(shared.pop()!);
});

/**
 * Where a case's tasks run: the checkout (the base case's repository, or one
 * of its own), the case task's worktree and a clean worktree for the first
 * launch, which takes the run's first look at the checkout. A linked case's
 * worktree links both roots from the checkout, as a worktree's bootstrap does.
 */
function places(c: Case, own: string[]): { root: string; worktree: string; first: string; repos: TaskRepo[] } {
  if (c.where === 'base') {
    const worktree = c.differs ? base.differs : base.clean;
    return { root: base.root, worktree, first, repos: [{ path: '.', root: base.root, baseRef: base.baseRef, worktree, branch: 'b', integrationBranch: 'i', linked: [] }] };
  }
  const root = dir('checkout', own);
  // Where the runner's directories end, as at a repository's top.
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, '.opencode'));
  const worktree = dir('worktree', own);
  if (c.where !== 'checkout') {
    linkPath(join(root, '.claude'), join(worktree, '.claude'), process.platform);
    linkPath(join(root, '.opencode'), join(worktree, '.opencode'), process.platform);
  }
  return { root, worktree, first, repos: [] };
}

const TITLE = 'Use the settings';

/** What a case can leave unreadable at the launch: the registry the runner's modes are read from, the task's mode, the node's level, the user's. */
interface Unread { registry?: null; noMode?: true; autonomous?: () => boolean; rootAutonomous?: () => boolean }

function taskOf(c: Case, unread: Unread): Task {
  const other = c.runner === 'claude-code' ? 'codex' : 'claude-code';
  const common = { id: 't1', order: 2, title: TITLE, assignedRunner: c.runner, ...(unread.noMode ? {} : { taskMode: c.mode }) };
  if (delegatedTask(c.kind)) return createTask({ ...common, type: 'delegated', goal: 'Use the settings', budget: { tokens: 100_000 } });
  return createTask({ ...common, prompt: 'use them', ...(inCheckout(c.kind) ? { ops: true } : {}), ...(c.kind === 'carryOver' ? { carriedFrom: other } : {}) });
}

/** One case: the first launch, the difference written, then the case task's launch. */
async function decide(c: Case, unread: Unread = {}): Promise<{ held: boolean; launched: boolean; notices: string[] }> {
  const own: string[] = [];
  try {
    return await decideIn(c, unread, places(c, own));
  } finally {
    // Removed as the case ends, so no hook has thousands to remove at once.
    while (own.length) await removeDir(own.pop()!);
  }
}

async function decideIn(c: Case, unread: Unread, where: ReturnType<typeof places>): Promise<{ held: boolean; launched: boolean; notices: string[] }> {
  const store = new PlanStore();
  store.load([createTask({ id: 't0', order: 1, title: 'First', prompt: 'first', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }), taskOf(c, unread)], [...new Set(['claude-code', c.runner])]);
  const spawned: string[] = [];
  const runner: IRunner = {
    spawn: vi.fn(async (o) => { spawned.push(o.taskId); return new FakeRunnerSession(`s${spawned.length}`, o.taskId, `native-${o.taskId}`); }),
    stop: vi.fn(async () => undefined), stopAll: vi.fn(), activeCount: 0,
  };
  const ended: AttemptEnded[] = [];
  const told: string[] = [];
  const host: AttemptsHost = {
    settle: async (outcome) => { ended.push(outcome); },
    completing: () => false, retried: () => false, previousRound: () => undefined,
    emit: () => undefined,
    tell: (level, message) => { if (level === 'warn') told.push(message); },
    unawaited: (work) => { void work.catch(() => undefined); },
  };
  const cwdOf = (task: Task) => (task.id === 't0' ? where.first : where.worktree);
  const runs: AttemptsDeps['runs'] & Pick<IsolationRunController, 'attemptCwd' | 'assertDecision' | 'workspaceCwd' | 'release' | 'repoRoots' | 'branchesOf' | 'recordedTasks'> = {
    assertDecision: () => undefined,
    attemptCwd: async (task) => ({ cwd: cwdOf(task), worktree: true }),
    workspaceCwd: async () => ({ cwd: where.root, worktree: false }),
    snapshotWorkspace: async () => null,
    filesChangedSince: async () => [],
    release: vi.fn(async () => undefined),
    openWorktreesOf: () => [],
    taskRepos: (taskId) => (taskId === 't1' ? where.repos : []),
    workspaceOf: (taskId) => (taskId === 't1' ? where.worktree : where.first),
    repoRoots: [],
    branchesOf: () => ({}),
    recordedTasks: () => [],
    skillLayout: () => ({ repos: [], worktrees: false }),
    inRepoGroup: false,
    inChildPlan: false,
    epoch: 1,
    stillToLetGo: async () => undefined,
  };
  const repairs = c.kind === 'repair' || c.kind === 'delegatedRepair';
  const landing: AttemptsDeps['landing'] = {
    nextRepair: (taskId) => (repairs && taskId === 't1' ? { n: 1, limit: 1 } : null),
    landPassed: vi.fn(async (): Promise<LandingOutcome> => ({ kind: 'nothing-to-land', messages: [] })),
    settleRepair: vi.fn(async (): Promise<LandingOutcome> => ({ kind: 'landed', messages: [] })),
    repairPrompt: () => 'Repair the conflict.',
    takeInMessage: (task) => `Merge: ${task.title} (take in landed work)`,
  };
  const leases = new LocalWorktreeLease({ pool: new SlotPool(() => Infinity), node: { tick: async () => undefined, openTurn: () => undefined, waitsOnPlanner: () => false, limitFound: () => undefined }, runs, workspaceRoot: () => where.root });
  const attempts = new Attempts({
    notifications: fakeNotification(), runner, scriptRunner: runner, childPlanRunner: runner,
    autonomous: unread.autonomous ?? (() => c.full),
    rootAutonomous: unread.rootAutonomous ?? (() => c.full),
    store, output: new BufferedTaskOutputSource(), runs, leases, landing,
    registry: unread.registry === null ? null : new RunnerRegistry(),
    workspaceRoot: () => where.root,
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    skillsAt: (roots) => new SkillsService(roots),
    previousAttemptFromLog: () => null, previousHandoffFromLog: () => undefined, lastLoggedAttempt: () => 0,
    recordHandoff: vi.fn(), taskLog: { attempts: () => [], events: () => [] },
    host,
  });
  const start = (taskId: string, continued: boolean) => {
    const reserved = leases.reserve({ node: { sessionId: 's' }, role: 'task' });
    if ('refused' in reserved) throw new Error(reserved.refused);
    return attempts.start(store.get(taskId)!, {
      admission: { current: () => true }, lease: reserved.lease, isolationDecision: { epoch: 1, mode: 'isolated' },
      ...(continued ? { continuation: { message: 'go on', resumeSessionId: 'native-t1' } } : {}),
    });
  };
  await start('t0', false);
  expect(spawned).toEqual(['t0']);
  if (c.differs && c.where !== 'base') write(where.root, FILE[c.where]);
  await start('t1', c.kind === 'continuation' || c.kind === 'opsContinuation');
  const failed = ended.find((e) => e.kind === 'spawn-failed' && e.task.id === 't1');
  const held = failed?.kind === 'spawn-failed' && failed.failure.leaves === 'held';
  // Nothing else may stop the start: a case that fails for another reason proves nothing.
  if (failed && !held) throw new Error(`t1 did not start: ${JSON.stringify(failed.kind === 'spawn-failed' ? failed.failure : failed)}`);
  attempts.stopAll();
  return { held: held === true, launched: spawned.includes('t1'), notices: told.filter((line) => line.startsWith(`Task "${TITLE}" starts with repository configuration `)) };
}

const CASES: Case[] = BUILTIN_MANIFESTS.flatMap((manifest) => (manifest.modes ?? []).flatMap((mode) => [false, true].flatMap((full) =>
  KINDS.flatMap((kind) => WHERES.flatMap((where) => [true, false].map((differs) => ({ runner: manifest.name, mode: mode.id, full, kind, where, differs })))))));

const nameOf = (c: Case) => `${c.runner} ${c.mode}, ${c.full ? 'Full' : 'Guarded'}, ${c.kind}, ${c.differs ? `differs in ${c.where}` : `nothing differs (${c.where})`}`;

describe.skipIf(!hasGit)('a launch held for configuration, by level and mode (enumerated)', () => {
  it.concurrent.each(CASES.map((c) => [nameOf(c), c] as const))('%s', async (_name, c) => {
    const outcome = await decide(c);
    const want = expected(c);
    expect({ held: outcome.held, launched: outcome.launched, notices: outcome.notices.length }).toEqual({ held: want.held, launched: !want.held, notices: want.notice ? 1 : 0 });
    if (want.notice) {
      expect(outcome.notices[0]).toContain(JSON.stringify(FILE[c.where]));
      expect(outcome.notices[0]).toContain('later tasks in Full load it without a hold');
    }
  });

  it('holds and lets through some launch of every runner and kind, so no dimension is a run of no-ops', () => {
    const outcomes = CASES.map((c) => ({ c, want: expected(c) }));
    for (const manifest of BUILTIN_MANIFESTS) {
      expect(outcomes.some(({ c, want }) => c.runner === manifest.name && want.held), manifest.name).toBe(true);
      expect(outcomes.some(({ c, want }) => c.runner === manifest.name && want.notice), manifest.name).toBe(true);
    }
    for (const kind of KINDS) expect(outcomes.some(({ c, want }) => c.kind === kind && want.held), kind).toBe(true);
    for (const kind of KINDS.filter((k) => k !== 'delegated')) expect(outcomes.some(({ c, want }) => c.kind === kind && want.notice), kind).toBe(true);
    for (const where of WHERES) expect(outcomes.some(({ c, want }) => c.where === where && want.notice), where).toBe(true);
  });
});

describe.skipIf(!hasGit)('a launch in Full whose level or mode cannot be read', () => {
  const differing: Case = { runner: 'claude-code', mode: 'bypassPermissions', full: true, kind: 'change', where: 'base', differs: true };
  const unreadable: Array<[string, Unread]> = [
    ['no registry to read the runner\'s modes from', { registry: null }],
    ['a task with no mode', { noMode: true }],
    ['a level that cannot be read', { autonomous: () => { throw new Error('unreadable'); } }],
    ['a user\'s level that cannot be read', { rootAutonomous: () => { throw new Error('unreadable'); } }],
  ];

  it.each(unreadable)('is held as the check says: %s', async (_name, unread) => {
    // The same launch with both facts read goes ahead, so what holds it is what could not be read.
    expect(await decide(differing)).toMatchObject({ held: false, launched: true, notices: [expect.any(String)] });
    expect(await decide(differing, unread)).toEqual({ held: true, launched: false, notices: [] });
  });

  it('is held where the node\'s mandate reads Full and the user\'s level is Guarded', async () => {
    // A child plan's mandate keeps the autonomy it opened with; the user's level is the one lowered since.
    expect(await decide(differing, { rootAutonomous: () => false })).toEqual({ held: true, launched: false, notices: [] });
  });
});
