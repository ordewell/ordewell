import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { discardChildRuns } from '../childRuns';
import { defaultExecFile } from '../gitExec';
import { LEASE_STALE_MS, LeaseHost } from '../sessionLease';
import type { Session, SessionDeps } from '../createSession';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation, IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession, removeDir } from '../../testing';
import { STATE_DIR_IGNORE } from '../../utils/fsHelpers';
import { deleteSession, listChildSessions, listSessions, loadChildSession, loadSession, saveChildSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, makeSession } from './sessionTestKit';

/*
 * A child run rooted in a delegated task's worktree (ADR-0055 D10, D11, D12),
 * against real repositories. Grown out of the probe that found a parent's prune
 * deleting a live child's worktree and a child's `.gitignore` swept into a landing.
 */

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
afterEach(async () => {
  await closeSessions();
  // Not rmSync: on Windows a stopped runner's tree is ended by taskkill, which
  // this process has to go on running to see through, and until it has, a
  // directory the runner works in cannot be removed.
  while (roots.length) await removeDir(roots.pop()!);
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-nested-')));
  roots.push(dir);
  return dir;
}

function repo(root: string, opts: { stateIgnoreCommitted?: boolean } = {}): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  if (opts.stateIgnoreCommitted) {
    mkdirSync(join(root, '.ordewell'), { recursive: true });
    writeFileSync(join(root, '.ordewell', '.gitignore'), STATE_DIR_IGNORE);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [] } as unknown as Task);
const isolation = (): IWorktreeIsolation => createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });

interface Nest {
  parent: IWorktreeIsolation;
  child: IWorktreeIsolation;
  parentRun: IsolationRun;
  childRun: IsolationRun;
  delegated: Task;
  /** The delegated task's worktree: the child's code root. */
  codeRoot: string;
}

async function nest(root: string): Promise<Nest> {
  const parent = isolation();
  // A tree works through one isolation, as `Session.hostChild` hands it down.
  const child = parent;
  const parentRun = await parent.startRun(root);
  const delegated = task(3, 'delegated subtree');
  const { cwd: codeRoot } = await parent.prepare(delegated, parentRun);
  const childRun = await child.startRun(codeRoot, root);
  return { parent, child, parentRun, childRun, delegated, codeRoot };
}

