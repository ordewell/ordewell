import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { LegacyPlanState, Task } from '../../models/Task';
import { createTask } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';
import { saveTaskPatch } from '../../utils/taskLogStore';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * What the Changes view reads of a task's diff (`plans.taskDiff`, the saved
 * run) in each kind and state a task can be in, with the run made by the real
 * GitWorktreeIsolation. The saved session is written as SessionSaves writes
 * it: a status save can come while a worktree is still being prepared, and
 * the record is saved only once the task has spawned. Expected causes follow
 * the task's kind as the plan holds it (`runsAsOps`, `readOnly`), never the
 * reader's own wording.
 */

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });

function repo(root: string, files: Record<string, string>): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });

describe('a task diff across task kinds and lifecycle states', () => {
  let tmp: string;
  let workspace: string;
  let gate: string;
  let started: string;
  let setup: string;
  let run: IsolationRun;
  let preparing: Promise<unknown> | undefined;

  const task = (n: number, extra: Partial<Task> = {}): Task => ({ ...createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: 'x' }), ...extra });
  const save = (session: string, tasks: Task[], saved: IsolationRun | undefined, more: Partial<LegacyPlanState> = {}): void => {
    const plan = { tasks, runners: ['claude-code'], status: 'approved', ...(saved ? { isolation: { run: structuredClone(saved), resolvers: {} } } : {}), ...more };
    saveSession(plan as LegacyPlanState, 'goal', workspace, session);
  };
  const patch = Buffer.from('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# r\n+# s\n');
  const artifact = (attempt: number) => ({
    kind: 'patch', path: 'x', attempt, base: run.repos[0].baseRef, files: 1, added: 1, removed: 1, binary: 0,
    bytes: patch.length, sha256: createHash('sha256').update(patch).digest('hex'),
  });
  const ended = (n: number, extra: Partial<Task> = {}): Task => task(n, { status: 'completed', ...extra });

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-diff-life-')));
    workspace = path.join(tmp, 'ws');
    gate = path.join(tmp, 'gate');
    started = path.join(tmp, 'started');
    setup = path.join(tmp, 'setup.cjs');
    repo(workspace, { 'README.md': '# r\n' });
    // A setup command that holds preparation open until the test lets it go, as a slow `npm ci` would.
    fs.writeFileSync(setup, `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(started)}, '');\nconst t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(t); }, 20);\n`);
    const isolation = createWorktreeIsolation({
      config: { worktreeIsolation: true, worktreeSetupCommand: `node "${setup}"`, workspaceRepos: [], worktreeLinks: [] },
      resolvePath: async () => process.env.PATH ?? '',
    });
    run = await isolation.startRun(workspace);
    preparing = isolation.prepare(task(1, { status: 'in_progress' }), run);
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true));
  });

  afterAll(async () => {
    if (gate) fs.writeFileSync(gate, '');
    await preparing?.catch(() => undefined);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads a change task whose worktree is still being prepared as having no record yet, not as a shared run', async () => {
    // The worktree is there and its setup is running; the run has no record of it until prepare ends.
    expect(run.tasks.t1).toBeUndefined();
    save('s-prep', [task(1, { status: 'in_progress' })], run);
    const read = await reader.taskDiff(workspace, 's-prep', 't1', {});
    expect(read).toMatchObject({ available: false, cause: 'no-record' });
    expect(read.available === false && read.reason).not.toMatch(/shared/i);

    fs.writeFileSync(gate, '');
    await preparing;
    expect(run.tasks.t1?.status).toBe('active');
    save('s-prep', [task(1, { status: 'in_progress' })], run);
    expect(await reader.taskDiff(workspace, 's-prep', 't1', {})).toEqual({ available: true, text: 'No files changed since this task started.\n' });
  });

  it('reads a save that has not caught up with an active record as having no record yet', async () => {
    const before = structuredClone(run);
    delete before.tasks.t1;
    save('s-lag', [task(1, { status: 'in_progress' })], before);
    expect(await reader.taskDiff(workspace, 's-lag', 't1', {})).toMatchObject({ available: false, cause: 'no-record' });
  });

  it('names why each kind of task with no record has no diff', async () => {
    const empty = structuredClone(run);
    delete empty.tasks.t1;
    save('k-pending', [task(2)], empty);
    expect(await reader.taskDiff(workspace, 'k-pending', 't2', {})).toMatchObject({ available: false, cause: 'no-record' });
    // An ops task works in the checkout, and a script that is not read-only is one by nature (ADR-0020, ADR-0035).
    save('k-ops', [task(3, { ops: true })], empty);
    expect(await reader.taskDiff(workspace, 'k-ops', 't3', {})).toMatchObject({ available: false, cause: 'not-attributable' });
    save('k-script', [task(4, { type: 'script', script: 'true' })], empty);
    expect(await reader.taskDiff(workspace, 'k-script', 't4', {})).toMatchObject({ available: false, cause: 'not-attributable' });
    save('k-script-ro', [task(4, { type: 'script', script: 'true', readOnly: true })], empty);
    expect(await reader.taskDiff(workspace, 'k-script-ro', 't4', {})).toMatchObject({ available: false, cause: 'read-only' });
    // A record removed by Merge-all, or a read-only task that ended with its report alone: nothing on disk tells these from a task not started.
    save('k-ended', [ended(5)], empty);
    expect(await reader.taskDiff(workspace, 'k-ended', 't5', {})).toMatchObject({ available: false, cause: 'no-record' });
  });

  it('reads a read-only record without running git in its worktree', async () => {
    const readOnly = structuredClone(run);
    readOnly.tasks.t6 = { ...structuredClone(run.tasks.t1), taskId: 't6', readOnly: true };
    // Its worktree holds no repository a read could load: a git run there would fail as an error, not read as read-only.
    readOnly.tasks.t6.repos['.'] = { ...readOnly.tasks.t6.repos['.'], worktree: path.join(tmp, 'not-a-worktree') };
    save('r-live', [task(6, { status: 'in_progress' })], readOnly);
    expect(await reader.taskDiff(workspace, 'r-live', 't6', {})).toMatchObject({ available: false, cause: 'read-only' });
  });

  it('tells a session with no isolated run apart from an unknown session or task', async () => {
    save('n-none', [task(7, { status: 'in_progress' })], undefined);
    const none = await reader.taskDiff(workspace, 'n-none', 't7', {});
    expect(none).toMatchObject({ available: false, cause: 'no-run' });
    expect(none.available === false && none.reason).not.toMatch(/shared runs cannot/i);
    save('n-merged', [ended(7)], undefined, { mergedRun: 'ordewell/run' });
    expect(await reader.taskDiff(workspace, 'n-merged', 't7', {})).toMatchObject({ available: false, cause: 'not-attributable' });
    await expect(reader.taskDiff(workspace, 'n-none', 'nope', {})).rejects.toMatchObject({ code: 'gone' });
    await expect(reader.taskDiff(workspace, 'nope', 't7', {})).rejects.toMatchObject({ code: 'gone' });
  });

  it('reads a saved patch, and calls a missing or changed one an error', async () => {
    const empty = structuredClone(run);
    delete empty.tasks.t1;
    saveTaskPatch({ baseDir: workspace, sessionId: 'p-saved' }, 't8', 1, patch);
    save('p-saved', [ended(8, { handoff: { summary: 's', artifacts: [artifact(1)] } } as Partial<Task>)], empty);
    expect(await reader.taskDiff(workspace, 'p-saved', 't8', {})).toMatchObject({ available: true, text: expect.stringContaining('[repo .] README.md: +1 -1') });
    save('p-missing', [ended(8, { handoff: { summary: 's', artifacts: [artifact(2)] } } as Partial<Task>)], empty);
    expect(await reader.taskDiff(workspace, 'p-missing', 't8', {})).toMatchObject({ available: false, cause: 'error' });
    saveTaskPatch({ baseDir: workspace, sessionId: 'p-changed' }, 't8', 1, Buffer.from('tampered'));
    save('p-changed', [ended(8, { handoff: { summary: 's', artifacts: [artifact(1)] } } as Partial<Task>)], empty);
    expect(await reader.taskDiff(workspace, 'p-changed', 't8', {})).toMatchObject({ available: false, cause: 'error' });
  });

  it('keeps a pruned task diff available, and calls a lost branch or a corrupt record an error', async () => {
    const record = run.tasks.t1;
    const worktree = record.repos['.'].worktree;
    fs.writeFileSync(path.join(worktree, 'work.txt'), 'work\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'work');
    git(workspace, 'worktree', 'remove', '--force', worktree);
    save('g-pruned', [ended(1)], run);
    expect(await reader.taskDiff(workspace, 'g-pruned', 't1', {})).toEqual({ available: true, text: '[repo .] work.txt: +1 -0\n' });

    const older = structuredClone(run);
    delete older.tasks.t1.repos['.'].baseRef;
    save('g-older', [ended(1)], older);
    expect(await reader.taskDiff(workspace, 'g-older', 't1', {})).toMatchObject({ available: false, cause: 'not-attributable' });

    const corrupt = structuredClone(run);
    corrupt.tasks.t1.repos['.'].baseRef = 'not-a-commit';
    save('g-corrupt', [ended(1)], corrupt);
    expect(await reader.taskDiff(workspace, 'g-corrupt', 't1', {})).toMatchObject({ available: false, cause: 'error' });

    git(workspace, 'branch', '-D', record.branch);
    expect(await reader.taskDiff(workspace, 'g-pruned', 't1', {})).toMatchObject({ available: false, cause: 'error' });
  });
});
