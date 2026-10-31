import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import type { IRunner } from '../../interfaces/IRunner';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { makeSession } from './sessionTestKit';

/*
 * What a session with no parent leaves on disk, spelled out: the state root
 * and the code root are one path there (ADR-0055 D11), and a saved file
 * written before they split must read the same as one written after.
 */

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-flat-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/** Every file under `dir`, stopping at a task's worktree, which is the repository's and not the session's. */
function filesUnder(dir: string, root: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    if (/^\.ordewell\/worktrees\/[^/]+\/[^/]+$/.test(rel)) return [`${rel}/`];
    return statSync(full).isDirectory() ? filesUnder(full, root) : [rel];
  }).sort();
}

describe('a flat session on disk', () => {
  it('keeps every path, and the shape of its saved file, as it always has', async () => {
    const root = repo();
    let finish!: () => void;
    const runner: IRunner = {
      spawn: vi.fn(async (opts) => {
        const session = new FakeRunnerSession('s-t1', opts.taskId);
        writeFileSync(join(opts.cwd, 'a.txt'), 'a\n');
        finish = () => session.reportComplete({ status: 'done', summary: 'Done.' });
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const session = makeSession({
      runner,
      isolation: createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '', mintRunId: () => 'run00001' }),
      workspaceRoot: () => root,
      saveSession,
      openTaskLog,
      leaseHost: new LeaseHost(),
      sessionId: 'session-feedface',
    });
    const plan = { tasks: [createTask({ id: 't1', order: 1, title: 'Write a', prompt: 'a' })], runners: ['claude-code'], status: 'approved', generatedAt: '2026-10-31T10:00:00.000Z' } as unknown as LegacyPlanState;
    session.loadPlan(plan, 'The goal', root, { sessionId: 'session-feedface' });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalled());

    const file = '.ordewell/sessions/2026-10-31T10-00-00_the-goal_feedface.json';
    expect(filesUnder(join(root, '.ordewell'), root)).toEqual([
      '.ordewell/.gitignore',
      file,
      '.ordewell/sessions/session-feedface/lease.json',
      '.ordewell/sessions/session-feedface/tasks/t1/1.jsonl',
      '.ordewell/worktrees/run00001/1-write-a/',
    ]);
    expect(readFileSync(join(root, '.ordewell/.gitignore'), 'utf8')).toBe('*\n!.gitignore\n!skills/\n!skills/**\n');
    expect(session.taskLogLocation).toEqual({ baseDir: root, sessionId: 'session-feedface' });

    finish();
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'));
    const saved = JSON.parse(readFileSync(join(root, file), 'utf8')) as { meta: object; plan: { isolation: { run: { tasks: Record<string, object> } } } };
    expect(Object.keys(saved.meta).sort()).toEqual(['createdAt', 'goal', 'id', 'runners', 'status', 'taskCount', 'updatedAt']);
    const { run } = saved.plan.isolation;
    expect(Object.keys(run).sort()).toEqual(['carried', 'id', 'keepsEveryLanding', 'landedOn', 'landedTasks', 'landings', 'repos', 'shared', 'sharedRepos', 'tasks', 'workspaceRoot']);
    expect(run).toMatchObject({ id: 'run00001', workspaceRoot: root });
    expect(Object.keys(run.tasks.t1).sort()).toEqual(['branch', 'order', 'repos', 'status', 'taskId', 'title', 'workspace']);
    session.destroy();
  });
});
