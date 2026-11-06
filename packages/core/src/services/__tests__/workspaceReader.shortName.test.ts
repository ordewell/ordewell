import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { LegacyPlanState } from '../../models/Task';
import { createTask } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * The workspace reader where a run's record and git name one folder two ways,
 * as on Windows: a temp folder under an 8.3 short name (C:\Users\RUNNER~1),
 * which Node's JS realpath keeps and git, like the native realpath, prints
 * long. A link stands in for the short name, and the JS realpath is made to
 * keep it as Windows' does, so every platform runs the case CI hit there.
 */

const alias = vi.hoisted(() => ({ short: '', long: '' }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const nodePath = await import('path');
  const under = (p: string, root: string) => p === root || p.startsWith(root + nodePath.sep);
  const realpathSync = Object.assign((p: import('fs').PathLike, options?: import('fs').EncodingOption): string => {
    const real = actual.realpathSync(p, options);
    if (!alias.short || !under(nodePath.resolve(String(p)), alias.short) || !under(real, alias.long)) return real;
    return alias.short + real.slice(alias.long.length);
  }, { native: actual.realpathSync.native });
  return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

describe.skipIf(!hasGit)('workspace reader under a short name git prints long', () => {
  let tmp: string;
  let workspace: string;
  let run: IsolationRun;
  const session = 'sess-short';
  const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });
  const isolation = createWorktreeIsolation({
    config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
    resolvePath: async () => process.env.PATH ?? '',
  });
  const task = (n: number) => createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: 'x' });
  const at = (taskId: string) => ({ workspace, scope: 'task' as const, sessionId: session, taskId });

  beforeAll(async () => {
    if (!hasGit) return;
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reader-short-')));
    alias.long = path.join(tmp, 'long-name');
    alias.short = path.join(tmp, 'short');
    fs.mkdirSync(alias.long);
    fs.symlinkSync(alias.long, alias.short, process.platform === 'win32' ? 'junction' : 'dir');
    workspace = path.join(alias.short, 'ws');
    fs.mkdirSync(workspace);
    git(workspace, 'init', '-q', '-b', 'main');
    git(workspace, 'config', 'user.name', 'Test');
    git(workspace, 'config', 'user.email', 'test@example.com');
    git(workspace, 'config', 'commit.gpgsign', 'false');
    write(workspace, { 'src/a.ts': 'export const a = 1;\n' });
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '-m', 'initial');

    run = await isolation.startRun(workspace);
    write((await isolation.prepare(task(1), run)).cwd, { 'src/t1.ts': 'one\n' });
    const two = await isolation.prepare(task(2), run);
    // Detached, its worktree is linked to its task by path alone: git names no branch for it.
    git(two.cwd, 'checkout', '-q', '--detach');
    saveSession({ tasks: [task(1), task(2)], runners: ['claude-code'], status: 'approved', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, session);
  });

  afterAll(() => {
    alias.short = '';
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('names the record\'s worktree by the short name git does not print', () => {
    const worktree = run.tasks.t1.repos['.'].worktree;
    expect(worktree.startsWith(alias.short + path.sep)).toBe(true);
    expect(fs.realpathSync.native(git(worktree, 'rev-parse', '--show-toplevel').trim())).toBe(fs.realpathSync.native(worktree));
    expect(git(worktree, 'rev-parse', '--show-toplevel').trim().split(/[\\/]/)).not.toContain('short');
  });

  it('reads a live task from its worktree on disk', async () => {
    expect(await reader.content(at('t1'), 'src/t1.ts')).toMatchObject({ at: { scope: 'task', source: 'disk', branch: run.tasks.t1.branch }, text: 'one\n' });
    const src = await reader.tree(at('t1'), 'src');
    expect(src.entries.map((e) => [e.name, e.status ?? null, e.taskId ?? null])).toEqual([['a.ts', null, null], ['t1.ts', '?', 't1']]);
  });

  it('still confines a task scope to its worktree', async () => {
    await expect(reader.content(at('t1'), '../ws/src/a.ts')).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('links a detached task worktree to its task by its path', async () => {
    const branches = await reader.branches({ workspace });
    const worktree = fs.realpathSync.native(run.tasks.t2.repos['.'].worktree);
    expect(branches.worktrees.find((w) => fs.realpathSync.native(w.path) === worktree)).toMatchObject({
      branch: null, main: false, owner: { sessionId: session, runId: run.id, taskId: 't2' },
    });
  });
});