describe('a child run rooted in a delegated task\'s worktree', () => {
  const climb = async (root: string, landedFiles: string[]): Promise<void> => {
    const { parent, child, parentRun, childRun, delegated, codeRoot } = await nest(root);
    const leaf = task(1, 'leaf work');
    const { cwd: childCwd } = await child.prepare(leaf, childRun);
    writeFileSync(join(childCwd, 'leaf.txt'), 'leaf\n');
    expect(await child.integrate(leaf, childRun, () => undefined, { subject: 'Add the leaf' })).toBe('merged');
    await child.release(childRun, leaf.id, { keep: false });
    expect((await child.mergeIntoCheckedOut(childRun)).outcome).toBe('merged');
    expect(git(codeRoot, 'status', '--porcelain')).toBe('');
    await child.discard(childRun, { integration: 'delete' });

    expect(await parent.integrate(delegated, parentRun, () => undefined, { subject: 'Do the delegated subtree' })).toBe('merged');
    await parent.release(parentRun, delegated.id, { keep: false });
    expect(git(root, 'ls-tree', '-r', '--name-only', parentRun.repos[0].integrationBranch).split('\n')).toEqual(landedFiles);
    expect((await parent.mergeIntoCheckedOut(parentRun)).outcome).toBe('merged');
    expect(existsSync(join(root, 'leaf.txt'))).toBe(true);
  };

  it('climbs to the user\'s branch with the state ignore file untracked: a child writes nothing a landing could sweep', async () => {
    await climb(repo(tempDir()), ['.gitignore', 'README.md', 'leaf.txt']);
  });

  it('climbs with that file committed too', async () => {
    await climb(repo(tempDir(), { stateIgnoreCommitted: true }), ['.gitignore', '.ordewell/.gitignore', 'README.md', 'leaf.txt']);
  });

  it('keeps a child\'s worktrees under the state root, beside the parent\'s run and outside its worktree', async () => {
    const root = repo(tempDir());
    const { child, parentRun, childRun, codeRoot } = await nest(root);
    const { cwd } = await child.prepare(task(1, 'leaf work'), childRun);
    expect(relative(root, cwd)).toBe(join('.ordewell', 'worktrees', childRun.id, '1-leaf-work'));
    expect(cwd.startsWith(codeRoot)).toBe(false);
    expect(childRun.id).not.toBe(parentRun.id);
    expect(childRun).toMatchObject({ workspaceRoot: codeRoot, stateRoot: root });
    // D10: its base is the delegated task's branch, so Merge all means that branch.
    expect(childRun.repos[0].baseBranch).toBe(git(codeRoot, 'symbolic-ref', '--short', 'HEAD'));
    expect(childRun.repos[0].root).toBe(codeRoot);
    expect(existsSync(join(codeRoot, '.ordewell'))).toBe(false);
  });

  it('bootstraps a child\'s worktrees from the root\'s checkout, not from the links in the delegated task\'s worktree', async () => {
    const root = repo(tempDir());
    writeFileSync(join(root, '.env'), 'A=1\n');
    const { child, childRun } = await nest(root);
    const { cwd } = await child.prepare(task(1, 'leaf work'), childRun);
    // Windows links a file as a hard link (ADR-0010), the root's file itself, which a link in the delegated task's worktree also is.
    if (process.platform === 'win32') expect(statSync(join(cwd, '.env')).ino).toBe(statSync(join(root, '.env')).ino);
    else {
      expect(lstatSync(join(cwd, '.env')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(cwd, '.env'))).toBe(join(root, '.env'));
    }
  });

  it('leaves a live child alone when the parent prunes on reopen, unlanded work and all', async () => {
    const root = repo(tempDir());
    const { parentRun, childRun, child, delegated, codeRoot } = await nest(root);
    parentRun.tasks[delegated.id].childSession = 'session-child';
    const leaf = task(1, 'leaf work');
    const { cwd: childCwd } = await child.prepare(leaf, childRun);
    writeFileSync(join(childCwd, 'leaf.txt'), 'unlanded\n');

    const pruned = await isolation().pruneOrphans(parentRun);

    expect(pruned.kept.map((k) => k.taskId)).toEqual([delegated.id]);
    expect(parentRun.tasks[delegated.id].status).toBe('kept');
    expect(existsSync(join(childCwd, 'leaf.txt'))).toBe(true);
    expect(existsSync(codeRoot)).toBe(true);
    expect(git(childCwd, 'status', '--porcelain')).toBe('?? leaf.txt');
  });

  it('keeps a read-only delegated task\'s worktree for its child too, at every reopen', async () => {
    const root = repo(tempDir());
    const parent = isolation();
    const parentRun = await parent.startRun(root);
    const delegated = task(3, 'delegated subtree');
    const { cwd: codeRoot } = await parent.prepare(delegated, parentRun, 'fresh', { readOnly: true });
    parentRun.tasks[delegated.id].childSession = 'session-child';
    await isolation().pruneOrphans(parentRun);
    await isolation().pruneOrphans(parentRun);
    expect(existsSync(codeRoot)).toBe(true);
  });

  it('carries the child\'s name through a restore, which Continue reopens it by', async () => {
    const root = repo(tempDir());
    const parent = isolation();
    const parentRun = await parent.startRun(root);
    const delegated = task(3, 'delegated subtree');
    await parent.prepare(delegated, parentRun);
    parentRun.tasks[delegated.id].childSession = 'session-child';
    await parent.prepare(delegated, parentRun, 'restore');
    expect(parentRun.tasks[delegated.id].childSession).toBe('session-child');
    await parent.prepare(delegated, parentRun, 'fresh');
    expect(parentRun.tasks[delegated.id].childSession).toBeUndefined();
  });

  it('sweeps nothing from a child\'s HEAD: a sibling just started has no worktree yet, and its branch reads as merged there', async () => {
    const root = repo(tempDir());
    const { parent, parentRun, child, childRun, codeRoot } = await nest(root);
    const sibling = await parent.prepare(task(4, 'sibling'), parentRun);
    const siblingRun = await isolation().startRun(sibling.cwd, root);
    const before = git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell/');
    expect(before).toContain(siblingRun.repos[0].integrationBranch);

    await child.sweep(childRun);

    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell/')).toBe(before);
    expect(existsSync(codeRoot)).toBe(true);
  });

  it('still sweeps from the root what a child left merged in the user\'s branch', async () => {
    const root = repo(tempDir());
    const { parent, parentRun, child, childRun, delegated, codeRoot } = await nest(root);
    const leaf = task(1, 'leaf work');
    const { cwd } = await child.prepare(leaf, childRun);
    writeFileSync(join(cwd, 'leaf.txt'), 'leaf\n');
    await child.integrate(leaf, childRun, () => undefined, { subject: 'Add the leaf' });
    await child.release(childRun, leaf.id, { keep: false });
    await child.mergeIntoCheckedOut(childRun);
    await child.handoff(childRun);
    expect(existsSync(join(codeRoot, 'leaf.txt'))).toBe(true);
    await parent.integrate(delegated, parentRun, () => undefined, { subject: 'Do it' });
    await parent.release(parentRun, delegated.id, { keep: false });
    await parent.mergeIntoCheckedOut(parentRun);

    await isolation().sweep(await isolation().startRun(root));

    expect(git(root, 'for-each-ref', '--format=%(refname)', `refs/heads/ordewell/${childRun.id}/`)).toBe('');
  });

  it('isolates a repo group nested in a delegated task\'s workspace, each repo landing on its own task branch', async () => {
    const root = tempDir();
    repo(join(root, 'api'));
    repo(join(root, 'web'));
    writeFileSync(join(root, 'notes.md'), 'loose\n');
    const { parent, child, parentRun, childRun, delegated, codeRoot } = await nest(root);
    expect(childRun.repos.map((r) => r.path)).toEqual(['api', 'web']);
    expect(childRun.shared).toEqual(['notes.md']);
    const leaf = task(1, 'leaf work');
    const { cwd } = await child.prepare(leaf, childRun);
    expect(relative(root, cwd)).toBe(join('.ordewell', 'worktrees', childRun.id, '1-leaf-work'));
    writeFileSync(join(cwd, 'api', 'leaf.txt'), 'leaf\n');
    expect(await child.integrate(leaf, childRun, () => undefined, { subject: 'Add the leaf' })).toBe('merged');
    await child.release(childRun, leaf.id, { keep: false });
    expect((await child.mergeIntoCheckedOut(childRun)).outcome).toBe('merged');
    expect(existsSync(join(codeRoot, '.ordewell'))).toBe(false);
    await child.discard(childRun, { integration: 'delete' });
    expect(await parent.integrate(delegated, parentRun, () => undefined, { subject: 'Do it' })).toBe('merged');
    await parent.release(parentRun, delegated.id, { keep: false });
    expect((await parent.mergeIntoCheckedOut(parentRun)).outcome).toBe('merged');
    expect(existsSync(join(root, 'api', 'leaf.txt'))).toBe(true);
  });

  it('reads a child task\'s diff, whose worktree is outside the child\'s code root', async () => {
    const root = repo(tempDir());
    const { child, childRun } = await nest(root);
    const leaf = task(1, 'leaf work');
    const { cwd } = await child.prepare(leaf, childRun);
    writeFileSync(join(cwd, 'README.md'), 'changed\n');
    const read = await child.taskDiff!(childRun, leaf.id, {});
    expect(read.available).toBe(true);
  });
});

