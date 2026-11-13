import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { PreparedTask } from '../../interfaces/IWorktreeIsolation';

/**
 * Adversarial, the cancel-keep review, round 2: the delete's keep:false must
 * reach a workspace prepared while its attempt was already ended, whichever
 * way the spawn then leaves — not only when its open fails with
 * `LeaseWorkspacePreparedError`. The start-config check runs after the open,
 * before the live check, and a throw there skips the late letGo entirely.
 */

const task = (id: string, order: number) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}` });

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function setup(root: string) {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => root });
  return { orchestrator, isolation, spawn };
}

/** A worktree whose `.claude` is the checkout's own, as git links it. */
function linkedPrepare(base: FakeWorktreeIsolation['prepare'], root: string) {
  return async (t: Task, run: Parameters<FakeWorktreeIsolation['prepare']>[1], intent?: Parameters<FakeWorktreeIsolation['prepare']>[2], opts?: Parameters<FakeWorktreeIsolation['prepare']>[3]): Promise<PreparedTask> => {
    const prepared = await base(t, run, intent, opts);
    const dir = path.join(root, 'wt', run.id, `${t.order}-${t.id}`);
    mkdirSync(dir, { recursive: true });
    // A junction, which Windows makes without the privilege a symlink needs; elsewhere the type is ignored.
    symlinkSync(path.join(root, '.claude'), path.join(dir, '.claude'), 'junction');
    const record = run.tasks[t.id];
    if (record) {
      record.workspace = dir;
      for (const entry of Object.values(record.repos)) entry.worktree = dir;
    }
    return { ...prepared, cwd: dir };
  };
}

/** Holds t1's prepare so the cancel and delete come while its workspace is still being made. */
function firstPrepareHeld(current: FakeWorktreeIsolation['prepare']) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  return {
    preparing,
    release,
    install(isolation: FakeWorktreeIsolation) {
      vi.spyOn(isolation, 'prepare')
        .mockImplementationOnce(async (...args) => { entered(); await gate; return current(...args); })
        .mockImplementation(current);
    },
  };
}

async function deleteWhileOpening(changeCheckout: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'r2-startconfig-'));
  roots.push(root);
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"first":true}');
  const env = setup(root);
  const attempts = (env.orchestrator as unknown as { attempts: { startConfig: { check: (...args: unknown[]) => Promise<string[]> } } }).attempts;
  const baseCheck = attempts.startConfig.check.bind(attempts.startConfig);
  const found: string[][] = [];
  vi.spyOn(attempts.startConfig, 'check').mockImplementation(async (...args) => {
    const paths = await baseCheck(...args);
    found.push(paths);
    return paths;
  });
  const base = env.isolation.prepare.bind(env.isolation);
  const linked = linkedPrepare(base, root);
  vi.spyOn(env.isolation, 'prepare').mockImplementation(linked);
  env.orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
  // t2 records the run's checkout baseline and keeps the run open, so t1's decision survives the cancel.
  await env.orchestrator.forceStartTask('t2');
  if (changeCheckout) writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"second":true}');
  const held = firstPrepareHeld(linked);
  held.install(env.isolation);
  const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => String(err));
  await held.preparing;
  await env.orchestrator.cancelTask('t1');
  await env.orchestrator.releaseTask('t1');
  env.orchestrator.storeInstance.remove('t1');
  held.release();
  await first;
  await flushMicrotasks(30);
  return { record: env.orchestrator.runs.planIsolation?.run.tasks.t1, releases: env.isolation.calls.filter((c) => c.op === 'release'), found };
}

describe('a deleted task whose workspace was prepared, then refused by the start-config check', () => {
  it('removes it when the check finds nothing', async () => {
    const { record, releases, found } = await deleteWhileOpening(false);
    expect(found.every((paths) => paths.length === 0)).toBe(true);
    expect(record).toBeUndefined();
    expect(releases).toEqual([{ op: 'release', taskId: 't1', keep: false }]);
  });

  it('leaves no record when the check refuses the start after the delete', async () => {
    const { record, found } = await deleteWhileOpening(true);
    expect(found.some((paths) => paths.length > 0)).toBe(true);
    expect(record).toBeUndefined();
  });
});
