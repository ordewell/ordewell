import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { savedPatchOf, type StoredHandoff } from '../../models/Handoff';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { TaskLogEvent } from '../../models/TaskLog';
import type { OwnSealedRuns, TaskShell } from '../../interfaces/IFileSystem';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * A read-only task's `save_patch` (ADR-0050): the attempt keeps the patch
 * its shell captured beside its log, and its handoff names it, whatever the
 * verdict. The shell's sealed runs are a plain `sh` over a real repository
 * here; that they run sealed is `PatchCapture.e2e.test.ts`'s to show.
 */

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;

describe.skipIf(process.platform === 'win32')("a read-only task's saved patch (ADR-0050)", () => {
  let repo: string;
  let scratch: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-task-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-task-scratch-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function setup(isolation = new FakeWorktreeIsolation()) {
    const sessions: FakeRunnerSession[] = [];
    const requests: RunnerSpawnOptions[] = [];
    const kept: Array<{ taskId: string; attempt: number; patch: string }> = [];
    const recorded: StoredHandoff[] = [];
    // The session's task logs, as `read` and `apply_patch` read them: one attempt each, with what was kept for it.
    const logged = new Map<string, StoredHandoff>();
    const patches = new Map<string, Buffer>();
    const runner = {
      spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
        requests.push(o);
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const shell: TaskShell = {
      run: async () => ({ success: true, output: '', truncated: false }),
      hold: (work) => work({
        worktrees: [repo],
        touched: true,
        scratch,
        async run(script, cwd) {
          const ran = spawnSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch } });
          return { success: ran.status === 0, output: `${ran.stdout}${ran.stderr}`, truncated: false };
        },
      } satisfies OwnSealedRuns),
      end: vi.fn(),
    };
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig({ worktreeIsolation: true }),
      notifications: fakeNotification(),
      runner,
      output: new BufferedTaskOutputSource(),
      registry: new RunnerRegistry(),
      isolation,
      workspaceRoot: () => '/repo',
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
      taskShell: () => shell,
      keepPatch: (taskId, attempt, patch) => {
        kept.push({ taskId, attempt, patch: patch.toString('utf8') });
        patches.set(`${taskId}/${attempt}`, patch);
        return `.ordewell/sessions/s/tasks/${taskId}/${attempt}.patch`;
      },
      recordHandoff: (_session, taskId, handoff) => {
        recorded.push(handoff);
        logged.set(taskId, handoff);
      },
      taskLog: {
        attempts: (taskId) => (logged.has(taskId) ? [1] : []),
        events: (taskId): TaskLogEvent[] => (logged.has(taskId) ? [{ type: 'handoff', handoff: logged.get(taskId)! } as TaskLogEvent] : []),
        patch: (taskId, attempt) => patches.get(`${taskId}/${attempt}`),
      },
    });
    const request = (taskId: string) => requests.filter((r) => r.taskId === taskId).at(-1)!;
    const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
    const stored = (taskId: string) => orchestrator.storeInstance.get(taskId)!;
    return { orchestrator, request, latest, stored, kept, recorded };
  }

  const task = (id: string, order: number, over: Partial<Task> = {}) =>
    createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'bypassPermissions', ...over });
  const readOnly = (id: string, order: number) => task(id, order, { taskMode: 'plan' });
  const signal = () => new AbortController().signal;

  it('keeps what it saved beside its log, leaves out what Ordewell linked in, and names the patch in its handoff', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1), task('c2', 2)]);
    await env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.request('r1')).toBeDefined());
    // The record names the links bootstrapped into the worktree, as a real prepare does.
    env.orchestrator.runs.planIsolation!.run.tasks.r1.repos['.'].linked = ['.env.development'];
    writeFileSync(join(repo, '.env.development'), 'TOKEN=1\n');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n');

    const reply = await env.request('r1').savePatch!(signal());

    expect(reply.text).toContain('Saved 1 file, +1 -0');
    expect(reply.isError).toBeUndefined();
    expect(env.kept).toHaveLength(1);
    expect(env.kept[0]).toMatchObject({ taskId: 'r1', attempt: 1 });
    expect(env.kept[0].patch).toContain('diff --git a/a.ts b/a.ts');
    expect(env.kept[0].patch).not.toContain('.env.development');
    expect(env.request('c2')?.savePatch).toBeUndefined();

    env.latest('r1').reportComplete({ status: 'done', summary: 'Prototype saved.', artifacts: [{ kind: 'file', path: 'a.ts' }] });

    await vi.waitFor(() => expect(env.stored('r1').status).toBe('completed'));
    const patch = { kind: 'patch', path: '.ordewell/sessions/s/tasks/r1/1.patch', attempt: 1, base: git(repo, 'rev-parse', 'HEAD').trim(), files: 1, added: 1, removed: 0, binary: 0, bytes: Buffer.byteLength(env.kept[0].patch), sha256: createHash('sha256').update(env.kept[0].patch).digest('hex') };
    expect(env.stored('r1').handoff).toMatchObject({ summary: 'Prototype saved.', artifacts: [{ kind: 'file', path: 'a.ts' }, patch] });
    expect(env.recorded.at(-1)?.artifacts).toEqual([{ kind: 'file', path: 'a.ts' }, patch]);
  });

  it('names only the latest of several saves', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1)]);
    await env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.request('r1')).toBeDefined());
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n');
    await env.request('r1').savePatch!(signal());
    writeFileSync(join(repo, 'b.ts'), 'new\n');
    await env.request('r1').savePatch!(signal());

    env.latest('r1').reportComplete({ status: 'done', summary: 'Two tries.' });

    await vi.waitFor(() => expect(env.stored('r1').status).toBe('completed'));
    expect(env.stored('r1').handoff?.artifacts).toHaveLength(1);
    expect(savedPatchOf(env.stored('r1').handoff)).toMatchObject({ files: 2 });
  });

  it('hands its patch on from an attempt that ended without a completion call', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1)]);
    await env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.request('r1')).toBeDefined());
    writeFileSync(join(repo, 'a.ts'), 'changed\n');
    await env.request('r1').savePatch!(signal());

    env.latest('r1').emitExit(1);

    await vi.waitFor(() => expect(env.stored('r1').status).toBe('failed'));
    expect(env.stored('r1').handoff).toMatchObject({ summary: '', findings: [], artifacts: [{ kind: 'patch', files: 1 }] });
  });

  it('says a save that found nothing changed, and keeps nothing', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1)]);
    await env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.request('r1')).toBeDefined());

    const reply = await env.request('r1').savePatch!(signal());

    expect(reply.text).toContain('Nothing saved: the worktree has no changes');
    expect(env.kept).toEqual([]);
  });

  describe("a change task's apply_patch", () => {
    let builder: string;

    beforeEach(() => {
      builder = join(realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-builder-'))), 'worktree');
      git(repo, 'worktree', 'add', '-q', '--detach', builder, 'HEAD');
    });

    afterEach(() => {
      rmSync(join(builder, '..'), { recursive: true, force: true });
    });

    /** A read-only explorer that saved a prototype and ended, and the builder that depends on it. */
    async function explored() {
      const env = setup();
      env.orchestrator.loadPlan([readOnly('r1', 1), task('c2', 2, { dependencies: ['r1'] })]);
      await env.orchestrator.approveReview();
      await vi.waitFor(() => expect(env.request('r1')).toBeDefined());
      writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n');
      await env.request('r1').savePatch!(signal());
      env.latest('r1').reportComplete({ status: 'done', summary: 'Prototype saved.' });
      await vi.waitFor(() => expect(env.request('c2')).toBeDefined());
      // The builder's worktree, as a real prepare records it.
      env.orchestrator.runs.planIsolation!.run.tasks.c2.repos['.'].worktree = builder;
      return env;
    }

    it('applies the patch of the task it depends on into its own worktree, and says what it applied', async () => {
      const env = await explored();

      const reply = await env.request('c2').applyPatch!({ task: '#1' });

      expect(reply.isError).toBeUndefined();
      expect(reply.text).toContain("Applied #1 Task r1's patch (1 file, +1 -0) cleanly");
      expect(readFileSync(join(builder, 'a.ts'), 'utf8')).toBe('one\ntwo\n');
      expect(git(builder, 'status', '--porcelain')).toBe('M  a.ts\n');
    });

    it('refuses a patch that writes under a name the bootstrap linked into its worktree, and applies none of it', async () => {
      // The builder's worktree where a real prepare cuts it, with what the bootstrap linked in recorded.
      const isolation = new (class extends FakeWorktreeIsolation {
        async prepare(...args: Parameters<FakeWorktreeIsolation['prepare']>) {
          const prepared = await super.prepare(...args);
          const [prepping, run] = args;
          if (prepping.id !== 'c2') return prepared;
          run.tasks.c2.repos['.'] = { worktree: builder, linked: ['vendor'] };
          return { ...prepared, cwd: builder };
        }
      })();
      const env = setup(isolation);
      env.orchestrator.loadPlan([readOnly('r1', 1), task('c2', 2, { dependencies: ['r1'] })]);
      await env.orchestrator.approveReview();
      await vi.waitFor(() => expect(env.request('r1')).toBeDefined());
      mkdirSync(join(repo, 'vendor'));
      writeFileSync(join(repo, 'vendor', 'lib.ts'), 'export const lib = 1;\n');
      await env.request('r1').savePatch!(signal());
      env.latest('r1').reportComplete({ status: 'done', summary: 'Prototype saved.' });
      await vi.waitFor(() => expect(env.request('c2')).toBeDefined());

      const reply = await env.request('c2').applyPatch!({ task: '#1' });

      expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('vendor/lib.ts, under vendor, which Ordewell linked') });
      expect(git(builder, 'status', '--porcelain')).toBe('');
    });

    it('refuses a read-only task, which keeps its own prototype with save_patch', async () => {
      const env = await explored();

      const reply = await env.request('r1').applyPatch!({ task: '#1' });

      expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('read-only task lands nothing') });
    });

    it('refuses where the task has no worktree of its own', async () => {
      const env = await explored();
      delete env.orchestrator.runs.planIsolation!.run.tasks.c2;

      const reply = await env.request('c2').applyPatch!({ task: '#1' });

      expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('no worktree of its own') });
    });
  });
});