describe('only the root touches the user\'s branch (ADR-0055 D12)', () => {
  it('refuses a child run whose code root is the user\'s checkout', async () => {
    const root = repo(tempDir());
    await expect(isolation().startRun(root, root)).rejects.toThrow('never in the user\'s checkout');
    expect(existsSync(join(root, '.ordewell'))).toBe(false);
  });

  it('refuses a child run in another directory of the checkout', async () => {
    const root = repo(tempDir());
    mkdirSync(join(root, 'packages'));
    await expect(isolation().startRun(join(root, 'packages'), root)).rejects.toThrow('never in the user\'s checkout');
  });

  it('refuses to merge a saved child run that names the user\'s checkout, and leaves that branch where it was', async () => {
    const root = repo(tempDir());
    const parent = isolation();
    const run = await parent.startRun(root);
    const leaf = task(1, 'leaf work');
    const { cwd } = await parent.prepare(leaf, run);
    writeFileSync(join(cwd, 'leaf.txt'), 'leaf\n');
    await parent.integrate(leaf, run, () => undefined, { subject: 'Add the leaf' });
    await parent.release(run, leaf.id, { keep: false });
    const head = git(root, 'rev-parse', 'HEAD');

    const merged = await isolation().mergeIntoCheckedOut({ ...run, stateRoot: root });

    expect(merged).toMatchObject({ outcome: 'failed', error: expect.stringContaining('never in the user\'s checkout') });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });
});

