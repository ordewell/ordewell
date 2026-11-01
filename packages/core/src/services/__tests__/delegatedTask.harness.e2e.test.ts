import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { StructuredRunner } from '../StructuredRunner';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { fakeFs, makeSession } from './sessionTestKit';

/*
 * The same climb as delegatedTask.e2e, with nothing of the harness faked but its
 * binary: the fake `claude` of bench/pipeline runs as subplanner and as runner,
 * through the real adapter, the real MCP server and a token bound to the attempt
 * (ADR-0055 D5).
 */

const FAKE_CLAUDE = resolve(__dirname, '../../../../../bench/pipeline/fake-claude');

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
const savedPath = process.env.PATH;
const savedState = process.env.FAKE_CLAUDE_STATE;
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedState === undefined) delete process.env.FAKE_CLAUDE_STATE;
  else process.env.FAKE_CLAUDE_STATE = savedState;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-delegated-harness-')));
  dirs.push(dir);
  return dir;
}

function repo(): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests', 'guard.txt'), 'the check reads this\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const cue = (spec: unknown) => `<fake-claude>${JSON.stringify(spec)}</fake-claude>`;
const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', sliceType: 'AFK', autonomy: 'AFK', dependencies, prompt: cue({ write: { [`${id}.txt`]: `written by ${id}\n` }, summary: `Wrote ${id}.` }),
});

describe('a delegated task on a real harness', () => {
  it('lands a two-task child plan beside its sibling, and only the root reaches the user\'s branch', async () => {
    process.env.PATH = [FAKE_CLAUDE, savedPath].filter(Boolean).join(delimiter);
    process.env.FAKE_CLAUDE_STATE = tempDir();
    const root = repo();
    const main = git(root, 'rev-parse', 'main');
    const turnsFrom = join(process.env.FAKE_CLAUDE_STATE, 'subplanner-turns.json');
    writeFileSync(turnsFrom, JSON.stringify([
      [['submit_plan', { tasks: [childTask('a', 1), childTask('b', 2, ['a'])] }]],
      [['task_complete', { status: 'done', summary: 'a and b are written.', commit: { subject: 'Write a and b' } }]],
    ]));
    const goal = `Write a and b. ${cue({ turnsFrom })}`;
    const tasks: Task[] = [
      createTask({ id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal, budget: { tokens: 5_000_000 }, protectedPaths: ['tests/'], assignedRunner: 'claude-code' }),
      createTask({ id: 's', order: 2, title: 'Sibling', prompt: cue({ delayMs: 200, write: { 's.txt': 'sibling\n' } }), assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Check it', prompt: cue({ write: { 'c.txt': 'checked\n' } }), dependencies: ['d'], assignedRunner: 'claude-code' }),
    ];
    const parent = makeSession({
      runner: new StructuredRunner(),
      isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) }),
      workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code' }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 10_000_000 } }),
      delegationOffered: true,
      childDeps: () => ({ fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
    });
    parent.loadPlan({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'the root goal', root, { sessionId: 'session-root' });

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.planTasks[0].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });
    expect(parent.planTasks[0].verdict).toMatchObject({ outcome: 'pass', reported: 'done' });
    await vi.waitFor(() => expect(parent.planTasks.map((t) => [t.id, t.status])).toEqual([['d', 'completed'], ['s', 'completed'], ['c', 'completed']]), { timeout: 30_000, interval: 100 });

    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 's.txt', 'c.txt']));
    expect(git(root, 'log', '--format=%s', integration).split('\n')).toContain('Merge: Write a and b');
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(await parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true });
    for (const file of ['a.txt', 'b.txt', 's.txt']) expect(existsSync(join(root, file))).toBe(true);
    parent.destroy();
  }, 90_000);
});
