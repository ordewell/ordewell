import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IsolationHandoff } from '../../interfaces/IWorktreeIsolation';
import type { SessionMessage } from '../SessionMessage';
import type { Session } from '../createSession';
import * as sessionStore from '../../utils/sessionStore';
import { fakeConfig, FakeTerminalSession } from '../../testing';
import { fakeNotification, makeSession, taskOf } from './sessionTestKit';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-e2e-')));
  roots.push(dir);
  return dir;
}

function repo(root = tempDir(), files: Record<string, string> = {}): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/**
 * A runner that does what a coding agent does, minus the model: writes the
 * task's files in whatever directory it was handed, then prints the marker.
 * It records whether every file its task depends on was already there.
 */
function writingRunner(files: Record<string, { write: string[]; needs?: string[] }>, markerOf: Task[] | ((taskId: string) => string)) {
  const sawPredecessor: Record<string, boolean> = {};
  const runner: ITerminalRunner = {
    spawn: vi.fn(async (opts) => {
      const session = new FakeTerminalSession(`s-${opts.taskId}`, opts.taskId);
      const job = files[opts.taskId];
      const marker = typeof markerOf === 'function' ? markerOf(opts.taskId) : markerOf.find((t) => t.id === opts.taskId)!.completionMarker;
      setTimeout(() => {
        if (job.needs) sawPredecessor[opts.taskId] = job.needs.every((file) => existsSync(join(opts.cwd!, file)));
        for (const file of job.write) writeFileSync(join(opts.cwd!, file), `written by ${opts.taskId}\n`);
        session.emitOutput(`done\n<<<ORDEWELL_DONE_${marker}>>>`);
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, sawPredecessor };
}

describe.skipIf(!hasGit)('isolated execution against a real repository', () => {
  it('lands every task on the integration branch and leaves the user\'s branch and tree untouched', async () => {
    const root = repo();
    const base = git(root, 'rev-parse', 'HEAD');
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Add a', prompt: 'write a.txt' }),
      createTask({ id: 't2', order: 2, title: 'Add b on top of a', prompt: 'write b.txt', dependencies: ['t1'] }),
    ];
    const { runner, sawPredecessor } = writingRunner({ t1: { write: ['a.txt'] }, t2: { write: ['b.txt'], needs: ['a.txt'] } }, tasks);
    const isolation = createWorktreeIsolation({
      config: fakeConfig({ worktreeIsolation: true }),
      resolvePath: async () => process.env.PATH ?? '',
    });
    const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), terminalRunner: runner, output, isolation, workspaceRoot: () => root });
    let handoff: IsolationHandoff | undefined;
    orchestrator.subscribe({ onIsolationHandoff: (h) => { handoff = h; } });
    orchestrator.loadPlan(tasks);

    await orchestrator.approveReview();
    await vi.waitFor(() => expect(handoff).toBeDefined(), { timeout: 20_000 });

    expect(orchestrator.storeInstance.allTasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(handoff!.landed.map((l) => l.taskId)).toEqual(['t1', 't2']);
    expect(handoff!.repos.map((r) => [r.path, r.baseRef])).toEqual([['.', base]]);
    const [{ integrationBranch }] = handoff!.repos;
    expect(git(root, 'show', `${integrationBranch}:a.txt`)).toBe('written by t1');
    expect(git(root, 'show', `${integrationBranch}:b.txt`)).toBe('written by t2');
    expect(sawPredecessor.t2).toBe(true);

    expect(git(root, 'rev-parse', 'main')).toBe(base);
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    // The state dir's own ignore file is meant to be committed (it carves out .ordewell/skills); nothing else may show.
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .ordewell/.gitignore');
    expect(git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  }, 30_000);

  it('lands each task across a folder of repositories as a whole, starts a dependent only once all of it has, and merges every repository at handoff', async () => {
    const dir = tempDir();
    const [api, web] = [repo(join(dir, 'api')), repo(join(dir, 'web'))];
    const bases = { api: git(api, 'rev-parse', 'HEAD'), web: git(web, 'rev-parse', 'HEAD') };
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Add the endpoint and its client', prompt: 'write both' }),
      createTask({ id: 't2', order: 2, title: 'Use the client', prompt: 'build on both', dependencies: ['t1'] }),
      createTask({ id: 't3', order: 3, title: 'Unrelated page', prompt: 'write a page' }),
    ];
    const { runner, sawPredecessor } = writingRunner({
      t1: { write: ['api/endpoint.txt', 'web/client.txt'] },
      t2: { write: ['web/usage.txt'], needs: ['api/endpoint.txt', 'web/client.txt'] },
      t3: { write: ['web/page.txt'] },
    }, tasks);
    const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig({ maxParallelSessions: 3 }), notifications: fakeNotification(), terminalRunner: runner, output, isolation, workspaceRoot: () => dir });
    let handoff: IsolationHandoff | undefined;
    orchestrator.subscribe({ onIsolationHandoff: (h) => { handoff = h; } });
    orchestrator.loadPlan(tasks);

    await orchestrator.approveReview();
    await vi.waitFor(() => expect(handoff).toBeDefined(), { timeout: 20_000 });

    expect(orchestrator.storeInstance.allTasks.map((t) => t.status)).toEqual(['completed', 'completed', 'completed']);
    expect(sawPredecessor.t2).toBe(true);
    expect(handoff!.repos.map((r) => [r.path, r.baseRef, r.landed.map((l) => l.taskId)])).toEqual([
      ['api', bases.api, ['t1']],
      ['web', bases.web, ['t1', 't2', 't3']],
    ]);
    const [{ integrationBranch }] = handoff!.repos;
    expect(git(api, 'show', `${integrationBranch}:endpoint.txt`)).toBe('written by t1');
    for (const file of ['client.txt', 'usage.txt', 'page.txt']) expect(git(web, 'ls-tree', '--name-only', integrationBranch, file)).toBe(file);
    for (const [root, base] of [[api, bases.api], [web, bases.web]]) {
      expect(git(root, 'rev-parse', 'main')).toBe(base);
      expect(git(root, 'status', '--porcelain')).toBe('');
    }

    expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });
    expect(readFileSync(join(api, 'endpoint.txt'), 'utf8')).toBe('written by t1\n');
    expect(readFileSync(join(web, 'usage.txt'), 'utf8')).toBe('written by t2\n');
    // Nothing left to hand over: every branch and worktree of the run is gone, and the work is on the user's branch.
    for (const root of [api, web]) {
      expect(git(root, 'branch', '--list', 'ordewell/*')).toBe('');
      expect(git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toEqual([`worktree ${root}`]);
      expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    }
    expect(git(web, 'show', 'main:page.txt')).toBe('written by t3');
    expect(orchestrator.runs.view()).toBeNull();
  }, 30_000);

  it('a later run clears an earlier one the user merged by hand, and keeps one they have not', async () => {
    const root = repo();
    const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    /** One plan with one task writing `file`, run to its handoff on the shared repository. */
    const runPlan = async (id: string, file: string) => {
      const tasks = [createTask({ id, order: 1, title: `Write ${file}`, prompt: `write ${file}` })];
      const { runner } = writingRunner({ [id]: { write: [file] } }, tasks);
      const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
      const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), terminalRunner: runner, output, isolation, workspaceRoot: () => root });
      let handoff: IsolationHandoff | undefined;
      orchestrator.subscribe({ onIsolationHandoff: (h) => { handoff = h; } });
      orchestrator.loadPlan(tasks);
      await orchestrator.approveReview();
      await vi.waitFor(() => expect(handoff).toBeDefined(), { timeout: 20_000 });
      return handoff!.repos[0].integrationBranch;
    };

    const mergedByHand = await runPlan('m1', 'merged.txt');
    git(root, 'merge', '-q', '--no-edit', mergedByHand);
    const unmerged = await runPlan('u1', 'unmerged.txt');
    const later = await runPlan('l1', 'later.txt');

    expect(git(root, 'branch', '--list', 'ordewell/*', '--format=%(refname:short)').split('\n').sort()).toEqual([later, unmerged].sort());
    expect(git(root, 'show', `${unmerged}:unmerged.txt`)).toBe('written by u1');
    expect(readFileSync(join(root, 'merged.txt'), 'utf8')).toBe('written by m1\n');
  }, 60_000);

  it('resumes a session 0.4.23 saved mid-run: drops the attempt the crash cut off, continues the run, and hands it off whole', async () => {
    const root = repo();
    const base = git(root, 'rev-parse', 'HEAD');
    const runRoot = join(root, '.ordewell', 'worktrees', 'old');
    const integration = 'ordewell/old/integration';
    // What 0.4.23 left on disk: task 1 landed, its worktree and branch gone; the
    // integration worktree still up; task 2 half-done when the process died.
    git(root, 'branch', integration, base);
    const landed = join(runRoot, '1-add-a');
    git(root, 'worktree', 'add', '-q', '-b', 'ordewell/old/1-add-a', landed, base);
    writeFileSync(join(landed, 'a.txt'), 'written by t1\n');
    git(landed, 'add', 'a.txt');
    git(landed, 'commit', '-q', '-m', 'ordewell: task 1 Add a');
    git(root, 'worktree', 'add', '-q', join(runRoot, 'integration'), integration);
    git(join(runRoot, 'integration'), 'merge', '--no-ff', '--no-edit', '-m', 'Merge task 1: Add a', 'ordewell/old/1-add-a');
    git(root, 'worktree', 'remove', '--force', landed);
    git(root, 'branch', '-D', 'ordewell/old/1-add-a');
    const cutOff = join(runRoot, '2-add-b');
    git(root, 'worktree', 'add', '-q', '-b', 'ordewell/old/2-add-b', cutOff, integration);
    writeFileSync(join(cutOff, 'half.txt'), 'half-written\n');

    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Add a', prompt: 'write a.txt', status: 'completed' }),
      createTask({ id: 't2', order: 2, title: 'Add b', prompt: 'write b.txt', dependencies: ['t1'], status: 'in_progress' }),
    ];
    const now = new Date().toISOString();
    const plan: LegacyPlanState = { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
    const saved = {
      ...plan,
      // The ADR-0013 record exactly as 0.4.23 wrote it: the refs on the run, one worktree per task.
      isolation: {
        run: {
          id: 'old', workspaceRoot: root, baseRef: base, baseBranch: 'main', integrationBranch: integration,
          tasks: {
            t1: { taskId: 't1', order: 1, title: 'Add a', branch: 'ordewell/old/1-add-a', worktree: landed, status: 'merged', linked: [] },
            t2: { taskId: 't2', order: 2, title: 'Add b', branch: 'ordewell/old/2-add-b', worktree: cutOff, status: 'active', linked: [] },
          },
        },
        resolvers: {},
      },
    };
    mkdirSync(join(root, '.ordewell', 'sessions'), { recursive: true });
    writeFileSync(
      join(root, '.ordewell', 'sessions', '2026-09-20T10-00-00_goal_legacy1.json'),
      JSON.stringify({ meta: { id: 'session-legacy1', goal: 'goal', runners: ['claude-code'], taskCount: 2, status: 'approved', createdAt: now, updatedAt: now }, plan: saved }),
    );

    const { runner, sawPredecessor } = writingRunner({ t2: { write: ['b.txt'], needs: ['a.txt'] } }, (id) => taskOf(session, id)!.completionMarker);
    const messages: SessionMessage[] = [];
    const session: Session = makeSession({
      runner,
      isolation: createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' }),
      workspaceRoot: () => root,
      broadcast: (m) => messages.push(m),
    });
    const loaded = sessionStore.loadSession('session-legacy1', root)!;
    session.loadPlan(loaded.plan, loaded.meta.goal, root, { sessionId: loaded.meta.id });
    await session.executePlan();
    await vi.waitFor(() => expect(messages.map((m) => m.type)).toContain('isolation_handoff'), { timeout: 20_000 });

    expect(session.planTasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(sawPredecessor.t2).toBe(true);
    const handoff = messages.find((m): m is Extract<SessionMessage, { type: 'isolation_handoff' }> => m.type === 'isolation_handoff')!;
    const both = [{ taskId: 't1', order: 1, title: 'Add a' }, { taskId: 't2', order: 2, title: 'Add b' }];
    expect(handoff).toEqual({ type: 'isolation_handoff', repos: [{ path: '.', integrationBranch: integration, baseRef: base, landed: both }], landed: both });
    expect(git(root, 'show', `${integration}:a.txt`)).toBe('written by t1');
    expect(git(root, 'show', `${integration}:b.txt`)).toBe('written by t2');
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).not.toContain('half.txt');
    expect(git(root, 'branch', '--list', 'ordewell/*', '--format=%(refname:short)')).toBe(integration);
    expect(git(root, 'rev-parse', 'main')).toBe(base);

    expect(await session.mergeRun()).toEqual({ outcome: 'merged' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('written by t1\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('written by t2\n');
  }, 30_000);

  /** The repair's agent, acting in the kept worktree: the job tells it whether to really merge the tip in or only say done. */
  type RepairJob = { merge: boolean } | undefined;

  function repairingRunner(files: Record<string, string>, jobFor: (attempt: number) => RepairJob, markerOf: (taskId: string) => string) {
    return actingRunner(files, () => false, (_taskId, n) => jobFor(n), markerOf);
  }

  /**
   * The same runner, with an optional hold: a held spawn's session sits silent
   * until the gate opens, which is how a test decides when a task acts.
   */
  function actingRunner(files: Record<string, string>, hold: (taskId: string, n: number) => boolean, jobFor: (taskId: string, n: number) => RepairJob, markerOf: (taskId: string) => string) {
    const spawns: Array<{ taskId: string; cwd: string; prompt: string }> = [];
    const runner: ITerminalRunner = {
      spawn: vi.fn(async (opts) => {
        const n = spawns.filter((s) => s.taskId === opts.taskId).length;
        spawns.push({ taskId: opts.taskId, cwd: opts.cwd, prompt: opts.prompt });
        const session = new FakeTerminalSession(`s-${opts.taskId}-${n}`, opts.taskId);
        setTimeout(() => {
          if (hold(opts.taskId, n)) return;
          const job = jobFor(opts.taskId, n);
          if (job?.merge) {
            const integration = spawns.map((s) => s.prompt.match(/git merge --no-edit ([^`\n\s]+)/)?.[1]).find(Boolean)!;
            let conflicted = false;
            try { git(opts.cwd, 'merge', '--no-edit', integration); } catch { conflicted = true; }
            // A conflicted merge resolves itself the way the repair is told to: keep both sides' work, commit.
            if (conflicted) {
              const conflictedFile = join(opts.cwd!, files[opts.taskId] ?? 'shared.txt');
              const kept = readFileSync(conflictedFile, 'utf8')
                .split('\n')
                .filter((l) => !l.startsWith('<<<<<<<') && !l.startsWith('=======') && !l.startsWith('>>>>>>>') && l !== '' && !l.startsWith('written by'))
                .concat(`written by ${opts.taskId}`);
              writeFileSync(conflictedFile, kept.join('\n') + '\n');
              git(opts.cwd, 'add', '-A');
              git(opts.cwd, 'commit', '-q', '-m', `resolution by ${opts.taskId}`);
            }
          }
          const file = files[opts.taskId];
          if (file) writeFileSync(join(opts.cwd!, file), `written by ${opts.taskId}\n`);
          if (file || job) {
            git(opts.cwd, 'add', '-A');
            const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: opts.cwd, env: cleanEnv(), encoding: 'utf8' });
            if (staged.trim() !== '') git(opts.cwd, 'commit', '-q', '-m', `work by ${opts.taskId}`);
          }
          session.emitOutput(`done\n<<<ORDEWELL_DONE_${markerOf(opts.taskId)}>>>`);
        }, 5);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    return { runner, spawns };
  }

  /**
   * t3 (order 2) and t2 (order 3) both rewrite shared.txt and run
   * concurrently. The merge queue lands the lower order first, so t3's
   * landing moves the integration branch under t2's worktree and t2's
   * landing must then conflict.
   */
  function conflictPlan(): { tasks: Task[]; t4: Task } {
    const t4 = createTask({ id: 't4', order: 4, title: 'Follow on', prompt: 'write follow.txt', dependencies: ['t2'] });
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Take the shared file', prompt: 'write shared.txt' }),
      createTask({ id: 't3', order: 2, title: 'Rival writer', prompt: 'write shared.txt too' }),
      createTask({ id: 't2', order: 3, title: 'Rewrite the shared file', prompt: 'write shared.txt again', dependencies: ['t1'] }),
      t4,
    ];
    return { tasks, t4 };
  }

  it('a task whose landing conflicts repairs itself in its kept worktree, lands, and frees its dependent', async () => {
    const root = repo(tempDir(), { 'shared.txt': 'base\n' });
    const { tasks, t4 } = conflictPlan();
    const first = repairingRunner({ t1: 'shared.txt' }, () => undefined, (id) => tasks.find((t) => t.id === id)!.completionMarker);
    const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), terminalRunner: first.runner, output, isolation, workspaceRoot: () => root });
    let handoff: IsolationHandoff | undefined;
    orchestrator.subscribe({ onIsolationHandoff: (h) => { handoff = h; } });
    orchestrator.loadPlan([tasks[0]]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(handoff).toBeDefined(), { timeout: 20_000 });
    const integration = handoff!.repos[0].integrationBranch;
    expect(git(root, 'show', `${integration}:shared.txt`)).toBe('written by t1');

    const job: RepairJob = { merge: true };
    const { runner } = actingRunner(
      { t3: 'shared.txt', t2: 'shared.txt', t4: 'follow.txt' },
      () => false,
      () => job,
      (id) => tasks.find((t) => t.id === id)!.completionMarker,
    );
    const notices: string[] = [];
    const nots = fakeNotification();
    (['info', 'warn', 'error'] as const).forEach((level) => (nots[level] as ReturnType<typeof vi.fn>).mockImplementation((m: string) => notices.push(`${level}: ${m}`)));
    const second = TaskOrchestrator.compose({ config: fakeConfig({ conflictRepairAttempts: 2, maxParallelSessions: 2 }), notifications: nots, terminalRunner: runner, output, isolation, workspaceRoot: () => root });
    let secondHandoff: IsolationHandoff | undefined;
    second.subscribe({ onIsolationHandoff: (h) => { secondHandoff = h; } });
    second.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Take the shared file', prompt: 'write shared.txt', status: 'completed' }),
      tasks[1],
      tasks[2],
      t4,
    ]);

    await second.approveReview();
    // The handoff follows the last verdict asynchronously (it reads the run back
    // from git), so t4 completing is not yet the run being handed over.
    await vi.waitFor(() => {
      expect(second.storeInstance.get('t4')!.status).toBe('completed');
      expect(secondHandoff).toBeDefined();
    }, { timeout: 30_000 }).catch(() => undefined);
    process.stdout.write(notices.join('\n') + '\n');
    expect(second.storeInstance.get('t2')!.status).toBe('completed');
    expect(secondHandoff).toBeDefined();
    const t2Entry = secondHandoff!.landed.find((l) => l.taskId === 't2')!;
    expect(t2Entry.repairedFiles).toEqual(['shared.txt']);
    const runIntegration = secondHandoff!.repos[0].integrationBranch;
    expect(git(root, 'show', `${runIntegration}:shared.txt`)).toContain('written by t2');
    expect(git(root, 'ls-tree', '--name-only', runIntegration, 'follow.txt')).toBe('follow.txt');
  }, 60_000);

  it('a repair that only claims to have merged is refused: the conflict waits for the user with the attempts used up', async () => {
    const root = repo(tempDir(), { 'shared.txt': 'base\n' });
    const t4 = createTask({ id: 't4', order: 4, title: 'Follow on', prompt: 'write follow.txt', dependencies: ['t2'] });
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Take the shared file', prompt: 'write shared.txt' }),
      createTask({ id: 't3', order: 2, title: 'Rival writer', prompt: 'write shared.txt too' }),
      createTask({ id: 't2', order: 3, title: 'Rewrite the shared file', prompt: 'write shared.txt again', dependencies: ['t1'] }),
      t4,
    ];

    const first = repairingRunner({ t1: 'shared.txt' }, () => undefined, (id) => tasks.find((t) => t.id === id)!.completionMarker);
    const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), terminalRunner: first.runner, output, isolation, workspaceRoot: () => root });
    let handoff: IsolationHandoff | undefined;
    orchestrator.subscribe({ onIsolationHandoff: (h) => { handoff = h; } });
    orchestrator.loadPlan([tasks[0]]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(handoff).toBeDefined(), { timeout: 20_000 });
    const integration = handoff!.repos[0].integrationBranch;

    // The "repair" emits the marker but never merges the integration tip in: the ancestry check must refuse it.
    const job: RepairJob = { merge: false };
    const { runner, spawns } = repairingRunner({ t3: 'shared.txt', t2: 'shared.txt', t4: 'follow.txt' }, () => job, (id) => tasks.find((t) => t.id === id)!.completionMarker);
    const second = TaskOrchestrator.compose({ config: fakeConfig({ conflictRepairAttempts: 2, maxParallelSessions: 2 }), notifications: fakeNotification(), terminalRunner: runner, output, isolation, workspaceRoot: () => root });
    second.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Take the shared file', prompt: 'write shared.txt', status: 'completed' }),
      tasks[1],
      tasks[2],
      t4,
    ]);
    await second.approveReview();

    await vi.waitFor(() => expect(second.storeInstance.get('t2')!.status).toBe('awaiting_user'), { timeout: 30_000 });
    // The first repair was spent, its unmerged work refused; a repair that does not land waits for the user instead of spending the next attempt.
    expect(spawns.filter((s) => s.taskId === 't2')).toHaveLength(2);
    expect(second.runs.taskIsolation('t2')).toMatchObject({ state: 'conflict', conflictFiles: ['shared.txt'], repair: { attempt: 1, limit: 2 } });
    expect(second.storeInstance.get('t2')!.verdict?.outcome).toBe('pass');
    expect(git(root, 'show', `${integration}:shared.txt`)).toBe('written by t1');
  }, 60_000);
});
