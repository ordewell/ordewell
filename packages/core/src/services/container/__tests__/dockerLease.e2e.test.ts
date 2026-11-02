import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync, spawnSync, type ChildProcess } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'http';
import { createServer, type AddressInfo } from 'net';
import { lookup } from 'dns/promises';
import { createWorktreeIsolation } from '../../GitWorktreeIsolation';
import { LeaseHost } from '../../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../../SettingsService';
import { StructuredRunner } from '../../StructuredRunner';
import { BufferedTaskOutputSource } from '../../BufferedTaskOutputSource';
import { GUARANTEES, type LeaseRepo } from '../../executionLease';
import { DONE, SUBMIT } from '../../__tests__/delegationTestKit';
import { fakeFs, fakeNotification, makeSession, scriptedPlanner, type PlannerTurn } from '../../__tests__/sessionTestKit';
import type { IAiService } from '../../AiService';
import { createTask, type LegacyPlanState, type Task } from '../../../models/Task';
import { fakeConfig, FakeExecutionBackend } from '../../../testing';
import { saveSession } from '../../../utils/sessionStore';
import { openTaskLog } from '../../../utils/taskLogStore';
import { LOGIN_VOLUME } from '../containerPreflight';
import { containerStatus, describeContainers } from '../containerSetup';
import { CredentialBroker } from '../credentialBroker';
import { DockerExecutionBackend } from '../dockerLease';
import { SpawnedDockerCli } from '../dockerCli';
import type { EgressPath } from '../egressSidecar';
import { LeaseRelay, RELAY_ENTRY } from '../leaseRelay';
import { reclaimContainers } from '../reclaim';

/*
 * A real task in a real container (ADR-0059 L5, L6). Nothing is faked but the
 * harness's binary, the fake `claude` of bench/pipeline, built into a small
 * image: the real adapter, `docker exec`, the real MCP server through the relay,
 * the gate, and Landing with real git. Off CI's default path, like the sandbox's
 * end-to-end runs: it skips where no engine answers, and where CI has one unless
 * ORDEWELL_REQUIRE_DOCKER=1 asks for it. One suite, so one at a time.
 */

const REQUIRE_DOCKER = process.env.ORDEWELL_REQUIRE_DOCKER === '1';
const engineAnswers = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 }).status === 0;
const skip = (!engineAnswers || process.env.CI !== undefined) && !REQUIRE_DOCKER;

const IMAGE = `ordewell-e2e-fake:${process.pid}`;
const FAKE_CLAUDE = resolve(__dirname, '../../../../../../bench/pipeline/fake-claude/fake-claude.mjs');
const FAKE_OPENCODE = resolve(__dirname, '../../../../../../bench/pipeline/fake-opencode/fake-opencode.mjs');
const DOCKERFILE = `FROM node:22-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git >/dev/null
RUN mkdir -p /task /mirror /login && chown -R node:node /task /mirror /login
COPY fake-claude.mjs /opt/fake-claude.mjs
COPY fake-opencode.mjs /opt/fake-opencode.mjs
COPY claude /usr/local/bin/claude
COPY opencode /usr/local/bin/opencode
USER node
`;
/**
 * Says where it ran, in the work it leaves: on any host but Linux, only a
 * container makes this read Linux. It takes any branch the attempt was seeded
 * with into its own, keeping its own side: nothing on a change task, and a
 * repair's merge, which fake-claude cannot do.
 */
const FAKE_LAUNCHER = `#!/bin/sh
echo "$(uname -s) $(id -u) $HOME" > where-i-ran.txt
echo run >> "$HOME/runs"
wc -l < "$HOME/runs" | tr -d ' ' > runs-of-this-home.txt
for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  git merge -q -X ours --no-edit "$branch" >/dev/null 2>&1 || true
done
exec node /opt/fake-claude.mjs "$@"
`;

/** The OpenCode stand-in says where it ran the same way, then serves. */
const FAKE_OPENCODE_LAUNCHER = `#!/bin/sh
echo "$(uname -s) $(id -u) $HOME" > where-i-ran.txt
exec node /opt/fake-opencode.mjs "$@"
`;

/** The engine's default network, which limits nothing: what a guarantee was measured to have to stop. */
const BRIDGE: EgressPath = { open: async () => ({ runArgs: [], env: {}, proxied: false, gateway: null, close: async () => undefined }) };

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ours = (kind: 'container' | 'volume' | 'network') => (kind === 'container'
  ? docker('container', 'ls', '-a', '--filter', 'name=ordewell-', '--format', '{{.Names}}')
  : docker(kind, 'ls', '--filter', 'name=ordewell-', '--format', '{{.Name}}')).split('\n').filter(Boolean);
const isAttempt = (name: string) => !name.endsWith('-egress');

