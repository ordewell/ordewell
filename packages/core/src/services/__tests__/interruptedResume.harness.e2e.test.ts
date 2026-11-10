import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { StructuredRunner } from '../StructuredRunner';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { Session } from '../createSession';
import { fakeConfig, patient, removeDir } from '../../testing';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, makeSession } from './sessionTestKit';

/*
 * Ordewell stopping mid-task where nothing ends the attempt the way a Stop
 * does: its process is gone, and its runners with it. What it left on disk is
 * all the next daemon has, so the runner's session must be there already for a
 * Continue to take the task up where it was (ADR-0018 K1). Nothing is faked but
 * the harness's binary: the fake `claude` of bench/pipeline.
 */

const FAKE_CLAUDE = resolve(__dirname, '../../../../../bench/pipeline/fake-claude');
const FAKE_ACP = resolve(__dirname, '../../../../../bench/pipeline/fake-acp');

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
const saved = { PATH: process.env.PATH, FAKE_CLAUDE_STATE: process.env.FAKE_CLAUDE_STATE, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG, FAKE_ACP_NO_RESUME: process.env.FAKE_ACP_NO_RESUME };
// The PATH a runner is looked up on is resolved once a process, so every test here gives the same one.
const fakesFirst = () => [FAKE_CLAUDE, FAKE_ACP, saved.PATH].filter(Boolean).join(delimiter);
afterEach(async () => {
  await closeSessions();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (dirs.length) await removeDir(dirs.pop()!);
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-interrupted-')));
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
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const cue = (spec: unknown) => `<fake-claude>${JSON.stringify(spec)}</fake-claude>`;

interface Said { sessionId: string; prompt?: string }

function said(log: string): Said[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Said) : [];
}

function session(root: string): Session {
  return makeSession({
    runner: new StructuredRunner(),
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) }),
    workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code' }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
  });
}

describe('a task Ordewell stopped under', () => {
  it('is continued in the runner session it was interrupted in, after a restart', async () => {
    process.env.PATH = fakesFirst();
    const state = tempDir();
    const log = join(state, 'said.jsonl');
    process.env.FAKE_CLAUDE_STATE = state;
    process.env.FAKE_CLAUDE_LOG = log;
    const root = repo();

    const first = session(root);
    const task = createTask({ id: 't1', order: 1, title: 'Write the notes', prompt: cue({ untilFile: join(state, 'never') }), assignedRunner: 'claude-code' });
    first.loadPlan({ tasks: [task], runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-10T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', root, { sessionId: 'session-root' });
    await first.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(said(log)).toHaveLength(1), { timeout: patient(20_000), interval: 50 });
    const [{ sessionId: runnerSession }] = said(log);
    // What the runner had written when it was cut off, uncommitted in its worktree.
    writeFileSync(join(first.planState!.isolation!.run.tasks.t1.workspace, 'half-done.txt'), 'the first half\n');

    // A daemon that dies unasked (killed, out of memory, out of processes)
    // ends no attempt and settles no save: what the saves made while the
    // runner worked is all a restart reads, as it reads it here.
    let reloaded!: NonNullable<ReturnType<typeof loadSession>>;
    await vi.waitFor(() => {
      reloaded = loadSession('session-root', root)!;
      expect(reloaded.plan.tasks.find((t) => t.id === 't1')).toMatchObject({ status: 'failed', runnerSessionId: runnerSession, runnerSessionOwner: 'claude-code' });
    }, { timeout: patient(10_000), interval: 100 });
    first.destroy();
    await first.gone;

    const second = session(root);
    second.loadPlan(reloaded.plan, reloaded.meta.goal, root, { sessionId: 'session-root' });
    const outcome = await second.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'Ordewell stopped under you: go on.' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(said(log)).toHaveLength(2), { timeout: patient(20_000), interval: 50 });
    expect(said(log)[1]).toMatchObject({ sessionId: runnerSession, prompt: expect.stringContaining('Ordewell stopped under you: go on.') });
    await vi.waitFor(() => expect(second.planTasks.find((t) => t.id === 't1')?.status).toBe('completed'), { timeout: patient(20_000), interval: 100 });
    // The continue ran where the interrupted attempt had worked, and landed both halves.
    const landed = git(root, 'log', '--all', '--format=', '--name-only').split('\n');
    expect(landed).toEqual(expect.arrayContaining(['half-done.txt', 'fake-claude-output.txt']));
  });

  it('is refused in words that point to a fresh retry when its agent cannot resume a session', async () => {
    process.env.PATH = fakesFirst();
    process.env.FAKE_ACP_NO_RESUME = '1';
    const root = repo();

    const first = session(root);
    const task = createTask({ id: 't1', order: 1, title: 'Write the notes', prompt: '<fake-acp>{"write":{"notes.txt":"notes"}}</fake-acp>', assignedRunner: 'copilot-cli' });
    first.loadPlan({ tasks: [task], runners: ['copilot-cli'], status: 'approved', generatedAt: '2026-11-10T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', root, { sessionId: 'session-root' });
    await first.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.planTasks.find((t) => t.id === 't1')).toMatchObject({ status: 'completed' }), { timeout: patient(5_000), interval: 100 });

    await first.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'One more line, please.' }, { kind: 'user' });

    await vi.waitFor(() => expect(first.planTasks.find((t) => t.id === 't1')?.status).toBe('failed'), { timeout: patient(20_000), interval: 100 });
    const t1 = first.planTasks.find((t) => t.id === 't1')!;
    expect(t1.outputSummary?.reviewReason).toBe('Could not continue task "Write the notes": copilot-cli cannot resume a saved session. Retry starts it afresh.');
    // Kept, it would only offer the same Continue to fail again.
    expect(t1.runnerSessionId).toBeUndefined();
  });
});