describe('deleting a root (ADR-0055 D11)', () => {
  const branches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');

  /** A child's run, its record saved under the root, with `leaf` landed and `open` still in its worktree. */
  async function saved(root: string, childId = 'session-child'): Promise<Nest & { openCwd: string }> {
    const nested = await nest(root);
    const leaf = task(1, 'leaf work');
    const { cwd } = await nested.child.prepare(leaf, nested.childRun);
    writeFileSync(join(cwd, 'leaf.txt'), 'landed\n');
    await nested.child.integrate(leaf, nested.childRun, () => undefined, { subject: 'Add the leaf' });
    await nested.child.release(nested.childRun, leaf.id, { keep: false });
    const { cwd: openCwd } = await nested.child.prepare(task(2, 'open work'), nested.childRun);
    writeFileSync(join(openCwd, 'open.txt'), 'unlanded\n');
    saveChildSession(planOf([{ ...task(1, 'leaf work') }]), 'a sub goal', { baseDir: root, rootSessionId: ROOT_SESSION, sessionId: childId });
    const plan = loadChildSession({ baseDir: root, rootSessionId: ROOT_SESSION, sessionId: childId })!.plan;
    plan.isolation = { run: nested.childRun, resolvers: {} };
    saveChildSession(plan, 'a sub goal', { baseDir: root, rootSessionId: ROOT_SESSION, sessionId: childId });
    return { ...nested, openCwd };
  }

  it('discards each child\'s worktrees and branches first, keeping unlanded work as a discard does', async () => {
    const root = repo(tempDir());
    saveSession(planOf([]), 'the root', root, ROOT_SESSION);
    const { childRun, openCwd } = await saved(root);

    const removal = await discardChildRuns(ROOT_SESSION, root, isolation());

    expect(removal.refused).toEqual([]);
    expect(removal.preserved.map((p) => p.branch)).toEqual([`ordewell-preserved/${childRun.id}/2-open-work`]);
    expect(existsSync(openCwd)).toBe(false);
    expect(existsSync(join(root, '.ordewell', 'worktrees', childRun.id))).toBe(false);
    expect(branches(root).filter((b) => b.startsWith(`ordewell/${childRun.id}/`))).toEqual([]);
    // The child's state stays for the delete that follows, which takes it with the root's.
    expect(deleteSession(ROOT_SESSION, root)).toBe(true);
    expect(listChildSessions(ROOT_SESSION, root)).toEqual([]);
  });

  it('reaches a child whose delegated task\'s worktree is already gone', async () => {
    const root = repo(tempDir());
    const { parent, parentRun, delegated, childRun, openCwd, codeRoot } = await saved(root);
    await parent.release(parentRun, delegated.id, { keep: false });
    expect(existsSync(codeRoot)).toBe(false);

    await discardChildRuns(ROOT_SESSION, root, isolation());

    expect(existsSync(openCwd)).toBe(false);
    expect(branches(root).filter((b) => b.startsWith(`ordewell/${childRun.id}/`))).toEqual([]);
  });

  it('says what it could not take, and has nothing to do for a root with no children', async () => {
    const root = repo(tempDir());
    expect(await discardChildRuns(ROOT_SESSION, root, isolation())).toEqual({ preserved: [], refused: [] });
    const { openCwd } = await saved(root);
    rmSync(join(openCwd, '.git'));
    const removal = await discardChildRuns(ROOT_SESSION, root, isolation());
    expect(removal.refused.map((r) => r.reason)).toEqual(['it is not a git worktree any more']);
  });
});