const dirs: string[] = [];
function tempDir(prefix = 'ordewell-container-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

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
const openCue = (spec: unknown) => `<fake-opencode>${JSON.stringify(spec)}</fake-opencode>`;
const settingsOf = (over: Record<string, unknown> = {}) => ({ image: IMAGE, memory: '512m', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, ...over });

interface SessionOptions {
  egress?: EgressPath;
  key?: Record<string, string>;
  /** Turns of a delegated task's subplanner, which runs on this host in any case. */
  subplanner?: PlannerTurn[];
  repairs?: number;
  /** The runners the plan is for: an OpenCode task needs it named. */
  runners?: string[];
}

function session(root: string, tasks: Task[], settings = settingsOf(), { egress, key, subplanner, repairs = 0, runners = ['claude-code'] }: SessionOptions = {}) {
  const told: string[] = [];
  const planner = subplanner && scriptedPlanner(subplanner);
  const notifications = fakeNotification();
  const taskOutput = new BufferedTaskOutputSource();
  const parent = makeSession({
    runner: new StructuredRunner(),
    taskOutput,
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), noHooks: true }),
    workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: `docker-e2e-${process.pid}-${tasks[0].id}`,
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code', conflictRepairAttempts: repairs }),
    notifications,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 10_000_000 } }),
    delegationOffered: subplanner !== undefined,
    childDeps: () => ({ ...(planner ? { aiService: { reset: vi.fn(), ...planner.service } as unknown as IAiService } : {}), fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
    execution: (local, context) => new DockerExecutionBackend(local, {
      settings,
      broker: new CredentialBroker(key ?? { ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key' }),
      ...(egress ? { egress } : {}),
      sessionId: context.sessionId,
      treeId: context.treeId,
      tell: (level, text) => { told.push(`${level}: ${text}`); context.tell(level, text); },
    }),
  });
  parent.loadPlan({ tasks, runners, status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', root, { sessionId: `docker-e2e-${process.pid}-${tasks[0].id}` });
  return { parent, told, notifications, taskOutput, integration: () => parent.planState?.isolation?.run.repos[0].integrationBranch ?? '' };
}

const settled = (s: ReturnType<typeof session>['parent'], index = 0) => vi.waitFor(() => expect(s.planTasks[index].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });

/**
 * A controlled Anthropic model: no network, no key, and a scripted turn. It
 * writes one file, asks Ordewell's own `task_complete` through the relayed MCP
 * server, then ends. That is the whole of what a containerised OpenCode task
 * does with a model, without a provider or a bill.
 */
function controlledModel() {
  const asked: string[] = [];
  let writes = 0;
  const sse = (res: import('http').ServerResponse, blocks: readonly Record<string, unknown>[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    event({ type: 'message_start', message: { id: `msg_${asked.length}`, type: 'message', role: 'assistant', model: 'controlled', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    blocks.forEach((block, index) => {
      if (block.type === 'text') {
        event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      } else {
        event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${asked.length}_${index}`, name: block.name, input: {} } });
        event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      }
      event({ type: 'content_block_stop', index });
    });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
    event({ type: 'message_stop' });
    res.end();
  };
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body) as { system?: unknown; messages?: { content?: unknown }[] }; } catch { return {}; } })();
      const system = JSON.stringify(parsed.system ?? '');
      const last = parsed.messages?.at(-1)?.content;
      const text = Array.isArray(last)
        ? last.map((block: { type?: string; text?: string; content?: unknown }) => (block.type === 'text' ? block.text ?? '' : block.type === 'tool_result' ? JSON.stringify(block.content) : '')).join(' ')
        : String(last ?? '');
      asked.push(text.slice(0, 120));
      // A title is asked for before the turn, with a prompt of its own.
      if (system.includes('name conversations')) return sse(res, [{ type: 'text', text: 'A containerised task' }]);
      if (text.includes('Recorded')) return sse(res, [{ type: 'text', text: 'Done.' }]);
      if (text.includes('Wrote file') || text.includes('Created file')) {
        return sse(res, [{ type: 'tool_use', name: 'ordewell_task_complete', input: { status: 'done', summary: 'The controlled model wrote it.' } }]);
      }
      // A schema change in a later OpenCode would make the same call fail forever; one retry, then the turn ends without a completion.
      if (writes++ > 0) return sse(res, [{ type: 'text', text: 'The write tool was refused.' }]);
      return sse(res, [{ type: 'tool_use', name: 'write', input: { path: 'provider.txt', content: 'from the controlled model\n' } }]);
    });
  });
  return { server, asked };
}

describe.skipIf(skip)('a task in a real container', () => {
  const before: Record<'container' | 'volume' | 'network', string[]> = { container: [], volume: [], network: [] };

  beforeAll(() => {
    before.container = ours('container');
    before.volume = ours('volume');
    before.network = ours('network');
    const context = tempDir('ordewell-image-');
    writeFileSync(join(context, 'Dockerfile'), DOCKERFILE);
    copyFileSync(FAKE_CLAUDE, join(context, 'fake-claude.mjs'));
    copyFileSync(FAKE_OPENCODE, join(context, 'fake-opencode.mjs'));
    writeFileSync(join(context, 'claude'), FAKE_LAUNCHER);
    chmodSync(join(context, 'claude'), 0o755);
    writeFileSync(join(context, 'opencode'), FAKE_OPENCODE_LAUNCHER);
    chmodSync(join(context, 'opencode'), 0o755);
    docker('build', '-q', '-t', IMAGE, context);
  }, 180_000);

  /** The attempts in the engine now, with no sidecar beside them. */
  const attempts = () => ours('container').filter((n) => !before.container.includes(n) && isAttempt(n));

  afterAll(() => {
    for (const name of ours('container').filter((n) => !before.container.includes(n))) spawnSync('docker', ['rm', '-f', name]);
    for (const name of ours('network').filter((n) => !before.network.includes(n))) spawnSync('docker', ['network', 'rm', name]);
    for (const name of ours('volume').filter((n) => !before.volume.includes(n))) spawnSync('docker', ['volume', 'rm', '-f', name]);
    spawnSync('docker', ['image', 'rm', '-f', IMAGE]);
  }, 60_000);

  it('runs in the container, comes back through the gate, and lands on the integration branch', async () => {
    const root = repo();
    const main = git(root, 'rev-parse', 'main');
    const tasks = [createTask({ id: 'a', order: 1, title: 'Write a', prompt: cue({ write: { 'a.txt': 'written in the container\n' }, summary: 'Wrote a.' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0]).toMatchObject({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } });
    const integration = env.integration();
    expect(git(root, 'show', `${integration}:a.txt`)).toBe('written in the container');
    expect(git(root, 'show', `${integration}:where-i-ran.txt`)).toBe('Linux 1000 /task/home');
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(env.told.filter((line) => line.startsWith('warn')).join()).not.toContain('network');
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 30_000 });
    await vi.waitFor(() => expect(ours('network').filter((n) => !before.network.includes(n))).toEqual([]), { timeout: 30_000 });
    await vi.waitFor(() => expect(ours('volume').filter((n) => n.startsWith('ordewell-task-') && !before.volume.includes(n))).toEqual([]), { timeout: 30_000 });

    expect(await env.parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('written in the container\n');
    env.parent.destroy();
  }, 120_000);

  it('runs an OpenCode change task in the container, and lands its work', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'o', order: 1, title: 'OpenCode o', prompt: openCue({ write: { 'o.txt': 'written by opencode\n' }, summary: 'Wrote o.' }), assignedRunner: 'opencode' })];
    const env = session(root, tasks, settingsOf(), { runners: ['claude-code', 'opencode'] });

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0]).toMatchObject({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } });
    const integration = env.integration();
    expect(git(root, 'show', `${integration}:o.txt`)).toBe('written by opencode');
    expect(git(root, 'show', `${integration}:where-i-ran.txt`)).toBe('Linux 1000 /task/home');
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 30_000 });
    env.parent.destroy();
  }, 120_000);

  it.skipIf(!process.env.ORDEWELL_E2E_OPENCODE_IMAGE)('runs a real OpenCode task in a container against a controlled model, through the lease gateway', async () => {
    // Build an image with `npm install -g @opencode/cli` and `git`, as `docker/task.Dockerfile` shows, and name it in ORDEWELL_E2E_OPENCODE_IMAGE.
    const model = controlledModel();
    await new Promise<void>((done) => model.server.listen(0, '127.0.0.1', done));
    const modelPort = (model.server.address() as AddressInfo).port;
    try {
      const root = repo();
      const tasks = [createTask({
        id: 'r', order: 1, title: 'Real OpenCode', prompt: 'Write provider.txt and complete the task.', assignedRunner: 'opencode',
        assignedModel: { modelId: 'anthropic/claude-sonnet-5', modelLabel: 'claude-sonnet-5', availableVariants: [] },
      })];
      const env = session(root, tasks, settingsOf({
        image: process.env.ORDEWELL_E2E_OPENCODE_IMAGE, memory: '2g',
        login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] },
        required: ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata', 'cred.unreadable'],
      }), { runners: ['claude-code', 'opencode'], key: { ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}` } });

      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(env.parent);

      expect(env.parent.planTasks[0]).toMatchObject({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } });
      expect(git(root, 'show', `${env.integration()}:provider.txt`)).toBe('from the controlled model');
      // The real binary reached Ordewell's server through the relay, and the model's traffic reached this host's gateway.
      expect(model.asked.some((line) => line.includes('Recorded'))).toBe(true);
      env.parent.destroy();
    } finally {
      model.server.close();
    }
  }, 180_000);

  it('a Continue resumes an OpenCode session in the home its volume kept (ADR-0059 L2)', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'c', order: 1, title: 'Continue c', prompt: openCue({ write: { 'partial.txt': 'half done\n' }, status: 'blocked', reason: 'stuck' }), assignedRunner: 'opencode' })];
    const env = session(root, tasks, settingsOf(), { runners: ['claude-code', 'opencode'] });

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);
    expect(env.parent.planTasks[0].status).toBe('failed');
    const resumed = env.parent.planTasks[0].runnerSessionId;
    expect(resumed).toMatch(/^ses_/);

    const continued = await env.parent.execute({ command: 'retry_task', task: 'c', from: 'session', message: openCue({ write: { 'c.txt': 'continued\n' }, summary: 'Went on.' }) }, { kind: 'user' });
    expect(continued).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'), { timeout: 60_000, interval: 100 });

    const integration = env.integration();
    expect(git(root, 'show', `${integration}:c.txt`)).toBe('continued');
    expect(git(root, 'show', `${integration}:partial.txt`)).toBe('half done');
    expect(env.parent.planTasks[0].attemptUsage?.map((usage) => usage.sessionId)).toEqual([resumed, resumed]);
    env.parent.destroy();
  }, 120_000);

  it("gives an OpenCode task its own copy of a person's sign-in, which reaches neither the original nor the next task", async () => {
    const hadLogin = spawnSync('docker', ['volume', 'inspect', 'ordewell-login-opencode']).status === 0;
    docker('volume', 'create', 'ordewell-login-opencode');
    docker('run', '--rm', '--network', 'none', '-v', 'ordewell-login-opencode:/login', IMAGE, 'sh', '-c', 'mkdir -p /login/opencode && echo original > /login/opencode/auth.json');
    try {
      const root = repo();
      const tasks = [createTask({ id: 'p', order: 1, title: 'Sign-in p', prompt: openCue({ readSignIn: true, forgeSignIn: true, write: { 'p.txt': 'read it\n' }, summary: 'Read the sign-in.' }), assignedRunner: 'opencode' })];
      const env = session(root, tasks, settingsOf({ login: { kind: 'own-sign-in' } }), { runners: ['claude-code', 'opencode'] });

      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(env.parent);

      expect(env.parent.planTasks[0].status).toBe('completed');
      expect(git(root, 'show', `${env.integration()}:sign-in-read.txt`)).toBe('original');
      expect(docker('run', '--rm', '--network', 'none', '-v', 'ordewell-login-opencode:/login:ro', IMAGE, 'cat', '/login/opencode/auth.json')).toBe('original');
      env.parent.destroy();
    } finally {
      if (!hadLogin) docker('volume', 'rm', '-f', 'ordewell-login-opencode');
    }
  }, 120_000);

  it("keeps a failed attempt's work in its worktree, as a local attempt's stays", async () => {
    const root = repo();
    const tasks = [createTask({ id: 'b', order: 1, title: 'Fail b', prompt: cue({ write: { 'partial.txt': 'half done\n' }, status: 'blocked', reason: 'stuck' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0].status).toBe('failed');
    const record = Object.values(env.parent.planState?.isolation?.run.tasks ?? {})[0];
    const worktree = Object.values(record.repos)[0].worktree;
    await vi.waitFor(() => expect(existsSync(join(worktree, 'partial.txt'))).toBe(true), { timeout: 30_000 });
    expect(readFileSync(join(worktree, 'partial.txt'), 'utf8')).toBe('half done\n');
    env.parent.destroy();
  }, 120_000);

  it('stops every process of a running attempt, and leaves no container', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'c', order: 1, title: 'Stop c', prompt: cue({ delayMs: 60_000 }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(attempts()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    await new Promise((done) => setTimeout(done, 1500));

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });

    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 45_000, interval: 200 });
    expect(env.parent.planTasks[0].status).toBe('pending');
    env.parent.destroy();
  }, 120_000);

  it('a Continue resumes the session in the home its volume kept, on the work it left (ADR-0059 L2)', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'k', order: 1, title: 'Block k', prompt: cue({ write: { 'partial.txt': 'half done\n' }, status: 'blocked', reason: 'stuck' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);
    expect(env.parent.planTasks[0].status).toBe('failed');
    const resumed = env.parent.planTasks[0].runnerSessionId;
    expect(resumed).toMatch(/^fake-claude-/);

    const continued = await env.parent.execute({ command: 'retry_task', task: 'k', from: 'session', message: cue({ write: { 'k.txt': 'continued\n' }, summary: 'Went on.' }) }, { kind: 'user' });
    expect(continued).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'), { timeout: 60_000, interval: 100 });

    const integration = env.integration();
    expect(git(root, 'show', `${integration}:k.txt`)).toBe('continued');
    expect(git(root, 'show', `${integration}:partial.txt`)).toBe('half done');
    // The second run of one home, which only a kept volume makes it.
    expect(git(root, 'show', `${integration}:runs-of-this-home.txt`)).toBe('2');
    expect(env.parent.planTasks[0].attemptUsage?.map((usage) => usage.sessionId)).toEqual([resumed, resumed]);
    env.parent.destroy();
  }, 120_000);

  it('brings the work back for a Mark complete straight after a Stop: nothing lands an empty worktree', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'm', order: 1, title: 'Vouch m', prompt: cue({ delayMs: 60_000 }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);
    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(attempts()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    const [box] = attempts();
    await vi.waitFor(() => expect(spawnSync('docker', ['exec', box, 'sh', '-c', 'test -d /task/work/.git && echo vouched > /task/work/vouched.txt']).status).toBe(0), { timeout: 30_000, interval: 200 });

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });
    const marked = await env.parent.execute({ command: 'mark_complete', task: 'm', confirmed: true, seen: env.parent.planTasks[0].status }, { kind: 'user' });

    expect(marked).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'), { timeout: 60_000, interval: 100 });
    expect(git(root, 'show', `${env.integration()}:vouched.txt`)).toBe('vouched');
    env.parent.destroy();
  }, 120_000);

  it('plants nothing on this host: what a hostile attempt writes under `.git` stays in its volume', async () => {
    const root = repo();
    const planted = { '.git/hooks/post-merge': '#!/bin/sh\ntouch /tmp/owned\n', '.git/config.bad': 'x', 'b.txt': 'ordinary work\n' };
    const tasks = [createTask({ id: 'd', order: 1, title: 'Plant', prompt: cue({ write: planted, summary: 'Planted.' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0].status).toBe('completed');
    expect(git(root, 'ls-tree', '-r', '--name-only', env.integration()).split('\n').sort()).toEqual(['README.md', 'b.txt', 'runs-of-this-home.txt', 'where-i-ran.txt']);
    expect(existsSync(join(root, '.git', 'hooks', 'post-merge'))).toBe(false);
    env.parent.destroy();
  }, 120_000);

  describe('a hook written into a folder the repository tracks (ADR-0059 L2, L6)', () => {
    const planted = (root: string, id: string, report: Record<string, unknown>) => {
      mkdirSync(join(root, '.husky'));
      writeFileSync(join(root, '.husky', 'README.md'), 'the project keeps its hooks here\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'a folder for hooks');
      git(root, 'config', 'core.hooksPath', '.husky');
      const canary = join(tempDir(), 'hook-ran');
      const hook = `#!/bin/sh\ntouch "${canary}"\n`;
      return { canary, tasks: [createTask({ id, order: 1, title: 'Plant a hook', prompt: cue({ write: { '.husky/pre-commit': hook, '.husky/post-index-change': hook }, ...report }), assignedRunner: 'claude-code' })] };
    };
    it('runs nothing and lands nothing, and the landing waits on the user', async () => {
      const root = repo();
      const { canary, tasks } = planted(root, 'h1', { summary: 'Planted.' });
      const env = session(root, tasks);
      const volumes = ours('volume');
      const held = () => ours('volume').filter((name) => !volumes.includes(name) && name.startsWith('ordewell-held-'));

      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('awaiting_user'), { timeout: 60_000, interval: 100 });

      await vi.waitFor(() => expect(vi.mocked(env.notifications.error).mock.calls.join()).toContain('where git looks for this repository\'s hooks'));
      expect(held()).toHaveLength(1);
      expect(git(root, 'ls-tree', '-r', '--name-only', env.integration())).not.toContain('pre-commit');
      expect(existsSync(canary)).toBe(false);
      env.parent.destroy();
      await env.parent.gone;
    }, 120_000);

    it('refuses a Continue rather than seeding over it, until a Retry gives it up', async () => {
      const root = repo();
      const { canary, tasks } = planted(root, 'h2', { status: 'blocked', reason: 'stuck' });
      const env = session(root, tasks);
      const volumes = ours('volume');
      const added = (prefix: string) => ours('volume').filter((name) => !volumes.includes(name) && name.startsWith(prefix));

      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(env.parent);
      const toldOf = () => env.told.filter((line) => line.includes('stays in its container\'s volume')).length;
      await vi.waitFor(() => expect(toldOf()).toBe(1), { timeout: 30_000 });

      await env.parent.execute({ command: 'retry_task', task: 'h2', from: 'session', message: cue({ write: { 'k.txt': 'x\n' }, summary: 'Went on.' }) }, { kind: 'user' });
      await vi.waitFor(() => expect(vi.mocked(env.notifications.error).mock.calls.join()).toContain('until you retry the task'), { timeout: 30_000, interval: 100 });
      expect(env.parent.planTasks[0].status).toBe('failed');
      expect(added('ordewell-held-')).toHaveLength(1);
      expect(added('ordewell-task-')).toHaveLength(1);

      await env.parent.execute({ command: 'retry_task', task: 'h2', from: 'fresh' }, { kind: 'user' });
      await vi.waitFor(() => expect(toldOf()).toBe(2), { timeout: 60_000, interval: 100 });
      expect(existsSync(canary)).toBe(false);
      env.parent.destroy();
      await env.parent.gone;
    }, 120_000);
  });

  it('takes its container, relay and way out with it as a Session closes, and keeps the volume (ADR-0059 L5)', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'closes', order: 1, title: 'Run on', prompt: cue({ delayMs: 60_000 }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);
    const was = { container: ours('container'), volume: ours('volume'), network: ours('network') };
    const added = (kind: keyof typeof was) => ours(kind).filter((name) => !was[kind].includes(name));

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(env.parent.isExecuting && added('container').length > 0).toBe(true), { timeout: 60_000, interval: 100 });

    env.parent.destroy();
    await env.parent.gone;

    expect(added('container')).toEqual([]);
    expect(added('network')).toEqual([]);
    expect(added('volume').filter((name) => name.startsWith('ordewell-task-'))).toHaveLength(1);
  }, 120_000);

  it('refuses the lease, and starts no runner, on a network the probe finds open', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'e', order: 1, title: 'Needs an allowlist', prompt: cue({ write: { 'e.txt': 'x' } }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks, settingsOf(), { egress: BRIDGE });

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(vi.mocked(env.notifications.error).mock.calls.join()).toContain('net.allowlist'), { timeout: 60_000, interval: 100 });
    expect(env.parent.planTasks[0].status).not.toBe('completed');
    expect(env.parent.planTasks[0].verdict).toBeUndefined();
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 30_000 });
    env.parent.destroy();
  }, 120_000);

  it('proves on a real engine what it says it proves, the network with it', async () => {
    const backend = new DockerExecutionBackend(new FakeExecutionBackend(), { settings: settingsOf(), sessionId: () => 'probe', tell: () => undefined });

    const report = await backend.probe();

    for (const guarantee of ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata'] as const) {
      expect(report[guarantee], `${guarantee}: ${report[guarantee].by}`).toMatchObject({ proven: true });
    }
    expect(report['cred.unreadable'], 'a probe holds no login').toMatchObject({ proven: false });
    expect(Object.keys(report).sort()).toEqual([...GUARANTEES].sort());
    await vi.waitFor(() => expect(ours('network').filter((n) => !before.network.includes(n))).toEqual([]), { timeout: 30_000 });
  }, 60_000);

  it('reports on a real engine what a check proved apart from what it assumes, and leaves nothing', async () => {
    const status = await containerStatus(settingsOf(), { prove: true, broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' }) });

    expect(status, JSON.stringify(status.problems)).toMatchObject({ on: true, ready: true, problems: [] });
    expect(Object.fromEntries(status.guarantees!.filter(({ required }) => required).map(({ guarantee, proven }) => [guarantee, proven]))).toEqual({ 'fs.hostHidden': true, 'fs.writeScope': true, 'limits.memory': true, 'net.allowlist': true, 'net.noMetadata': true });
    expect(status.guarantees!.find(({ guarantee }) => guarantee === 'cred.unreadable')).toMatchObject({ proven: false });
    expect(describeContainers(status).join('\n')).toContain('Assumed or left uncovered, and never proven:');
    await vi.waitFor(() => {
      expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]);
      expect(ours('network').filter((n) => !before.network.includes(n))).toEqual([]);
    }, { timeout: 30_000 });
  }, 60_000);

  it('names an image that was never built, on a real engine, and starts nothing to find out', async () => {
    const status = await containerStatus(settingsOf({ image: `ordewell-never-built:${process.pid}` }), { prove: true, broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' }) });

    expect(status.ready).toBe(false);
    expect(status.problems.map(({ code }) => code)).toEqual(['image-missing']);
    expect(status.guarantees).toBeUndefined();
  }, 30_000);

  it('hands a task a copy of the sign-in: what it forges stops there, for the original and the next task', async (test) => {
    const hadLogin = spawnSync('docker', ['volume', 'inspect', LOGIN_VOLUME]).status === 0;
    if (hadLogin) test.skip();
    docker('volume', 'create', LOGIN_VOLUME);
    try {
      docker('run', '--rm', '--network', 'none', '-v', `${LOGIN_VOLUME}:/login`, IMAGE, 'sh', '-c', 'mkdir -p /login/claude && echo original > /login/claude/.credentials.json');
      const first = leaseWith('forger', [worktreeOf(repo(), 'ordewell/forger')], settingsOf({ login: { kind: 'own-sign-in' } }));
      const second = leaseWith('heir', [worktreeOf(repo(), 'ordewell/heir')], settingsOf({ login: { kind: 'own-sign-in' } }));

      const forger = await first.open();
      const forged = await forger.run('echo forged > "$CLAUDE_CONFIG_DIR/.credentials.json"; cat "$CLAUDE_CONFIG_DIR/.credentials.json"; cat /login/claude/.credentials.json; echo "original $?"');
      const heir = await second.open();
      const inherited = await heir.run('cat "$CLAUDE_CONFIG_DIR/.credentials.json"');

      expect(forged.stdout.trim().split('\n')).toEqual(['forged', 'original 1']);
      expect(inherited.stdout.trim()).toBe('original');
      expect(docker('run', '--rm', '--network', 'none', '-v', `${LOGIN_VOLUME}:/login:ro`, IMAGE, 'cat', '/login/claude/.credentials.json')).toBe('original');
      forger.lease.release('done');
      heir.lease.release('done');
      await first.backend.letGo('forger', { keep: false, reason: 'done' });
      await second.backend.letGo('heir', { keep: false, reason: 'done' });
    } finally {
      docker('volume', 'rm', '-f', LOGIN_VOLUME);
    }
  }, 120_000);

  it('keeps what one task leaves in its package cache from the next task on the same project', async () => {
    const root = repo();
    const first = leaseOver('poisoner', [worktreeOf(root, 'ordewell/poisoner')]);
    const second = leaseOver('reader', [worktreeOf(root, 'ordewell/reader')]);

    const poisoner = await first.open();
    await poisoner.run('mkdir -p "$npm_config_cache" && echo poison > "$npm_config_cache/_cacache"');
    const reader = await second.open();
    const found = await reader.run('ls "$npm_config_cache/_cacache" 2>/dev/null; echo "cache $?"');

    expect(found.stdout.trim()).toBe('cache 2');
    poisoner.lease.release('done');
    reader.lease.release('done');
    await first.backend.letGo('poisoner', { keep: false, reason: 'done' });
    await second.backend.letGo('reader', { keep: false, reason: 'done' });
  }, 90_000);

  it('catches, by that probe, what the default network was measured to let through', async () => {
    const backend = new DockerExecutionBackend(new FakeExecutionBackend(), { settings: settingsOf(), egress: BRIDGE, sessionId: () => 'probe', tell: () => undefined });

    const report = await backend.probe();

    expect(report['net.allowlist'], report['net.allowlist'].by).toMatchObject({ proven: false });
    console.log(`[measure] on the default network: ${report['net.allowlist'].by}`);
  }, 60_000);

  it.each<[string, (entry: ChildProcess) => void]>([
    ['its client is killed', (entry) => entry.kill('SIGKILL')],
    // What a host's death is to the client it leaves behind: its stdin closes.
    ['its host dies and the pipe closes', (entry) => entry.stdin?.end()],
  ])('goes with its host: the container ends when %s', async (label, end) => {
    const name = `ordewell-e2e-entry-${process.pid}-${label.length}`;
    const entry = await new SpawnedDockerCli().entry(['run', '-i', '--rm', '--name', name, '--init', '--pids-limit', '8192', '--memory', '256m', '--memory-swap', '256m', IMAGE, 'node', '-e', RELAY_ENTRY]);
    await new LeaseRelay(entry).ready;
    expect(docker('ps', '--filter', `name=${name}`, '--format', '{{.Names}}')).toBe(name);

    end(entry);

    await vi.waitFor(() => expect(docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}')).toBe(''), { timeout: 30_000, interval: 200 });
  }, 60_000);

  const leaseOver = (taskId: string, repos: LeaseRepo[], memory = '512m') => leaseWith(taskId, repos, settingsOf({ memory }));
  const leaseOverImage = (taskId: string, repos: LeaseRepo[], image: string) => leaseWith(taskId, repos, settingsOf({ image }));

  /** One lease on real repositories with no Session around it, to run a command by placement as a runner would be. */
  function leaseWith(taskId: string, repos: LeaseRepo[], settings: ReturnType<typeof settingsOf>, key: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-api03-x' }) {
    const local = new FakeExecutionBackend();
    local.repos = repos;
    const told: string[] = [];
    const backend = new DockerExecutionBackend(local, { settings, broker: new CredentialBroker(key), sessionId: () => `${taskId}-${process.pid}`, tell: (_level, text) => told.push(text) });
    return {
      backend,
      told,
      open: async (intent: 'fresh' | 'repair' = 'fresh') => {
        const reserved = backend.reserve({ node: { sessionId: taskId, taskId }, role: 'task', runner: 'claude-code' });
        if ('refused' in reserved) throw new Error(reserved.refused);
        const opened = await reserved.lease.open({ task: createTask({ id: taskId, order: 1, title: taskId, prompt: 'x' }), workspace: { kind: 'worktree', intent }, required: [] }, new AbortController().signal);
        const placedRun = async (command: string, args: string[]) => {
          const placed = await opened.placement!.place({ command, args, env: {}, files: [] });
          const ran = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
            execFile('docker', placed.args, { encoding: 'utf8', env: { ...process.env, ...placed.env } }, (err, stdout, stderr) => done({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
          });
          placed.ended();
          return ran;
        };
        const run = (script: string, cwd?: string) => placedRun('sh', ['-c', cwd ? `cd ${cwd} && ${script}` : script]);
        const node = (code: string) => placedRun('node', ['-e', code]);
        return { opened, run, node, lease: reserved.lease };
      },
    };
  }

  function worktreeOf(root: string, branch: string): LeaseRepo {
    const worktree = join(tempDir(), 'wt');
    git(root, 'worktree', 'add', '-q', '-b', branch, worktree);
    git(root, 'branch', `${branch}-integration`);
    return { path: '.', root, worktree, branch, integrationBranch: `${branch}-integration`, linked: [] };
  }

  /** Tried from inside, as a process an agent started would try: what each connection did. */
  const TRY_CONNECT = (targets: string[]) => `
    const net = require('net');
    const tried = (target) => new Promise((resolve) => {
      const at = target.lastIndexOf(':');
      const socket = net.connect({ host: target.slice(0, at), port: Number(target.slice(at + 1)), timeout: 1500 });
      const done = (answer) => { socket.destroy(); resolve(target + ' ' + answer); };
      socket.on('connect', () => done('connected'));
      socket.on('timeout', () => done('timed out'));
      socket.on('error', (err) => done(err.code));
    });
    Promise.all(${JSON.stringify(targets)}.map(tried)).then((lines) => console.log(lines.join('\\n')));
  `;

  /** A CONNECT by hand through the lease's proxy, as a client that reads the variable would send it. */
  const THROUGH_PROXY = (target: string) => `
    const net = require('net');
    const { hostname, port } = new URL(process.env.HTTPS_PROXY);
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.on('connect', () => socket.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'));
    socket.once('data', (chunk) => { console.log(String(chunk).split('\\r\\n')[0]); socket.destroy(); });
    socket.on('error', (err) => console.log(err.code));
  `;

  it('stops the two ways out a bridge container took, for a real process that ignores every setting', async () => {
    let hits = 0;
    const listener = createServer((socket) => { hits += 1; socket.destroy(); });
    await new Promise<void>((done) => { listener.listen(0, '127.0.0.1', done); });
    const { port } = listener.address() as AddressInfo;
    const lease = leaseOver('walled', [worktreeOf(repo(), 'ordewell/walled')]);
    const { opened, node, lease: reserved } = await lease.open();

    expect(opened.guarantees['net.allowlist'], opened.guarantees['net.allowlist'].by).toMatchObject({ proven: true });
    const direct = (await node(TRY_CONNECT(['1.1.1.1:443', `host.docker.internal:${port}`, `host.lima.internal:${port}`, '169.254.169.254:80']))).stdout.trim().split('\n');

    expect(direct).toHaveLength(4);
    for (const line of direct) expect(line).not.toContain('connected');
    expect((await node(THROUGH_PROXY('1.1.1.1:443'))).stdout.trim()).toMatch(/^HTTP\/1\.1 403 /);
    expect((await node(THROUGH_PROXY(`host.docker.internal:${port}`))).stdout.trim()).toMatch(/^HTTP\/1\.1 403 /);
    expect((await node(THROUGH_PROXY('169.254.169.254:80'))).stdout.trim()).toMatch(/^HTTP\/1\.1 403 /);
    expect(hits).toBe(0);
    // The sidecar's other side: what else is on the bridge is no client of it.
    const [sidecar] = ours('container').filter((name) => !before.container.includes(name) && !isAttempt(name));
    const onTheBridge = docker('inspect', '--format', '{{.NetworkSettings.Networks.bridge.IPAddress}}', sidecar);
    expect(docker('run', '--rm', '--init', '--pids-limit', '8192', '--memory', '256m', IMAGE, 'node', '-e', TRY_CONNECT([`${onTheBridge}:3128`]))).toBe(`${onTheBridge}:3128 ECONNREFUSED`);
    listener.close();
    reserved.release('done');
    await lease.backend.letGo('walled', { keep: false, reason: 'done' });
  }, 90_000);

  it('opens a listed host through its sidecar, end to end over TLS', async (test) => {
    if (await lookup('registry.npmjs.org').then(() => false, () => true)) return test.skip();
    const lease = leaseWith('listed', [worktreeOf(repo(), 'ordewell/listed')], settingsOf({ allow: ['registry.npmjs.org'] }));
    const { node, lease: reserved } = await lease.open();

    const reached = await node(`
      const net = require('net');
      const tls = require('tls');
      const { hostname, port } = new URL(process.env.HTTPS_PROXY);
      const socket = net.connect({ host: hostname, port: Number(port) });
      socket.on('connect', () => socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\n\\r\\n'));
      socket.once('data', () => {
        const secure = tls.connect({ socket, servername: 'registry.npmjs.org' }, () => secure.write('GET /-/ping HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\nConnection: close\\r\\n\\r\\n'));
        secure.once('data', (chunk) => { console.log(String(chunk).split('\\r\\n')[0]); secure.destroy(); });
      });
    `);

    expect(reached.stdout.trim()).toMatch(/^HTTP\/1\.1 200/);
    expect((await node(THROUGH_PROXY('example.com:443'))).stdout.trim()).toMatch(/^HTTP\/1\.1 403 /);
    reserved.release('done');
    await lease.backend.letGo('listed', { keep: false, reason: 'done' });
  }, 90_000);

  it('carries a runner\'s model traffic to the upstream under the key, which it never held', async () => {
    const heard: { url?: string; headers: IncomingHttpHeaders }[] = [];
    const upstream = createHttpServer((req, res) => {
      heard.push({ url: req.url, headers: req.headers });
      req.resume();
      res.end('{"answered":true}');
    });
    await new Promise<void>((done) => { upstream.listen(0, '127.0.0.1', done); });
    const key = 'sk-ant-api03-held-at-the-gateway';
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const lease = leaseWith('gated', [worktreeOf(repo(), 'ordewell/gated')], settingsOf({ login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] }, required: ['cred.unreadable'] }), { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: url });
    const { opened, node, run, lease: reserved } = await lease.open();

    expect(opened.guarantees['cred.unreadable'], opened.guarantees['cred.unreadable'].by).toMatchObject({ proven: true });
    const asked = await node(`
      fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' }, body: '{}' })
        .then(async (res) => console.log(res.status, await res.text()), (err) => console.log('failed', err.cause?.code ?? err.message));
    `);

    expect(asked.stdout.trim()).toBe('200 {"answered":true}');
    expect(heard).toHaveLength(1);
    expect(heard[0].headers['x-api-key']).toBe(key);
    const everywhere = await run(`cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c held-at-the-gateway; grep -rl held-at-the-gateway /task /tmp 2>/dev/null | wc -l`);
    expect(everywhere.stdout.trim().split('\n').map(Number)).toEqual([0, 0]);
    upstream.close();
    reserved.release('done');
    await lease.backend.letGo('gated', { keep: false, reason: 'done' });
  }, 90_000);

  /** All a script printed, from its log. */
  const printed = (s: ReturnType<typeof session>['parent'], taskId: string) => s.taskLog(taskId, 1).flatMap((event) => (event.type === 'script_output' ? [event.text] : [])).join('');

  const nothingLeft = async () => {
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 30_000 });
    await vi.waitFor(() => expect(ours('network').filter((n) => !before.network.includes(n))).toEqual([]), { timeout: 30_000 });
  };

  it('runs a script over what a container landed in a container too: none of that code runs on this host', async () => {
    const root = repo();
    const owned = join(tempDir(), 'owned-by-the-script');
    const test = `uname -s\nid -u\npwd\ntouch ${owned} 2>/dev/null\necho written > from-the-script.txt\n`;
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'Write the test', prompt: cue({ write: { 'test.sh': test }, summary: 'Wrote it.' }), assignedRunner: 'claude-code' }),
      createTask({ id: 's', order: 2, title: 'Run the test', type: 'script', commands: [['sh', 'test.sh']], dependencies: ['a'], assignedRunner: 'claude-code' }),
    ];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'), { timeout: 60_000, interval: 100 });
    // Its merge gate, as ever: a script runs over the checkout, so what it runs over must get there first.
    expect(await env.parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.parent.planTasks[1].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });

    expect(env.parent.planTasks[1]).toMatchObject({ status: 'completed', verdict: { outcome: 'pass' } });
    expect(printed(env.parent, 's').trim().split('\n')).toEqual(['Linux', '1000', '/task/work']);
    expect(existsSync(owned)).toBe(false);
    expect(existsSync(join(root, 'from-the-script.txt'))).toBe(false);
    expect(env.told.join()).toContain('committed');
    await nothingLeft();
    env.parent.destroy();
  }, 120_000);

  it('takes the exit status of a script in a container as its evidence', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'f', order: 1, title: 'Fail', type: 'script', script: 'echo broke >&2; exit 3', assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0]).toMatchObject({ status: 'failed', verdict: { outcome: 'fail' } });
    expect(printed(env.parent, 'f')).toContain('broke');
    await nothingLeft();
    env.parent.destroy();
  }, 120_000);

  it('ends a script in a container at Stop, and everything it started', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'l', order: 1, title: 'Run long', type: 'script', script: 'sleep 300 & echo up; wait', assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(printed(env.parent, 'l')).toContain('up'), { timeout: 60_000, interval: 100 });

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });

    await nothingLeft();
    env.parent.destroy();
  }, 120_000);

  it('holds a read-only script, as a child\'s sealed one is, to no network and no landing', async () => {
    const root = repo();
    const volumes = ours('volume');
    const body = `${TRY_CONNECT(['1.1.1.1:443'])}; require('fs').writeFileSync('left-behind.txt', 'x')`;
    const tasks = [createTask({ id: 'r', order: 1, title: 'Read only', type: 'script', readOnly: true, commands: [['node', '-e', body]], assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0]).toMatchObject({ status: 'completed', verdict: { outcome: 'pass' } });
    expect(printed(env.parent, 'r')).toContain('1.1.1.1:443 ENETUNREACH');
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual(['README.md']);
    await nothingLeft();
    await vi.waitFor(() => expect(ours('volume').filter((n) => n.startsWith('ordewell-task-') && !volumes.includes(n))).toEqual([]), { timeout: 30_000 });
    env.parent.destroy();
  }, 120_000);

  describe('a delegated child plan under containers (ADR-0055)', () => {
    const delegated = (over: Partial<Task> = {}) => createTask({ id: 'd', order: 2, title: 'Delegated subtree', type: 'delegated', goal: 'Write a and b', budget: { tokens: 5_000_000 }, protectedPaths: ['tests/'], assignedRunner: 'claude-code', ...over });
    const check = (body: string, over: Partial<Task> = {}) => createTask({ id: 'c', order: 3, title: 'Check the subtree', type: 'script', readOnly: true, commands: [['sh', '-c', body]], dependencies: ['d'], assignedRunner: 'claude-code', ...over });
    const childTask = (id: string, order: number, spec: unknown, dependencies: string[] = []) => ({ id, order, title: `Write ${id}`, description: id, type: 'ai', sliceType: 'AFK', autonomy: 'AFK', dependencies, assignedRunner: 'claude-code', prompt: cue(spec) });
    const landed = (root: string, env: ReturnType<typeof session>) => git(root, 'ls-tree', '-r', '--name-only', env.integration()).split('\n');

    it('runs its tasks in containers, its subplanner here, and its check in a container over what landed', async () => {
      const root = repo();
      const main = git(root, 'rev-parse', 'main');
      const tasks = [delegated({ order: 1 }), check('test -f a.txt && test -f b.txt && uname -s')];
      const env = session(root, tasks, settingsOf(), { subplanner: [
        SUBMIT([childTask('a', 1, { write: { 'a.txt': 'written by a\n' }, summary: 'Wrote a.' }), childTask('b', 2, { write: { 'b.txt': 'written by b\n' }, summary: 'Wrote b.' }, ['a'])]),
        DONE,
      ] });

      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(env.parent.planTasks.map((task) => [task.id, task.status])).toEqual([['d', 'completed'], ['c', 'completed']]), { timeout: 90_000, interval: 200 });

      expect(env.parent.planTasks[0].verdict).toMatchObject({ outcome: 'pass', reported: 'done' });
      expect(landed(root, env)).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'where-i-ran.txt']));
      expect(git(root, 'show', `${env.integration()}:where-i-ran.txt`)).toBe('Linux 1000 /task/home');
      expect(printed(env.parent, 'c').trim()).toBe('Linux');
      expect(git(root, 'rev-parse', 'main')).toBe(main);
      await nothingLeft();
      env.parent.destroy();
    }, 180_000);

    it('repairs its conflict in a container: this host has no `claude` for it to run', async () => {
      const root = repo();
      const tasks = [
        createTask({ id: 's', order: 1, title: 'Sibling', prompt: cue({ write: { 'shared.txt': 'from the sibling\n' }, summary: 'Wrote it.' }), assignedRunner: 'claude-code' }),
        delegated(),
        check('grep -q delegated shared.txt'),
      ];
      const env = session(root, tasks, settingsOf(), { repairs: 1, subplanner: [
        SUBMIT([childTask('a', 1, { delayMs: 2500, write: { 'shared.txt': 'from the delegated task\n' }, summary: 'Wrote it.' })]),
        DONE,
      ] });

      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(env.parent.planTasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']), { timeout: 120_000, interval: 200 });

      expect(git(root, 'show', `${env.integration()}:shared.txt`)).toBe('from the delegated task');
      expect(git(root, 'log', '--format=%s', env.integration()).split('\n').join()).toContain('Write a and b');
      expect(landed(root, env)).toContain('fake-claude-output.txt');
      await nothingLeft();
      env.parent.destroy();
    }, 180_000);
  });

  describe('what a session leaves in the engine (ADR-0059 L6)', () => {
    const LOGIN = { image: IMAGE, memory: '512m', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } };
    const leftBy = (volumes: readonly string[]) => ours('volume').filter((name) => !volumes.includes(name));
    const pinsIn = (mirror: string) => docker('run', '--rm', '--init', '--pids-limit', '8192', '--memory', '256m', '--network', 'none', '-v', `${mirror}:/mirror:ro`, IMAGE, 'sh', '-c', 'for m in /mirror/*.git; do git -C "$m" for-each-ref refs/ordewell/pins; done').split('\n').filter(Boolean);
    const failing = (id: string) => [createTask({ id, order: 1, title: 'Leave work', prompt: cue({ write: { 'partial.txt': 'half done\n' }, status: 'blocked', reason: 'stuck' }), assignedRunner: 'claude-code' })];

    it('goes with a Clean up: its volumes, and a mirror nothing else leans on', async () => {
      const volumes = ours('volume');
      const root = repo();
      const env = session(root, failing('q'));
      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(env.parent);
      await vi.waitFor(() => expect(leftBy(volumes).filter((name) => name.startsWith('ordewell-task-'))).toHaveLength(1), { timeout: 30_000 });
      expect(leftBy(volumes).some((name) => name.startsWith('ordewell-mirror-'))).toBe(true);

      await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });
      await env.parent.cleanupRun();

      expect(leftBy(volumes)).toEqual([]);
      env.parent.destroy();
    }, 120_000);

    it('goes with a session delete, with no Session to ask, whatever a dead host left', async () => {
      const volumes = ours('volume');
      const root = repo();
      const env = session(root, failing('z'));
      await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(env.parent);
      await vi.waitFor(() => expect(leftBy(volumes).filter((name) => name.startsWith('ordewell-task-'))).toHaveLength(1), { timeout: 30_000 });
      env.parent.destroy();
      // What a host that died leaves: its network, which nothing took down.
      const tree = `docker-e2e-${process.pid}-z`;
      const stranded = `ordewell-stranded-${process.pid}-net`;
      docker('network', 'create', '--internal', '--label', `ordewell.tree=${tree}`, stranded);

      await reclaimContainers(tree, LOGIN);

      expect(leftBy(volumes)).toEqual([]);
      expect(ours('network')).not.toContain(stranded);
    }, 120_000);

    it('leaves a mirror a session of the same project still pins, and takes it with the last', async () => {
      const volumes = ours('volume');
      const root = repo();
      const first = session(root, failing('p1'));
      await first.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(first.parent);
      const second = session(root, failing('p2'));
      await second.parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled(second.parent);
      const [mirror] = leftBy(volumes).filter((name) => name.startsWith('ordewell-mirror-'));
      expect(pinsIn(mirror).length).toBeGreaterThan(2);
      first.parent.destroy();
      second.parent.destroy();

      await reclaimContainers(`docker-e2e-${process.pid}-p1`, LOGIN);

      expect(ours('volume')).toContain(mirror);
      expect(pinsIn(mirror)).toHaveLength(2);

      await reclaimContainers(`docker-e2e-${process.pid}-p2`, LOGIN);

      expect(leftBy(volumes)).toEqual([]);
    }, 120_000);
  });

  it('reads a board pin\'s file in the container, as git would name it (ADR-0057 R9)', async () => {
    const lease = leaseOver('pinned', [worktreeOf(repo(), 'ordewell/pinned')]);
    const { opened, run, lease: reserved } = await lease.open();
    await run('printf "in the box\\n" > made-here.txt; mkfifo a-pipe; mkdir a-folder');
    const blob = opened.placement!.blob;

    expect(await blob('made-here.txt')).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: 'in the box\n', encoding: 'utf8' }).trim());
    expect(await blob('README.md')).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: 'hello\n', encoding: 'utf8' }).trim());
    expect(await blob('no-such-file')).toBeUndefined();
    expect(await blob('a-pipe')).toBeUndefined();
    expect(await blob('a-folder')).toBeUndefined();
    reserved.release('done');
    await lease.backend.letGo('pinned', { keep: false, reason: 'done' });
  }, 90_000);

  it('reports a process killed at the memory limit as `oom`', async () => {
    const lease = leaseOver('oom', [worktreeOf(repo(), 'ordewell/oom')], '128m');
    const { opened, run, lease: reserved } = await lease.open();

    const killed = await run('exec node -e "const a=[];for(;;)a.push(Buffer.alloc(1<<24,1))"');

    expect(killed.status).toBe(137);
    await expect(opened.ended!()).resolves.toBe('oom');
    expect(lease.told.join()).toContain('memory limit');
    reserved.release('oom');
    await lease.backend.letGo('oom', { keep: false, reason: 'done' });
  }, 90_000);

  it('holds a process to the limit it proved: a fork bomb stays in its cgroup', async () => {
    const lease = leaseOver('pids', [worktreeOf(repo(), 'ordewell/pids')]);
    const { run, lease: reserved } = await lease.open();

    const counted = await run('cat /sys/fs/cgroup/pids.max; cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/memory.swap.max; id -u');

    expect(counted.stdout.trim().split('\n')).toEqual(['8192', String(512 * 1024 ** 2), '0', '1000']);
    reserved.release('done');
    await lease.backend.letGo('pids', { keep: false, reason: 'done' });
  }, 60_000);

  it('seeds a repair with the integration tip, and brings back the merge it makes (ADR-0015)', async () => {
    const root = repo();
    const repaired = worktreeOf(root, 'ordewell/repair');
    writeFileSync(join(repaired.worktree, 'task.txt'), 'the task\n');
    git(repaired.worktree, 'add', '-A');
    git(repaired.worktree, 'commit', '-q', '-m', 'The task');
    const landed = join(tempDir(), 'wt');
    git(root, 'worktree', 'add', '-q', landed, repaired.integrationBranch);
    writeFileSync(join(landed, 'landed.txt'), 'landed meanwhile\n');
    git(landed, 'add', '-A');
    git(landed, 'commit', '-q', '-m', 'Landed meanwhile');
    const tip = git(root, 'rev-parse', repaired.integrationBranch);
    const lease = leaseOver('repair', [repaired]);
    const { run, lease: reserved } = await lease.open('repair');

    const merged = await run(`git merge -q --no-edit ${repaired.integrationBranch}`);
    expect(merged.stderr).toBe('');
    expect(merged.status).toBe(0);
    await lease.backend.collect('repair');

    expect(git(repaired.worktree, 'merge-base', '--is-ancestor', tip, 'HEAD')).toBe('');
    expect(existsSync(join(repaired.worktree, 'landed.txt'))).toBe(true);
    expect(git(repaired.worktree, 'status', '--porcelain')).toBe('');
    reserved.release('verdict');
    await lease.backend.letGo('repair', { keep: false, reason: 'done' });
  }, 90_000);

  it('brings back every repository of a group, or none of them', async () => {
    const roots = [repo(), repo()];
    const repos = roots.map((root, i) => ({ ...worktreeOf(root, `ordewell/group-${i}`), path: `repo-${i}` }));
    const lease = leaseOver('group', repos);
    const { run, lease: reserved } = await lease.open();

    expect((await run('ls /task/work && echo one > /task/work/repo-0/one.txt && echo two > /task/work/repo-1/two.txt')).stdout.trim().split('\n')).toEqual(['repo-0', 'repo-1']);
    await lease.backend.collect('group');

    expect(readFileSync(join(repos[0].worktree, 'one.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(repos[1].worktree, 'two.txt'), 'utf8')).toBe('two\n');
    reserved.release('verdict');
    await lease.backend.letGo('group', { keep: false, reason: 'done' });
  }, 90_000);

  /*
   * The real binary, in an image built from docker/task.Dockerfile: set
   * ORDEWELL_E2E_HARNESS_IMAGE to one. It is given an empty sign-in, so no key
   * goes anywhere and no model answers: what this proves is its launch, its
   * protocol through `docker exec` and its attach to Ordewell's server through
   * the relay. What it says of memory is a harness at rest, not one at work.
   */
  const HARNESS_IMAGE = process.env.ORDEWELL_E2E_HARNESS_IMAGE;
  it.skipIf(!HARNESS_IMAGE)('attaches the real harness to its tools through the relay, and measures it', async () => {
    const login = 'ordewell-login-claude-code';
    const hadLogin = spawnSync('docker', ['volume', 'inspect', login]).status === 0;
    if (!hadLogin) docker('volume', 'create', login);
    const root = repo();
    const tasks = [createTask({ id: 'h', order: 1, title: 'Real harness', prompt: 'Say hello.', assignedRunner: 'claude-code' })];
    const env = session(root, tasks, settingsOf({ image: HARNESS_IMAGE, memory: '2g', login: { kind: 'own-sign-in' } }));

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(attempts()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    const [box] = attempts();
    const memory = (file: string) => Number(spawnSync('docker', ['exec', box, 'cat', `/sys/fs/cgroup/${file}`], { encoding: 'utf8' }).stdout.trim());

    // Attached: only then is it sent a turn, and without a login that turn ends it waiting on the user.
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('awaiting_user'), { timeout: 120_000, interval: 200 });
    expect(vi.mocked(env.notifications.warn).mock.calls.join()).not.toContain("started without Ordewell's tools");
    expect(env.parent.planTasks[0].awaitingReason).toBe('input');
    console.log(`[measure] the harness said: ${JSON.stringify(env.taskOutput.finalText('h')).slice(0, 200)}`);
    const rss = spawnSync('docker', ['exec', box, 'sh', '-c', 'for p in /proc/[0-9]*; do if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q claude; then grep VmRSS $p/status; fi; done'], { encoding: 'utf8' }).stdout.trim();
    console.log(`[measure] harness at rest: cgroup current ${Math.round(memory('memory.current') / 1024 ** 2)} MiB, peak ${Math.round(memory('memory.peak') / 1024 ** 2)} MiB, ${rss.replace(/\s+/g, ' ')}`);

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 45_000, interval: 200 });
    env.parent.destroy();
    if (!hadLogin) docker('volume', 'rm', '-f', login);

    const lease = leaseOverImage('timing', [worktreeOf(repo(), 'ordewell/timing')], HARNESS_IMAGE!);
    const opens: number[] = [];
    for (let i = 0; i < 10; i++) {
      const startedAt = Date.now();
      const { lease: reserved } = await lease.open();
      opens.push(Date.now() - startedAt);
      reserved.release('done');
      await lease.backend.letGo('timing', { keep: true, reason: 'done' });
    }
    await lease.backend.letGo('timing', { keep: false, reason: 'done' });
    console.log(`[measure] a lease's whole open, ms: ${[...opens].sort((a, b) => a - b).join(' ')}`);
  }, 240_000);

  /*
   * The real binary through a whole model turn, with nothing faked but the model:
   * a Messages API on this host's loopback that asks for a file to be written, then
   * for `task_complete`. So the gateway and the proxy variables meet the client they
   * are for. What it says of memory is one small turn, not a harness at real work.
   */
  function fakeModel() {
    const heard: { path: string; key: unknown; authorization: unknown; tools: string[] }[] = [];
    const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolUse = (id: string, name: string, input: unknown) => [
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }),
    ].join('');
    const text = (words: string) => [
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    ].join('');
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const asked = (body ? JSON.parse(body) : {}) as { tools?: { name: string }[]; messages?: { content: unknown }[]; model?: string };
        const tools = (asked.tools ?? []).map(({ name }) => name);
        heard.push({ path: req.url ?? '', key: req.headers['x-api-key'], authorization: req.headers.authorization, tools });
        if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url?.includes('count_tokens') ? { input_tokens: 10 } : { data: [] }));
          return;
        }
        const said = JSON.stringify(asked.messages ?? []);
        const complete = tools.find((name) => name.endsWith('task_complete'));
        const reply = !complete ? text('ok')
          : !said.includes('from-the-model.txt') ? toolUse('toolu_write', 'Write', { file_path: '/task/work/from-the-model.txt', content: 'written by a model turn\n' })
            : !said.includes('toolu_done') ? toolUse('toolu_done', complete, { status: 'done', summary: 'Wrote it through the gateway.', commit: { subject: 'Write a file' } })
              : text('Done.');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Long enough for what watches its memory to read it while it works.
        setTimeout(() => res.end(event('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: asked.model ?? 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) + reply + event('message_stop', { type: 'message_stop' })), 1000);
      });
    });
    return { heard, server, listening: new Promise<string>((done) => { server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)); }) };
  }

  it.skipIf(!HARNESS_IMAGE)('takes the real harness through a model turn by the gateway, with the key on this host', async () => {
    const model = fakeModel();
    const url = await model.listening;
    const key = 'sk-ant-api03-a-real-turn-through-the-gateway';
    const root = repo();
    const tasks = [createTask({ id: 'turn', order: 1, title: 'A real turn', prompt: 'Write the file.', assignedRunner: 'claude-code' })];
    const env = session(root, tasks, settingsOf({ image: HARNESS_IMAGE, memory: '2g', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] }, required: ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata', 'cred.unreadable'] }), { key: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: url } });

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(attempts()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    const [box] = attempts();
    let peak = 0;
    const watching = setInterval(() => {
      execFile('docker', ['exec', box, 'cat', '/sys/fs/cgroup/memory.peak'], { encoding: 'utf8' }, (err, stdout) => { if (!err) peak = Math.max(peak, Number(stdout.trim())); });
    }, 300);
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).not.toMatch(/approved|pending|in_progress/), { timeout: 150_000, interval: 200 }).finally(() => clearInterval(watching));

    console.log(`[measure] one model turn through the gateway: cgroup peak ${Math.round(peak / 1024 ** 2)} MiB, ${model.heard.length} requests: ${[...new Set(model.heard.map(({ path }) => path))].join(' ')}`);
    expect(env.parent.planTasks[0], JSON.stringify(env.parent.planTasks[0].outputSummary)).toMatchObject({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } });
    expect(git(root, 'show', `${env.integration()}:from-the-model.txt`)).toBe('written by a model turn');
    expect(model.heard.length).toBeGreaterThan(0);
    for (const { key: sent, authorization } of model.heard) {
      expect(sent).toBe(key);
      expect(authorization).toBeUndefined();
    }
    model.server.close();
    env.parent.destroy();
  }, 240_000);

  it('cannot reach the mirror for writing, or the host: the guarantees hold against a real process', async () => {
    const root = repo();
    const lease = leaseOver('reach', [worktreeOf(root, 'ordewell/reach')]);
    const { run, lease: reserved } = await lease.open();

    const tried = await run(`touch /mirror/self.git/hooks/post-receive; echo "mirror $?"; touch /usr/bin/x; echo "root $?"; ls ${root} 2>&1; echo "host $?"; ls /var/run/docker.sock 2>&1; echo "socket $?"; mkdir -p "$npm_config_cache" && touch "$npm_config_cache/x"; echo "cache $?"; ls -d /caches /login 2>&1; echo "shared $?"; touch "$HOME/x"; echo "home $?"`);

    const lines = tried.stdout.trim().split('\n');
    for (const [where, code] of [['mirror', '1'], ['root', '1'], ['host', '2'], ['socket', '2'], ['cache', '0'], ['shared', '2'], ['home', '0']]) expect(lines).toContain(`${where} ${code}`);
    reserved.release('done');
    await lease.backend.letGo('reach', { keep: false, reason: 'done' });
  }, 60_000);
});
