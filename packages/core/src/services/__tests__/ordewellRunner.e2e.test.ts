import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { StructuredRunner } from '../StructuredRunner';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, patient, removeDir, setEnv } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, makeSession } from './sessionTestKit';

/*
 * The built-in runner end to end, offline (ADR-0070): a real session, a real
 * worktree and the real in-process loop, with only the provider faked, by the
 * `ordewell-runner` persona of bench/live/mock-provider.mjs. It reads, edits,
 * runs the test through the shell, and ends with task_complete, whose
 * token-bound call is the only thing the verdict rests on. The
 * `ordewell-step-limit` persona never finishes by itself, so the step limit's
 * forced task_complete is what ends its attempt.
 */

// A path, not a file URL: Vite loads a URL's `%20` literally, so a checkout
// whose path holds a space could not find the file.
const START_MOCK = resolve(__dirname, '../../../../../bench/live/start-mock.mjs');
type StartMock = (extraArgs?: string[], options?: { timeoutMs?: number }) => Promise<{ port: number; child: ChildProcess }>;

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await closeSessions();
  while (cleanups.length) cleanups.pop()!();
  while (dirs.length) await removeDir(dirs.pop()!);
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-runner-e2e-')));
  dirs.push(dir);
  return dir;
}

function repo(files: Record<string, string> = {}): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(root, 'test.mjs'), "import { add } from './src/add.mjs';\nif (add(2, 3) === 5) console.log('pass');\nelse { console.log('fail'); process.exit(1); }\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/** A session on a real worktree whose one task, "Fix add", the mock's `persona` drives in `taskMode`. */
async function fixAdd(root: string, persona: string, taskMode: string) {
  const { startMock } = (await import(START_MOCK)) as { startMock: StartMock };
  const { port, child } = await startMock();
  cleanups.push(() => child.kill());
  cleanups.push(setEnv({ OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENROUTER_API_KEY: 'mock-key' }));
  const tasks: Task[] = [
    createTask({
      id: 't', order: 1, title: 'Fix add', prompt: 'add() in src/add.mjs subtracts; make `node test.mjs` pass.',
      assignedRunner: 'openrouter', assignedModel: { modelId: `openrouter:mock/${persona}`, modelLabel: 'mock' }, taskMode,
    }),
  ];
  const session = makeSession({
    runner: new StructuredRunner(),
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) }),
    workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-ordewell',
    config: fakeConfig({ aiProvider: 'openrouter' }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
  });
  session.loadPlan({ tasks, runners: ['openrouter'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'fix add', root, { sessionId: 'session-ordewell' });
  return session;
}

describe('the built-in runner on OpenRouter, offline', () => {
  it('reads, edits, runs the test and completes a real task in a real worktree, the verdict from task_complete', async () => {
    const root = repo();
    const main = git(root, 'rev-parse', 'main');
    const session = await fixAdd(root, 'ordewell-runner', 'full');

    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(session.planTasks[0].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });
    expect(session.planTasks[0].verdict).toMatchObject({ outcome: 'pass', reported: 'done' });
    expect(session.planTasks[0].status).toBe('completed');

    const integration = session.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'show', `${integration}:src/add.mjs`)).toBe('export const add = (a, b) => a + b;');
    expect(git(root, 'log', '--format=%s', integration).split('\n')).toContain('Merge: Fix add() to sum its arguments');
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    // ADR-0032: the runner's transcript lives outside the workspace, so nothing of it lands.
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n').sort()).toEqual(['src/add.mjs', 'test.mjs']);
    expect(existsSync(join(root, 'transcript.jsonl'))).toBe(false);
    session.destroy();
  }, patient(90_000));

  it('ends an attempt at its step limit with the report the forced task_complete made, every tool still offered', async () => {
    const settings = join(tempDir(), 'settings.json');
    writeFileSync(settings, JSON.stringify({ ordewellStepLimit: 3 }));
    cleanups.push(setEnv({ ORDEWELL_SETTINGS_PATH: settings }));

    const session = await fixAdd(repo(), 'ordewell-step-limit', 'full');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(session.planTasks[0].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });
    const task = session.planTasks[0];
    expect(task.verdict).toMatchObject({ outcome: 'fail', reported: 'blocked' });
    const report = task.handoff?.summary ?? '';
    expect(report).toContain('Told it was the last call: true.');
    // The last call keeps the whole toolset, so the provider's cache and the model's view of its tools are unchanged.
    const offered = report.match(/Offered: ([^.]*)\./)?.[1].split(',') ?? [];
    expect(offered).toEqual(expect.arrayContaining(['read', 'edit', 'shell', 'task_complete']));
    session.destroy();
  }, patient(90_000));

  it('runs a Guarded task that asks once for `npm test`, then reuses the grant Allow for this task gave', async () => {
    const root = repo({ 'package.json': JSON.stringify({ name: 'fix-add', private: true, type: 'module', scripts: { test: 'node test.mjs' } }) + '\n' });
    const session = await fixAdd(root, 'ordewell-guarded', 'guarded');
    const asked: string[] = [];
    // A person on the card: the request is the session's own runner approval, answered through it.
    const answering = setInterval(() => {
      for (const open of session.outstandingApprovals()) {
        asked.push(`${open.request.subject} ${open.request.detail ?? ''}`);
        session.resolveApproval(open.id, { decision: 'allowForTask' });
      }
    }, 20);
    cleanups.push(() => clearInterval(answering));

    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(session.planTasks[0].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });
    expect(session.planTasks[0].verdict).toMatchObject({ outcome: 'pass', reported: 'done' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('npm test');
    const integration = session.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'show', `${integration}:src/add.mjs`)).toBe('export const add = (a, b) => a + b;');
    session.destroy();
  }, patient(90_000));
});