/** A runner whose task sits silent until the test finishes it, as a delegated task's attempt waits on its child. */
function heldRunner() {
  const spawned = new Map<string, { session: FakeRunnerSession; cwd: string }>();
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      spawned.set(opts.taskId, { session, cwd: opts.cwd });
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  const attempt = async (taskId: string) => {
    await vi.waitFor(() => expect(spawned.has(taskId)).toBe(true));
    return spawned.get(taskId)!;
  };
  return { runner, attempt };
}

/** Writes each task's files in the worktree it was handed, then reports done. */
function writingRunner(files: Record<string, string[]>): IRunner {
  return {
    spawn: vi.fn(async (opts) => {
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      setTimeout(() => {
        for (const file of files[opts.taskId]) {
          mkdirSync(dirname(join(opts.cwd, file)), { recursive: true });
          writeFileSync(join(opts.cwd, file), `written by ${opts.taskId}\n`);
        }
        session.reportComplete({ status: 'done', summary: 'Done.' });
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-10-31T10:00:00.000Z' } as unknown as LegacyPlanState);
const ROOT_SESSION = 'session-root';
const childDir = (root: string, id: string) => join(root, '.ordewell', 'sessions', ROOT_SESSION, 'children', id);
const statusesOf = (session: Pick<Session, 'planTasks'>) => session.planTasks.map((t) => t.status);

describe('a nested Session', () => {
  interface Tree {
    root: string;
    parent: Session;
    held: ReturnType<typeof heldRunner>;
    /** The delegated task's worktree. */
    codeRoot: string;
    childOf(runner: IRunner, session?: Partial<Pick<SessionDeps, 'placement'>>): Session;
  }

  async function tree(leaseHost = new LeaseHost()): Promise<Tree> {
    const root = repo(tempDir());
    const held = heldRunner();
    const parent = makeSession({ runner: held.runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost, sessionId: ROOT_SESSION });
    parent.loadPlan(planOf([createTask({ id: 'delegated', order: 1, title: 'Delegated subtree', prompt: 'a subtree' })]), 'the root goal', root, { sessionId: ROOT_SESSION });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    const { cwd: codeRoot } = await held.attempt('delegated');
    return {
      root, parent, held, codeRoot,
      childOf: (runner, session) => makeSession({ runner, workspaceRoot: () => codeRoot, placement: session?.placement ?? parent.hostChild('delegated') }),
    };
  }

  const childPlan = () => planOf([
    createTask({ id: 'a', order: 1, title: 'Write a', prompt: 'a' }),
    createTask({ id: 'b', order: 2, title: 'Write b', prompt: 'b', dependencies: ['a'] }),
  ]);

  const settled = async (session: Session, count: number) => {
    await vi.waitFor(() => expect(statusesOf(session)).toEqual(Array.from({ length: count }, () => 'completed')));
  };

  it('runs a two-task plan beside its running parent and lands into the delegated task\'s branch, leaving the parent\'s state alone', async () => {
    const { root, parent, held, codeRoot, childOf } = await tree();
    const placement = parent.hostChild('delegated');
    const parentFile = readdirSync(join(root, '.ordewell', 'sessions')).filter((f) => f.endsWith('.json'));
    expect(parentFile).toHaveLength(1);
    const savedParent = readFileSync(join(root, '.ordewell', 'sessions', parentFile[0]), 'utf8');
    const main = git(root, 'rev-parse', 'main');
    const branch = git(codeRoot, 'symbolic-ref', '--short', 'HEAD');

    const child = childOf(writingRunner({ a: ['a.txt'], b: ['b.txt'] }), { placement });
    child.loadPlan(childPlan(), 'a sub goal', codeRoot, { sessionId: placement.sessionId });
    await child.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(child, 2);
    expect(await child.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'merge', result: { outcome: 'merged' } } });

    // D10: the merge reached the delegated task's branch and stopped there.
    expect(git(codeRoot, 'symbolic-ref', '--short', 'HEAD')).toBe(branch);
    expect(readFileSync(join(codeRoot, 'a.txt'), 'utf8')).toBe('written by a\n');
    expect(readFileSync(join(codeRoot, 'b.txt'), 'utf8')).toBe('written by b\n');
    expect(git(root, 'rev-parse', 'main')).toBe(main);

    // D11: its state is under the root, and the parent's is as it was.
    expect(existsSync(join(codeRoot, '.ordewell'))).toBe(false);
    expect(git(codeRoot, 'status', '--porcelain')).toBe('');
    const dir = childDir(root, placement.sessionId);
    expect(readdirSync(dir).sort()).toEqual(['session.json', 'tasks']);
    expect(readdirSync(join(dir, 'tasks')).sort()).toEqual(['a', 'b']);
    expect(readFileSync(join(root, '.ordewell', 'sessions', parentFile[0]), 'utf8')).toBe(savedParent);
    expect(listSessions(root).map((s) => s.id)).toEqual([ROOT_SESSION]);
    expect(parent.planTasks.map((t) => [t.id, t.status])).toEqual([['delegated', 'in_progress']]);
    expect(readdirSync(join(root, '.ordewell', 'sessions', ROOT_SESSION, 'tasks'))).toEqual(['delegated']);

    // The parent's ordinary landing carries the work up, and only its Merge all reaches main.
    held.attempt('delegated').then(({ session }) => session.reportComplete({ status: 'done', summary: 'Done.' }));
    await settled(parent, 1);
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(await parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'merge', result: { outcome: 'merged' } } });
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('written by b\n');
    child.destroy();
    parent.destroy();
  });

  it('takes its parent\'s isolation: one repository\'s worktree bookkeeping is one lock across the tree', async () => {
    const root = repo(tempDir());
    const held = heldRunner();
    const asked: string[] = [];
    const parent = makeSession({
      runner: held.runner,
      isolation: createWorktreeIsolation({
        resolvePath: async () => process.env.PATH ?? '',
        config: fakeConfig({ worktreeIsolation: true }),
        execFileImpl: (file, args, opts) => {
          if (args[0] === 'worktree' && args[1] === 'add') asked.push(String(opts.cwd));
          return defaultExecFile(file, args, opts);
        },
      }),
      workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: ROOT_SESSION,
    });
    parent.loadPlan(planOf([createTask({ id: 'delegated', order: 1, title: 'Delegated subtree', prompt: 'a' })]), 'the root goal', root, { sessionId: ROOT_SESSION });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    const { cwd: codeRoot } = await held.attempt('delegated');
    const child = makeSession({ runner: heldRunner().runner, workspaceRoot: () => codeRoot, placement: parent.hostChild('delegated') });
    child.loadPlan(childPlan(), 'a sub goal', codeRoot);
    await child.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(asked).toContain(codeRoot));
    child.destroy();
    parent.destroy();
  });

  it('asks again and finds the same child, one the record names and a reload can follow', async () => {
    const { root, parent } = await tree();
    const placement = parent.hostChild('delegated');
    expect(parent.hostChild('delegated')).toMatchObject({ sessionId: placement.sessionId, stateRoot: root, rootSessionId: ROOT_SESSION });
    expect(loadSession(ROOT_SESSION, root)?.plan.isolation?.run.tasks.delegated.childSession).toBe(placement.sessionId);
    parent.destroy();
  });

  it('keeps its planner\'s PRD out of the tree a landing sweeps', async () => {
    const { root, parent, codeRoot } = await tree();
    const placement = parent.hostChild('delegated');
    const child = makeSession({
      runner: heldRunner().runner, workspaceRoot: () => codeRoot, placement,
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: '<!-- ORDEWELL_PRD_START slug="sub" --># A PRD<!-- ORDEWELL_PRD_END -->', researchLog: [] }),
      },
    });
    child.loadPlan(childPlan(), 'a sub goal', codeRoot);
    await child.continueConversation('write it up');
    expect(child.planState?.prdMarkdown).toBe('# A PRD');
    expect(git(codeRoot, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(root, '.scratch', 'sub', 'PRD.md'))).toBe(true);
    child.destroy();
    parent.destroy();
  });

  it('puts a grandchild under the root too, not under its parent', async () => {
    const { root, parent, codeRoot, childOf } = await tree();
    const held = heldRunner();
    const child = childOf(held.runner);
    child.loadPlan(planOf([createTask({ id: 'inner', order: 1, title: 'Inner', prompt: 'inner' })]), 'a sub goal', codeRoot);
    await child.execute({ command: 'run_plan' }, { kind: 'user' });
    const { cwd } = await held.attempt('inner');

    const placement = child.hostChild('inner');
    expect(placement).toMatchObject({ stateRoot: root, rootSessionId: ROOT_SESSION });
    const grandchild = makeSession({ runner: writingRunner({ leaf: ['leaf.txt'] }), workspaceRoot: () => cwd, placement });
    grandchild.loadPlan(planOf([createTask({ id: 'leaf', order: 1, title: 'Leaf', prompt: 'leaf' })]), 'a leaf goal', cwd);
    await grandchild.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(grandchild, 1);
    expect(readdirSync(childDir(root, placement.sessionId))).toContain('session.json');
    expect(relative(root, grandchild.taskLogLocation.baseDir)).toBe('');
    grandchild.destroy();
    child.destroy();
    parent.destroy();
  });

  it('survives a restart: a parent\'s reopen leaves the child\'s worktree alone, and both load', async () => {
    const first = await tree(new LeaseHost({ runnerGroups: () => [] }));
    const { root, codeRoot, childOf, parent } = first;
    const placement = parent.hostChild('delegated');
    const inner = heldRunner();
    const child = childOf(inner.runner, { placement });
    child.loadPlan(childPlan(), 'a sub goal', codeRoot, { sessionId: placement.sessionId });
    await child.execute({ command: 'run_plan' }, { kind: 'user' });
    const { cwd: childCwd } = await inner.attempt('a');
    writeFileSync(join(childCwd, 'a.txt'), 'unlanded\n');

    // The host dies: its heartbeat goes stale, and nothing of it ran a clean-up.
    const next = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const savedParent = loadSession(ROOT_SESSION, root)!;
    expect(savedParent.plan.tasks[0].status).toBe('failed');
    const parent2 = makeSession({ runner: heldRunner().runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: next, sessionId: ROOT_SESSION });
    parent2.loadPlan(savedParent.plan, savedParent.meta.goal, root, { sessionId: ROOT_SESSION });
    await vi.waitFor(() => expect(parent2.planState?.isolation?.run.tasks.delegated.status).toBe('kept'));
    expect(readFileSync(join(childCwd, 'a.txt'), 'utf8')).toBe('unlanded\n');
    expect(existsSync(codeRoot)).toBe(true);

    const again = parent2.hostChild('delegated');
    expect(again.sessionId).toBe(placement.sessionId);
    const savedChild = loadChildSession({ baseDir: root, rootSessionId: ROOT_SESSION, sessionId: again.sessionId })!;
    expect(savedChild.plan.tasks.map((t) => t.status)).toEqual(['failed', 'approved']);
    const child2 = makeSession({ runner: heldRunner().runner, workspaceRoot: () => codeRoot, placement: again });
    child2.loadPlan(savedChild.plan, savedChild.meta.goal, codeRoot, { sessionId: again.sessionId });
    await vi.waitFor(() => expect(child2.planState?.isolation?.run.tasks.a.status).toBe('kept'));
    expect(readFileSync(join(childCwd, 'a.txt'), 'utf8')).toBe('unlanded\n');
    child2.destroy();
    parent2.destroy();
  });

  describe('one session lease across the tree (ADR-0055 D13)', () => {
    it('holds no file of its own, and goes by the root\'s', async () => {
      const { root, parent, codeRoot, childOf } = await tree(new LeaseHost({ runnerGroups: () => [] }));
      const placement = parent.hostChild('delegated');
      const inner = heldRunner();
      const child = childOf(inner.runner, { placement });
      child.loadPlan(childPlan(), 'a sub goal', codeRoot, { sessionId: placement.sessionId });
      expect(child.heldElsewhere()).toBeNull();
      expect(existsSync(join(root, '.ordewell', 'sessions', ROOT_SESSION, 'lease.json'))).toBe(true);
      expect(existsSync(join(childDir(root, placement.sessionId), 'lease.json'))).toBe(false);

      const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
      taker.lease(() => undefined).claim(ROOT_SESSION, root);

      expect(child.heldElsewhere()?.holder.hostId).toBe(taker.id);
      const savedChild = readFileSync(join(childDir(root, placement.sessionId), 'session.json'), 'utf8');
      const branches = git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell/');
      await child.execute({ command: 'run_plan' }, { kind: 'user' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(inner.runner.spawn).not.toHaveBeenCalled();
      expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell/')).toBe(branches);
      expect(() => child.loadPlan(childPlan(), 'another', codeRoot, { sessionId: placement.sessionId })).toThrow('another Ordewell host');
      expect(readFileSync(join(childDir(root, placement.sessionId), 'session.json'), 'utf8')).toBe(savedChild);
      taker.releaseAll();
    });

    it('leaves the root\'s lease held when a child closes', async () => {
      const { root, parent, codeRoot, childOf } = await tree();
      const child = childOf(heldRunner().runner);
      child.loadPlan(childPlan(), 'a sub goal', codeRoot);
      child.destroy();
      expect(existsSync(join(root, '.ordewell', 'sessions', ROOT_SESSION, 'lease.json'))).toBe(true);
      parent.destroy();
    });
  });

  describe('only the root touches the user\'s branch (ADR-0055 D12)', () => {
    it('is refused where it is built, on the user\'s checkout', async () => {
      const { root, parent } = await tree();
      const placement = parent.hostChild('delegated');
      expect(() => makeSession({ runner: heldRunner().runner, workspaceRoot: () => root, placement })).toThrow('never in the user\'s checkout');
      parent.destroy();
    });

    it('is refused a load that would move it onto the user\'s checkout', async () => {
      const { root, parent, codeRoot, childOf } = await tree();
      const child = childOf(heldRunner().runner);
      child.loadPlan(childPlan(), 'a sub goal', codeRoot);
      expect(() => child.loadPlan(childPlan(), 'a sub goal', root)).toThrow('never in the user\'s checkout');
      child.destroy();
      parent.destroy();
    });

    it('has nowhere to go in a run that shares the workspace root', () => {
      const root = repo(tempDir());
      const parent = makeSession({ runner: heldRunner().runner, config: fakeConfig({ worktreeIsolation: false }), workspaceRoot: () => root });
      parent.loadPlan(planOf([createTask({ id: 'delegated', order: 1, title: 'Delegated', prompt: 'a' })]), 'goal', root);
      expect(() => parent.hostChild('delegated')).toThrow('needs an isolated run');
      parent.destroy();
    });
  });
});
