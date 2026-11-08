import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { type AddressInfo } from 'net';
import { createServer as createHttpServer } from 'http';
import { release, tmpdir, type as osType } from 'os';
import { join } from 'path';
import { CredentialBroker } from '../credentialBroker';
import { DockerExecutionBackend, whereItRuns } from '../dockerLease';
import { LOGIN_VOLUME } from '../containerPreflight';
import { CODEX_LOGIN_VOLUME } from '../containerRunners';
import { parseContainerSettings } from '../containerSettings';
import { EGRESS_ENTRY, type EgressRoute } from '../egressSidecar';
import { RELAY_ENTRY } from '../leaseRelay';
import { COPY_SIGN_IN } from '../taskWorkspace';
import type { DockerCall, DockerCli, DockerResult } from '../dockerCli';
import type { ProbeAsked, ProbeFindings } from '../guaranteeProbe';
import { KeptWorkError, LeaseGuaranteeError, type LeaseRepo, type LeaseRequest, type LeaseSpec, type OpenLease } from '../../executionLease';
import type { GitInvoker } from '../../gitExec';
import { createTask } from '../../../models/Task';
import { FakeExecutionBackend } from '../../../testing';

/*
 * The backend against a CLI that only records what it is told and answers as an
 * engine would; its entry is the real relay on this host's node. What a real
 * engine does with these commands is the Docker suite's (dockerLease.e2e).
 */

const OK: DockerResult = { code: 0, stdout: '', stderr: '' };

/** What a probe finds in a container this lease built, whatever it was told to try: all it can prove, proven. */
const cleanProbe = (asked: ProbeAsked): ProbeFindings => ({
  hostPathsFound: [],
  mounts: [{ point: '/', type: 'overlay' }, { point: '/task', type: 'ext4' }, { point: '/mirror', type: 'ext4' }, { point: '/tmp', type: 'tmpfs' }],
  dockerSocket: false,
  writesPassed: [],
  workspaceWritable: true,
  kernel: 'Linux 6.8.0',
  memoryMax: '4294967296',
  swapMax: '0',
  pidsMax: '8192',
  metadata: 'ENETUNREACH',
  gateway: 'no route',
  outside: Object.fromEntries(asked.network.outside.map((target) => [target, 'ENETUNREACH'])),
  named: 'EAI_AGAIN',
  proxied: Object.fromEntries((asked.network.proxy?.refused ?? []).map((target) => [target, '403'])),
  credentialsVisible: [],
  secretsFound: 0,
  loginReadable: false,
});

/** What this backend needs of a sidecar: that it says it listens, and goes with its pipe. What it does is its own suite's. */
const SIDECAR_READY = "console.log('ready 3128'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

/** A container has a loopback of its own, so what its relay listens on is free whatever this host holds. */
const OWN_LOOPBACK = "const { Server } = require('net'); Server.prototype.listen = ((listen) => function (_port, ...rest) { return listen.call(this, 0, ...rest); })(Server.prototype.listen);";

/**
 * A command as the engine reads it: `-e NAME` takes NAME's value from the CLI's
 * environment, so a test reading a value finds it where a container would. What
 * `ps` shows is `args`; this is what the container got.
 */
const asRead = (args: readonly string[], env: Readonly<Record<string, string>> = {}): string[] =>
  args.map((arg, at) => (args[at - 1] === '-e' && Object.hasOwn(env, arg) ? `${arg}=${env[arg]}` : arg));

interface Spawned { args: readonly string[]; env: Readonly<Record<string, string>>; seen: string[]; process: ChildProcess }

class RecordingCli implements DockerCli {
  calls: { args: readonly string[]; opts?: DockerCall }[] = [];
  entries: Spawned[] = [];
  sidecars: Spawned[] = [];
  probe: Partial<ProbeFindings> = {};
  /** Every probe it was told to run, as it was told. */
  asked: ProbeAsked[] = [];
  answers: { match: RegExp; result: Partial<DockerResult> }[] = [];

  /** Hears each call as it is made, for what must come before what. */
  heard: (line: string) => void = () => undefined;

  async call(args: readonly string[], opts?: DockerCall): Promise<DockerResult> {
    this.calls.push({ args, ...(opts ? { opts } : {}) });
    const seen = asRead(args, opts?.env);
    const line = seen.join(' ');
    this.heard(line);
    const set = this.answers.find(({ match }) => match.test(line));
    if (set) return { ...OK, ...set.result };
    if (line.startsWith('context inspect')) return { ...OK, stdout: 'unix:///var/run/docker.sock\n' };
    if (line.startsWith('info')) return { ...OK, stdout: `linux|2|${16 * 1024 ** 3}\n` };
    if (args.includes('rm') && args[0] === 'rm') for (const entry of this.entries) entry.process.kill('SIGKILL');
    const told = seen.find((arg) => arg.startsWith('ORDEWELL_PROBE='));
    if (told) {
      const asked = JSON.parse(told.slice('ORDEWELL_PROBE='.length)) as ProbeAsked;
      this.asked.push(asked);
      return { ...OK, stdout: JSON.stringify({ ...cleanProbe(asked), ...this.probe }) };
    }
    return OK;
  }

  async entry(args: readonly string[], opts?: DockerCall): Promise<ChildProcess> {
    const sidecar = args.includes(EGRESS_ENTRY);
    const child = sidecar
      ? spawn(process.execPath, ['-e', SIDECAR_READY], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.execPath, ['-e', OWN_LOOPBACK + RELAY_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    const env = opts?.env ?? {};
    (sidecar ? this.sidecars : this.entries).push({ args, env, seen: asRead(args, env), process: child });
    return child;
  }

  /** Each call as the engine reads it. */
  lines(): string[] { return this.calls.map(({ args, opts }) => asRead(args, opts?.env).join(' ')); }

  /** Every docker command it was handed, as `ps` would show it, with what its CLI's environment held. */
  argvs(): { args: readonly string[]; env: Readonly<Record<string, string>> }[] {
    return [...this.calls.map(({ args, opts }) => ({ args, env: opts?.env ?? {} })), ...this.entries, ...this.sidecars].map(({ args, env }) => ({ args, env }));
  }
}

const repo: LeaseRepo = { path: '.', root: '/repo', worktree: '/repo/.ordewell/wt/a', branch: 'ordewell/a', integrationBranch: 'ordewell/integration', linked: [] };

/** git for what the backend asks of this host: every ref is one commit, and no push fails. */
const git = (hooks = '/no/such/hooks'): GitInvoker => ({ exec: async (_file, args) => ({ stdout: args.includes('--git-path') ? `${hooks}\n` : 'abc123\n', stderr: '' }), resolvePath: async () => '/usr/bin' });

/** git for a gate that takes what `cli` last exported: the one ref a bundle may hold. */
const takingGit = (cli: RecordingCli): GitInvoker => ({
  exec: async (_file, args) => {
    const ref = cli.lines().flatMap((line) => /ORDEWELL_REF=(\S+)/.exec(line)?.[1] ?? []).at(-1);
    return { stdout: args.includes('list-heads') ? `abc123 ${ref}\n` : args.includes('--git-path') ? '/no/such/hooks\n' : 'abc123\n', stderr: '' };
  },
  resolvePath: async () => '/usr/bin',
});

/** The lease is tried where containers run: on Windows the engine check refuses it before any of what is tested here (containerPreflight). */
const WHERE_CONTAINERS_RUN = { platform: 'linux' } as const;

function backendWith(over: { settings?: unknown; cli?: RecordingCli; env?: Record<string, string>; hooks?: string; setupCommand?: string; git?: GitInvoker; platform?: NodeJS.Platform } = {}) {
  const local = new FakeExecutionBackend();
  local.repos = [repo];
  const cli = over.cli ?? new RecordingCli();
  const told: { level: string; text: string }[] = [];
  const backend = new DockerExecutionBackend(local, {
    platform: over.platform ?? WHERE_CONTAINERS_RUN.platform,
    settings: over.settings ?? { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } },
    cli,
    git: over.git ?? git(over.hooks),
    ...(over.setupCommand ? { setupCommand: () => over.setupCommand } : {}),
    broker: new CredentialBroker(over.env ?? { ANTHROPIC_API_KEY: 'sk-ant-api03-test' }),
    sessionId: () => 'session-1',
    tell: (level, text) => told.push({ level, text }),
  });
  return { backend, local, cli, told };
}

const taskRequest: LeaseRequest = { node: { sessionId: 'session-1', taskId: 'a' }, role: 'task', runner: 'claude-code' };
const changeSpec: LeaseSpec = { task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a' }), workspace: { kind: 'worktree', intent: 'fresh', decision: { epoch: 1, mode: 'isolated' } }, required: [] };
const readOnlySpec: LeaseSpec = { ...changeSpec, workspace: { kind: 'worktree', intent: 'readOnly', decision: { epoch: 1, mode: 'isolated' } } };
const checkoutSpec: LeaseSpec = { ...changeSpec, workspace: { kind: 'checkout' } };
const scriptRequest: LeaseRequest = { ...taskRequest, role: 'script' };

async function opened(backend: DockerExecutionBackend, request = taskRequest, spec = changeSpec, signal = new AbortController().signal): Promise<OpenLease & { lease: { release(reason: string): void } }> {
  const reserved = backend.reserve(request);
  if ('refused' in reserved) throw new Error(reserved.refused);
  return Object.assign(await reserved.lease.open(spec, signal), { lease: reserved.lease });
}

/** The task volume a start made, which fails a test if it made none. */
function madeTaskVolume(cli: RecordingCli): string {
  const made = cli.lines().find((line) => line.startsWith('volume create') && line.includes('ordewell-task-'));
  if (!made) throw new Error('no task volume was made');
  return made.split(' ').at(-1)!;
}

describe('what runs in a container (ADR-0059 L5)', () => {
  it('refuses a runner no container has been proven with, naming the ones that have', async () => {
    const { backend, cli } = backendWith();

    await expect(opened(backend, { ...taskRequest, runner: 'gemini' })).rejects.toThrow(/gemini has not been proven in one.*claude-code, codex, opencode/);
    expect(cli.entries).toEqual([]);
  });

  it('refuses the ACP runner, which can run tasks on the host but has not been proven in a container', async () => {
    const { backend, cli } = backendWith();

    await expect(opened(backend, { ...taskRequest, runner: 'copilot-cli' })).rejects.toThrow(
      'This session runs tasks in containers, and copilot-cli has not been proven in one: assign the task to claude-code, codex, opencode.',
    );
    expect(cli.entries).toEqual([]);
  });

  it('runs an OpenCode change task there', async () => {
    const { backend, cli } = backendWith();

    const lease = await opened(backend, { ...taskRequest, runner: 'opencode' });

    expect(cli.entries).toHaveLength(1);
    expect(lease.placement).toBeDefined();
    lease.lease.release('done');
  });

  it('gives an OpenCode own sign-in its own copy, and points the runner at it', async () => {
    const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' } } });

    const lease = await opened(backend, { ...taskRequest, runner: 'opencode' });

    const copy = cli.lines().find((line) => line.includes('ordewell-login-opencode') && line.startsWith('run'));
    expect(copy).toContain('ordewell-login-opencode:/login:ro');
    expect(copy).toContain('/task/login/opencode');
    expect(cli.entries[0].seen.join(' ')).toContain('XDG_DATA_HOME=/task/login');
    expect(cli.entries[0].seen.join(' ')).not.toContain('CLAUDE_CONFIG_DIR');
    lease.lease.release('done');
  });

  it("opens an OpenCode sign-in's providers and the model's own API, which nothing gates", async () => {
    const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' }, allow: [] } });
    const spec = { ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId: 'opencode/claude-sonnet-4', modelLabel: 'claude-sonnet-4', availableVariants: [] } }) };

    const lease = await opened(backend, { ...taskRequest, runner: 'opencode' }, spec);

    const egress = cli.sidecars[0].seen.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))!;
    const allow = JSON.parse(egress.slice('ORDEWELL_EGRESS='.length)).allow as string[];
    expect(allow).toEqual(expect.arrayContaining(['api.anthropic.com', 'opencode.ai']));
    lease.lease.release('done');
  });

  it("opens a handed key's provider hosts, and no model host behind the gateway", async () => {
    const handed = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['OPENROUTER_API_KEY'] }, allow: [] }, env: { OPENROUTER_API_KEY: 'sk-or-test' } });
    const gated = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, allow: [] } });
    const model = (id: string) => ({ ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId: id, modelLabel: id.split('/').at(-1)!, availableVariants: [] } }) });

    const open = await opened(handed.backend, { ...taskRequest, runner: 'opencode' }, model('openrouter/anthropic/claude-sonnet-4'));
    const closed = await opened(gated.backend, { ...taskRequest, runner: 'opencode' }, model('anthropic/claude-sonnet-4'));
    const allowOf = (cli: RecordingCli) => JSON.parse(cli.sidecars[0].seen.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))!.slice('ORDEWELL_EGRESS='.length)).allow as string[];

    expect(allowOf(handed.cli)).toContain('openrouter.ai');
    expect(allowOf(gated.cli)).not.toContain('api.anthropic.com');
    open.lease.release('done');
    closed.lease.release('done');
  });

  describe('a login that gates one key and names another', () => {
    const allowFor = async (variables: string[], modelId: string) => {
      const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables }, allow: [] }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test', OPENAI_API_KEY: 'sk-proj-test', OPENROUTER_API_KEY: 'sk-or-test' } });
      const spec = { ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId, modelLabel: modelId, availableVariants: [] } }) };
      const lease = await opened(backend, { ...taskRequest, runner: 'opencode' }, spec);
      lease.lease.release('done');
      return JSON.parse(cli.sidecars[0].seen.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))!.slice('ORDEWELL_EGRESS='.length)).allow as string[];
    };

    it('opens the handed key its provider, and leaves the gated key behind its gateway', async () => {
      const hosts = await allowFor(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'], 'openrouter/anthropic/claude-sonnet-4');

      expect(hosts).toContain('openrouter.ai');
      expect(hosts).not.toContain('api.anthropic.com');
    });

    it("does not open the gated key's own API for a model of that provider", async () => {
      expect(await allowFor(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'], 'anthropic/claude-sonnet-4')).not.toContain('api.anthropic.com');
    });

    it.each([
      ['beside the gated key', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']],
      ['beside a handed key too', ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']],
      ['or with no key of its own named', ['ANTHROPIC_API_KEY']],
      ['or with only a handed key', ['OPENROUTER_API_KEY']],
    ])('refuses an OpenAI model under OpenCode before a worktree, %s', async (_how, variables) => {
      const { backend, local, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables }, allow: [] }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test', OPENAI_API_KEY: 'sk-proj-test', OPENROUTER_API_KEY: 'sk-or-test' } });
      const spec = { ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId: 'openai/gpt-5', modelLabel: 'GPT-5', availableVariants: [] } }) };

      const start = opened(backend, { ...taskRequest, runner: 'opencode' }, spec);

      await expect(start).rejects.toThrow(/cannot start in one.*openai\/gpt-5.*OPENAI_API_KEY.*"own-sign-in"/);
      expect(local.opened).toEqual([]);
      expect(cli.sidecars).toEqual([]);
    });

    it('leaves an OpenAI model to a person signed in to OpenCode, and opens its API', async () => {
      const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' }, allow: [] } });
      const spec = { ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId: 'openai/gpt-5', modelLabel: 'GPT-5', availableVariants: [] } }) };

      const lease = await opened(backend, { ...taskRequest, runner: 'opencode' }, spec);

      expect(JSON.parse(cli.sidecars[0].seen.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))!.slice('ORDEWELL_EGRESS='.length)).allow).toContain('api.openai.com');
      lease.lease.release('done');
    });

    it('leaves OpenAI models to Codex, whose gateway carries that key', async () => {
      const { backend } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] }, allow: [] }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test', OPENAI_API_KEY: 'sk-proj-test' } });
      const spec = { ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId: 'openai/gpt-5', modelLabel: 'GPT-5', availableVariants: [] } }) };

      const lease = await opened(backend, { ...taskRequest, runner: 'codex' }, spec);

      lease.lease.release('done');
    });

    it("leaves a model's id to a runner that does not read a provider from it", async () => {
      const { backend } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] }, allow: [] }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test', ANTHROPIC_BASE_URL: 'https://proxy.example' } });
      const spec = { ...changeSpec, task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedModel: { modelId: 'openai/gpt-5', modelLabel: 'GPT-5', availableVariants: [] } }) };

      const lease = await opened(backend, taskRequest, spec);

      lease.lease.release('done');
    });

    it('opens no provider when nothing was handed for it to take', async () => {
      expect(await allowFor(['ANTHROPIC_API_KEY'], 'openrouter/anthropic/claude-sonnet-4')).not.toContain('openrouter.ai');
    });
  });

  it("reaches a server the runner starts inside, over the relay, and nowhere else", async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend, { ...taskRequest, runner: 'opencode' });
    const inside = createHttpServer((req, res) => res.end(`inside ${req.url}`));
    await new Promise<void>((done) => inside.listen(0, '127.0.0.1', done));
    const insidePort = (inside.address() as AddressInfo).port;

    const reached = await lease.placement!.reachIn!(`http://127.0.0.1:${insidePort}`);
    const reply = await (await fetch(`${reached}/api/info`)).text();

    expect(reached).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(reached).not.toContain(String(insidePort));
    expect(reply).toBe('inside /api/info');
    inside.close();
    lease.lease.release('done');
    expect(cli.entries).toHaveLength(1);
  });

  it('runs a change task there', () => {
    expect(whereItRuns(taskRequest, changeSpec)).toBe('container');
  });

  it.each<[LeaseRequest['role']]>([['planner'], ['merge'], ['child-plan']])('leaves a %s on the host', (role) => {
    expect(whereItRuns({ ...taskRequest, role }, changeSpec)).toBe('host');
  });

  it('runs a script there: what it runs over is what containers wrote', () => {
    expect(whereItRuns({ ...taskRequest, role: 'script' }, changeSpec)).toBe('container');
  });

  it('runs a read-only script there too: a check runs what landed', () => {
    expect(whereItRuns({ ...taskRequest, role: 'script' }, readOnlySpec)).toBe('container');
  });

  it('leaves a read-only task on the host, sealed as it always is', () => {
    expect(whereItRuns(taskRequest, readOnlySpec)).toBe('host');
  });

  it("runs a script of the user's checkout there too: its merge gate brought what it runs over to that checkout", () => {
    expect(whereItRuns({ ...taskRequest, role: 'script' }, checkoutSpec)).toBe('container');
  });

  it("refuses a task that works in the user's checkout: it cannot run there and must not run weaker", () => {
    expect(whereItRuns(taskRequest, { ...changeSpec, workspace: { kind: 'checkout' } })).toMatchObject({ refused: expect.stringContaining('checkout') });
  });
});

describe('a lease that cannot be what was asked refuses, and runs nothing weaker (L3)', () => {
  it('refuses settings it cannot use, before a worktree is made', async () => {
    const { backend, local } = backendWith({ settings: { login: { kind: 'broker', variables: ['X'] } } });

    await expect(opened(backend)).rejects.toThrow(/image/);
    expect(local.opened).toEqual([]);
  });

  it('refuses a setting that could never be used without asking the engine anything, and leaves nothing in it to clean up', async () => {
    const { backend, local, cli } = backendWith({ settings: 'docker' });

    await expect(opened(backend)).rejects.toThrow('This session runs tasks in containers, and this task cannot start in one. The containers setting cannot be used: the containers setting must be an object.');
    await backend.letGo('a', { keep: false, reason: 'failed' });

    expect(cli.calls).toEqual([]);
    expect(local.opened).toEqual([]);
    expect(local.letGoCalls).toEqual([{ taskId: 'a', keep: false, reason: 'failed' }]);
  });

  it('refuses on a host containers have not been proven on without asking the engine anything, a usable setting or not', async () => {
    const { backend, local, cli } = backendWith({ platform: 'win32' });

    await expect(opened(backend)).rejects.toThrow('This session runs tasks in containers, and this task cannot start in one. Containers have only been proven on Linux and macOS, and this host is win32.');
    await backend.letGo('a', { keep: false, reason: 'failed' });

    expect(cli.calls).toEqual([]);
    expect(local.opened).toEqual([]);
  });

  it('still asks the engine of a usable setting, and gives up what a start it refused left there', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /^version/, result: { code: 1, stderr: 'Cannot connect to the Docker daemon' } });
    const { backend } = backendWith({ cli });

    await expect(opened(backend)).rejects.toThrow(/Docker engine does not answer/);
    await backend.letGo('a', { keep: false, reason: 'failed' });

    expect(cli.lines().filter((line) => line.startsWith('volume'))).toEqual([
      expect.stringMatching(/^volume ls -q --filter name=ordewell-held-/),
      expect.stringMatching(/^volume rm -f ordewell-task-/),
      expect.stringMatching(/^volume rm -f ordewell-held-/),
    ]);
  });

  it('refuses when no login was chosen: a person chooses it', async () => {
    const { backend, local } = backendWith({ settings: { image: 'ordewell-task' } });

    await expect(opened(backend)).rejects.toThrow(/No login has been chosen/);
    expect(local.opened).toEqual([]);
  });

  it('refuses a runner no container has been proven with', async () => {
    const { backend, local } = backendWith();

    await expect(opened(backend, { ...taskRequest, runner: 'some-other-agent' })).rejects.toThrow(/some-other-agent has not been proven in one: assign the task to claude-code, codex/);
    expect(local.opened).toEqual([]);
  });

  it('refuses where the engine does not answer', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /^version/, result: { code: 1, stderr: 'Cannot connect to the Docker daemon' } });
    const { backend, local } = backendWith({ cli });

    await expect(opened(backend)).rejects.toThrow(/Docker/);
    expect(local.opened).toEqual([]);
  });

  it('refuses an image that was never built, and says where to read how: nothing is pulled', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /^image inspect/, result: { code: 1 } });
    const { backend } = backendWith({ cli });

    await expect(opened(backend)).rejects.toThrow(/docs\/containers\.md/);
    expect(cli.lines().some((line) => line.startsWith('pull'))).toBe(false);
  });

  it('refuses an API key that is not there', async () => {
    const { backend, cli } = backendWith({ env: {} });

    await expect(opened(backend)).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(cli.entries).toEqual([]);
  });

  it('refuses a subscription token handed over as a key', async () => {
    const { backend, cli } = backendWith({ env: { ANTHROPIC_API_KEY: 'sk-ant-oat01-not-a-key' } });

    await expect(opened(backend)).rejects.toThrow(/subscription/);
    expect(cli.entries).toEqual([]);
  });

  it('refuses an own sign-in nobody has made', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /^volume inspect ordewell-login/, result: { code: 1 } });
    const { backend } = backendWith({ cli, settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' } } });

    await expect(opened(backend)).rejects.toThrow(/sign in/i);
  });

  it.each<[string, Partial<ProbeFindings>, string]>([
    ['a canary of the host it can read', { hostPathsFound: ['/tmp/canary'] }, 'fs.hostHidden'],
    ['a write that reached the mirror', { writesPassed: ['/mirror'] }, 'fs.writeScope'],
    ['no memory limit', { memoryMax: 'max' }, 'limits.memory'],
  ])('tears the container down with %s', async (_case, probe, guarantee) => {
    const cli = new RecordingCli();
    cli.probe = probe;
    const { backend } = backendWith({ cli });

    const refused = await opened(backend).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(LeaseGuaranteeError);
    expect((refused as LeaseGuaranteeError).unproven).toEqual([guarantee]);
    expect(cli.lines().some((line) => /^rm -f ordewell-/.test(line))).toBe(true);
  });

  it.each<[string, Partial<ProbeFindings>]>([
    ['an address outside answers', { outside: { '1.1.1.1:443': 'connected' } }],
    ['it has a route out', { gateway: 'ECONNREFUSED' }],
    ['a name outside resolves', { named: 'resolved' }],
    ['its proxy let something through', { proxied: { '1.1.1.1:443': '200' } }],
  ])('refuses the lease, and tears its way out down, when %s', async (_case, probe) => {
    const cli = new RecordingCli();
    cli.probe = probe;
    const { backend } = backendWith({ cli });

    const refused = await opened(backend).catch((err: unknown) => err);

    expect((refused as LeaseGuaranteeError).unproven).toContain('net.allowlist');
    expect(cli.lines().some((line) => /^rm -f ordewell-.*-egress$/.test(line))).toBe(true);
    expect(cli.lines().some((line) => /^network rm ordewell-/.test(line))).toBe(true);
  });

  it('refuses the lease when the metadata service answers', async () => {
    const cli = new RecordingCli();
    cli.probe = { metadata: 'connected' };
    const { backend } = backendWith({ cli });

    const refused = await opened(backend).catch((err: unknown) => err);

    expect((refused as LeaseGuaranteeError).unproven).toEqual(['net.noMetadata']);
  });

  it('refuses a repository whose git hooks a landing would run on this host, over what the container wrote', async () => {
    const hooks = mkdtempSync(join(tmpdir(), 'ordewell-hooks-'));
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
    const { backend, cli } = backendWith({ hooks });

    await expect(opened(backend)).rejects.toThrow(/pre-commit/);
    expect(cli.entries).toEqual([]);
    rmSync(hooks, { recursive: true, force: true });
  });

  it('refuses a setup command, which would run what a container landed on this host, before a worktree is made', async () => {
    const { backend, local } = backendWith({ setupCommand: 'npm ci' });

    await expect(opened(backend)).rejects.toThrow(/worktreeSetupCommand|ORDEWELL_WORKTREE_SETUP/);
    expect(local.opened).toEqual([]);
  });

  it('refuses a probe that said nothing it can read', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /ORDEWELL_PROBE=/, result: { stdout: 'not json' } });
    const { backend } = backendWith({ cli });

    await expect(opened(backend)).rejects.toThrow(/probe/);
  });
});

describe('every container', () => {
  it('runs idle with the limits, drops what it can, and has no socket or host path', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const args = cli.entries[0].seen;
    for (const flag of ['--init', '--read-only', '--rm', '-i']) expect(args).toContain(flag);
    expect(args.join(' ')).toContain('--pids-limit 8192');
    expect(args.join(' ')).toContain('--memory 4g --memory-swap 4g');
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args.join(' ')).toContain('--user 1000:1000');
    expect(args.join(' ')).not.toMatch(/docker\.sock/);
    // Every volume is named: a host path never crosses into the VM.
    const mounts = args.flatMap((arg, i) => (args[i - 1] === '-v' ? [arg] : []));
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) expect(mount).toMatch(/^ordewell-/);
    lease.lease.release('done');
  });

  it("mounts the mirror read-only for an attempt", async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    expect(cli.entries[0].seen.find((arg) => arg.endsWith(':/mirror:ro'))).toBeDefined();
    lease.lease.release('done');
  });

  it('gives a helper the same limits, and no network', async () => {
    const { backend, cli, local } = backendWith();
    local.repos = [repo];
    await opened(backend);
    await backend.collect('a').catch(() => undefined);

    const helper = cli.calls.find(({ args }) => args[0] === 'run' && args.join(' ').includes('--network none') && args.includes('--pids-limit'));
    expect(helper?.args.join(' ')).toContain('--pids-limit 8192');
    expect(helper?.args).toContain('--init');
    expect(helper?.args.join(' ')).toContain('--memory 4g');
  });

  it('turns off the traffic a proxied lease must not make', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    expect(cli.entries[0].seen).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    lease.lease.release('done');
  });

  it('says plainly that its network is not limited, once, where a person stopped requiring it', async () => {
    const cli = new RecordingCli();
    cli.probe = { gateway: 'ECONNREFUSED' };
    const { backend, told } = backendWith({ cli, settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, required: [] } });
    const first = await opened(backend);
    first.lease.release('done');

    expect(told.filter(({ text }) => /network/.test(text))).toHaveLength(1);
    expect(told.find(({ text }) => /network/.test(text))?.level).toBe('warn');
  });

  it('says nothing of the network where the probe proved it limited', async () => {
    const { backend, told } = backendWith();
    const lease = await opened(backend);
    lease.lease.release('done');

    expect(told.filter(({ text }) => /network/.test(text))).toEqual([]);
  });
});

describe('the way out of a lease (ADR-0059 L7)', () => {
  const flagOf = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

  it('puts its container on an internal network, made before it, and on nothing else', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const network = flagOf(cli.entries[0].seen, '--network');
    const made = cli.lines().find((line) => line.startsWith('network create'))!;
    expect(made).toContain('--internal');
    expect(made.endsWith(network)).toBe(true);
    expect(cli.entries[0].seen.filter((arg) => arg === '--network')).toHaveLength(1);
    lease.lease.release('done');
  });

  it('runs one sidecar for it, on that network, and gives only the sidecar the bridge', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    expect(cli.sidecars).toHaveLength(1);
    const { args } = cli.sidecars[0];
    expect(flagOf(args, '--network')).toBe(flagOf(cli.entries[0].seen, '--network'));
    const sidecar = flagOf(args, '--name');
    expect(cli.lines()).toContain(`network connect bridge ${sidecar}`);
    lease.lease.release('done');
  });

  it('holds its sidecar to the limits of every container', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const { args } = cli.sidecars[0];
    for (const flag of ['--init', '--read-only', '--rm', '-i']) expect(args).toContain(flag);
    for (const flags of ['--pids-limit 8192', '--memory 4g --memory-swap 4g', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1000:1000']) expect(args.join(' ')).toContain(flags);
    lease.lease.release('done');
  });

  it("points every client at it, and leaves the container's own loopback alone: the relay is there", async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const sidecar = flagOf(cli.sidecars[0].seen, '--name');
    for (const variable of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) expect(cli.entries[0].seen).toContain(`${variable}=http://${sidecar}:3128`);
    expect(cli.entries[0].seen.find((arg) => arg.startsWith('NO_PROXY='))).toContain('127.0.0.1');
    expect(cli.entries[0].seen.find((arg) => arg.startsWith('no_proxy='))).toContain('127.0.0.1');
    lease.lease.release('done');
  });

  const listOf = (cli: RecordingCli) => (JSON.parse(cli.sidecars[0].seen.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))!.slice('ORDEWELL_EGRESS='.length)) as { allow: string[] }).allow;

  it('opens what the settings list, and no model host for a broker: its traffic takes the gateway', async () => {
    const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, allow: ['github.com'] } });
    const lease = await opened(backend);

    expect(listOf(cli)).toEqual(['github.com']);
    lease.lease.release('done');
  });

  it("adds where a person's own sign-in talks to Anthropic, which goes straight there through the tunnel", async () => {
    const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' }, allow: [] } });
    const lease = await opened(backend);

    expect(listOf(cli)).toEqual(['api.anthropic.com', 'claude.ai', 'platform.claude.com']);
    lease.lease.release('done');
  });

  it('asks the probe to try both ways out a bridge container was measured to reach, and what the proxy must turn down', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const { network } = cli.asked[0];
    expect(network.outside).toContain('1.1.1.1:443');
    expect(network.outside.some((target) => /^host\.docker\.internal:\d+$/.test(target))).toBe(true);
    expect(network.proxy?.refused).toEqual(expect.arrayContaining(['1.1.1.1:443', '169.254.169.254:80']));
    lease.lease.release('done');
  });

  it('takes its way out down with its container, after it', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);
    const box = flagOf(cli.entries[0].seen, '--name');
    const sidecar = flagOf(cli.sidecars[0].seen, '--name');
    const network = flagOf(cli.entries[0].seen, '--network');

    await lease.ended!();

    const lines = cli.lines();
    const order = [`rm -f ${box}`, `rm -f ${sidecar}`, `network rm ${network}`].map((line) => lines.indexOf(line));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("what docker's command line shows, which `ps` shows every user of this host (ADR-0022 A5)", () => {
  /** The one variable the CLI reads for itself and a container takes too, so it goes by value: always Ordewell's own path. */
  const HOME_BY_VALUE = 'HOME=/task/home';
  /** What docker's own `-e` takes: a `node -e` past the image is a script, not a variable. */
  const told = (args: readonly string[]) => {
    const ours = args.indexOf('node') === -1 ? args : args.slice(0, args.indexOf('node'));
    return ours.filter((_arg, at) => ours[at - 1] === '-e');
  };

  /** A lease that hands a container every kind of variable it has: a gateway's token, proxies, a probe, a runner's own, an export's; and the engine's own probe. */
  async function everyVariable() {
    const { backend, cli } = backendWith();
    await backend.probe();
    const lease = await opened(backend);
    const placed = await lease.placement!.place({ command: 'claude', args: ['-p'], env: { RUNNER_SECRET: 'runner-secret-value' }, files: [] });
    placed.ended();
    await backend.collect('a').catch(() => undefined);
    lease.lease.release('done');
    return { cli, placed, token: placed.env.ANTHROPIC_API_KEY };
  }

  it('names each variable on the command line and nothing more, its value left to the CLI to read', async () => {
    const { cli, placed } = await everyVariable();

    const argvs = [...cli.argvs(), placed];
    const variables = argvs.flatMap(({ args }) => told(args));
    expect(variables.length).toBeGreaterThan(10);
    expect(variables.filter((variable) => variable !== HOME_BY_VALUE && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))).toEqual([]);
    expect(argvs.flatMap(({ args }) => args).filter((arg) => arg === '--env' || arg.startsWith('--env='))).toEqual([]);
  });

  it('hands every variable it names a value, so the CLI never hands over one of this host', async () => {
    const { cli, placed } = await everyVariable();

    for (const { args, env } of [...cli.argvs(), placed]) {
      const named = told(args).filter((variable) => variable !== HOME_BY_VALUE);
      expect(Object.keys(env).filter((variable) => !named.includes(variable))).toEqual([]);
      expect(named.filter((variable) => !Object.hasOwn(env, variable))).toEqual([]);
    }
  });

  it('keeps every secret it holds off every command line, and puts each in the environment of the command that needs it', async () => {
    const { cli, placed, token } = await everyVariable();

    expect(token).toMatch(/^ordewell-lease-/);
    const shown = JSON.stringify([...cli.argvs(), placed].map(({ args }) => args));
    for (const secret of [token, 'runner-secret-value', 'ORDEWELL_PROBE=', 'ORDEWELL_EGRESS=', 'http://ordewell-', 'ORDEWELL_REF=']) expect(shown).not.toContain(secret);
    expect(placed.env).toMatchObject({ ANTHROPIC_API_KEY: token, RUNNER_SECRET: 'runner-secret-value' });
    expect(cli.entries[0].env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: expect.stringMatching(/^http:\/\/ordewell-.*-egress:3128$/) });
    expect(JSON.parse(cli.sidecars[0].env.ORDEWELL_EGRESS)).toMatchObject({ port: 3128 });
    const probes = cli.calls.flatMap(({ opts }) => (opts?.env?.ORDEWELL_PROBE ? [JSON.parse(opts.env.ORDEWELL_PROBE) as ProbeAsked] : []));
    expect(probes.map(({ workspace }) => workspace).sort()).toEqual(['/task', '/task/work']);
    expect(cli.calls.some(({ opts }) => opts?.env?.ORDEWELL_REF?.startsWith('refs/'))).toBe(true);
  });
});

describe('what a runner holds of a broker login (ADR-0059 L7)', () => {
  it('gives it a lease token and a base URL on its own loopback, and never the key', async () => {
    const { backend } = backendWith();
    const lease = await opened(backend);

    const placed = await lease.placement!.place({ command: 'claude', args: ['-p'], env: {}, files: [] });

    expect(placed.env.ANTHROPIC_API_KEY).toMatch(/^ordewell-lease-/);
    expect(placed.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(placed)).not.toContain('sk-ant-api03-test');
    placed.ended();
    lease.lease.release('done');
  });

  it('puts the key in no argument and no variable of its container', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    expect(JSON.stringify(cli.calls)).not.toContain('sk-ant-api03-test');
    expect(JSON.stringify(cli.entries.map(({ seen }) => seen))).not.toContain('sk-ant-api03-test');
    expect(JSON.stringify(cli.sidecars.map(({ seen }) => seen))).not.toContain('sk-ant-api03-test');
    lease.lease.release('done');
  });

  it('has the probe look for the key, by a digest that does not name it', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const [{ secrets, credentials }] = cli.asked;
    expect(credentials).toEqual([]);
    expect(secrets?.digests).toHaveLength(1);
    expect(JSON.stringify(secrets)).not.toContain('sk-ant-api03-test');
    lease.lease.release('done');
  });

  it('proves the key unreadable, from having looked', async () => {
    const { backend } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, required: ['cred.unreadable'] } });
    const lease = await opened(backend);

    expect(lease.guarantees['cred.unreadable']).toMatchObject({ proven: true, by: expect.stringContaining('gateway') });
    lease.lease.release('done');
  });

  it('refuses the lease where the probe finds the key after all', async () => {
    const cli = new RecordingCli();
    cli.probe = { secretsFound: 1 };
    const { backend } = backendWith({ cli, settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, required: ['cred.unreadable'] } });

    const refused = await opened(backend).catch((err: unknown) => err);

    expect((refused as LeaseGuaranteeError).unproven).toEqual(['cred.unreadable']);
  });

  it('still reports what goes by name as readable', async () => {
    const env = { AWS_SECRET_ACCESS_KEY: 'aws-secret' };
    const cli = new RecordingCli();
    cli.probe = { credentialsVisible: ['AWS_SECRET_ACCESS_KEY'] };
    const { backend } = backendWith({ cli, env, settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['AWS_SECRET_ACCESS_KEY'] } } });
    const lease = await opened(backend);

    expect(cli.asked[0].credentials).toEqual(['AWS_SECRET_ACCESS_KEY']);
    expect(lease.guarantees['cred.unreadable'].proven).toBe(false);
    const placed = await lease.placement!.place({ command: 'claude', args: [], env: {}, files: [] });
    expect(placed.env.AWS_SECRET_ACCESS_KEY).toBe('aws-secret');
    expect(placed.env.ANTHROPIC_BASE_URL).toBeUndefined();
    placed.ended();
    lease.lease.release('done');
  });
});

describe('a board pin read in a container', () => {
  it('asks by a path no dash can turn into an option', async () => {
    const { backend, cli } = backendWith();
    cli.answers.push({ match: /hash-object/, result: { stdout: 'a'.repeat(40) + '\n' } });
    const lease = await opened(backend);

    expect(await lease.placement!.blob('-delete')).toBe('a'.repeat(40));

    const asked = cli.calls.find(({ args }) => args.join(' ').includes('hash-object'))!.args;
    expect(asked.at(-1)).toBe('-delete');
    expect(asked.join(' ')).toContain('file="./$0"');
    lease.lease.release('done');
  });

  it('reads nothing into a pin it cannot trust the shape of', async () => {
    const { backend, cli } = backendWith();
    cli.answers.push({ match: /hash-object/, result: { stdout: 'not a sha\n' } });
    const lease = await opened(backend);

    expect(await lease.placement!.blob('a.txt')).toBeUndefined();
    lease.lease.release('done');
  });
});

describe('a script in a container', () => {
  it('runs by placement, as a runner does, on the way out a task has', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend, scriptRequest);

    expect(cli.sidecars).toHaveLength(1);
    expect(lease.placement).toBeDefined();
    lease.lease.release('done');
  });

  it('holds no login: a body the plan names has no use for a model', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend, scriptRequest);

    const placed = await lease.placement!.place({ command: 'npm', args: ['test'], env: {}, files: [] });

    expect(placed.env).toEqual({});
    expect(cli.asked[0]).toMatchObject({ credentials: [] });
    expect(cli.asked[0].secrets).toBeUndefined();
    placed.ended();
    lease.lease.release('done');
  });

  it('reads no key and mounts no sign-in', async () => {
    const { backend, cli } = backendWith({ env: {}, settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' } } });
    const lease = await opened(backend, scriptRequest);

    expect(cli.entries[0].seen.join(' ')).not.toContain('/login');
    expect(cli.entries[0].seen.join(' ')).not.toContain('CLAUDE_CONFIG_DIR');
    expect(cli.lines().some((line) => line.startsWith('volume inspect'))).toBe(false);
    lease.lease.release('done');
  });

  it('asks nothing of its runner: a script has none to prove', async () => {
    const { backend } = backendWith();
    const lease = await opened(backend, { ...scriptRequest, runner: 'codex' });

    expect(lease.placement).toBeDefined();
    lease.lease.release('done');
  });

  it('opens no host for a sign-in it does not hold', async () => {
    const { backend, cli } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' }, allow: [] } });
    const lease = await opened(backend, scriptRequest);

    expect(cli.sidecars[0].seen.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))).toContain('"allow":[]');
    lease.lease.release('done');
  });

  it('is brought back and lands as a task is', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend, scriptRequest);

    await backend.collect('a').catch(() => undefined);

    expect(cli.lines().some((line) => line.includes('ORDEWELL_REF='))).toBe(true);
    lease.lease.release('done');
  });

  describe("one of the user's checkout, as a script is by default (ADR-0035)", () => {
    it('runs on a copy of what the checkout has committed, by the way out a task has', async () => {
      const { backend, cli, local } = backendWith();
      local.repos = [];
      const lease = await opened(backend, scriptRequest, checkoutSpec);

      expect(cli.sidecars).toHaveLength(1);
      expect(cli.lines().some((line) => line.includes('ORDEWELL_BRANCH=ordewell/checkout'))).toBe(true);
      expect(lease.placement).toBeDefined();
      lease.lease.release('done');
    });

    it('brings nothing back: nothing a container wrote reaches a checkout but by a landing', async () => {
      const { backend, cli, local } = backendWith();
      local.repos = [];
      const lease = await opened(backend, scriptRequest, checkoutSpec);

      await backend.collect('a');

      expect(cli.lines().some((line) => line.includes('ORDEWELL_REF='))).toBe(false);
      lease.lease.release('done');
    });

    it('fires no hook, so it is not held to them', async () => {
      const hooks = mkdtempSync(join(tmpdir(), 'ordewell-hooks-'));
      writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
      const { backend, local } = backendWith({ hooks });
      local.repos = [];

      const lease = await opened(backend, scriptRequest, checkoutSpec);

      expect(lease.placement).toBeDefined();
      lease.lease.release('done');
      rmSync(hooks, { recursive: true, force: true });
    });

    it('says once that what it writes stays there, since it would pass with nothing changed', async () => {
      const { backend, local, told } = backendWith();
      local.repos = [];

      (await opened(backend, scriptRequest, checkoutSpec)).lease.release('done');
      (await opened(backend, scriptRequest, checkoutSpec)).lease.release('done');

      expect(told.filter(({ text }) => /committed/.test(text))).toHaveLength(1);
    });

    it("copies each repository of a group's root, which the run knows and git in that root does not", async () => {
      const { backend, local, cli } = backendWith();
      local.repos = [];
      local.checkoutRepos = () => [
        { path: 'api', root: '/group/api', worktree: '/group/api', branch: 'ordewell/checkout', integrationBranch: 'HEAD', linked: [] },
        { path: 'web', root: '/group/web', worktree: '/group/web', branch: 'ordewell/checkout', integrationBranch: 'HEAD', linked: [] },
      ];

      const lease = await opened(backend, scriptRequest, checkoutSpec);

      const seeded = cli.lines().filter((line) => line.includes('ORDEWELL_REPO_DIR='));
      expect(seeded.map((line) => /ORDEWELL_REPO_DIR=(\S+)/.exec(line)?.[1])).toEqual(['/task/work/api', '/task/work/web']);
      lease.lease.release('done');
    });

    it('refuses a workspace that holds no repository: there is nothing to copy', async () => {
      const { backend, local, cli } = backendWith();
      local.repos = [];
      const refusing: GitInvoker = { exec: async () => { throw Object.assign(new Error('not a git repository'), { stderr: 'fatal: not a git repository' }); }, resolvePath: async () => '/usr/bin' };
      const lone = new DockerExecutionBackend(local, { ...WHERE_CONTAINERS_RUN, settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } }, cli, git: refusing, broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'k' }), sessionId: () => 'session-1', tell: () => undefined });

      await expect(opened(lone, scriptRequest, checkoutSpec)).rejects.toThrow(/git repository/);
      expect(cli.entries).toEqual([]);
      void backend;
    });

    it('leaves no volume behind when it cannot get a network', async () => {
      const cli = new RecordingCli();
      cli.answers.push({ match: /^network create/, result: { code: 1, stderr: 'no address pool' } });
      const { backend } = backendWith({ cli });

      await expect(opened(backend, scriptRequest, checkoutSpec)).rejects.toThrow(/no address pool/);

      expect(cli.lines()).toContain(`volume rm -f ${madeTaskVolume(cli)}`);
    });

    it('still refuses a task of the checkout: a runner there has work to bring back', async () => {
      const { backend } = backendWith();

      await expect(opened(backend, taskRequest, checkoutSpec)).rejects.toThrow(/checkout/);
    });
  });

  describe('a read-only one, which is how a child runs a script sealed (ADR-0056 M9)', () => {
    it('has no network at all: a sealed script cannot reach out', async () => {
      const { backend, cli } = backendWith();
      const lease = await opened(backend, scriptRequest, readOnlySpec);

      expect(cli.entries[0].seen.join(' ')).toContain('--network none');
      expect(cli.sidecars).toEqual([]);
      expect(cli.lines().some((line) => line.startsWith('network create'))).toBe(false);
      expect(cli.entries[0].seen.some((arg) => /^HTTPS?_PROXY=/.test(arg))).toBe(false);
      lease.lease.release('done');
    });

    it('proves the allowlist from having nothing to reach', async () => {
      const { backend, cli } = backendWith();
      const lease = await opened(backend, scriptRequest, readOnlySpec);

      expect(cli.asked[0].network.proxy).toBeNull();
      expect(lease.guarantees['net.allowlist'].proven).toBe(true);
      lease.lease.release('done');
    });

    it('brings nothing back: it lands nothing, whatever it wrote', async () => {
      const { backend, cli } = backendWith();
      const lease = await opened(backend, scriptRequest, readOnlySpec);

      await backend.collect('a');
      await backend.letGo('a', { keep: true, reason: 'failed' });

      expect(cli.lines().some((line) => line.includes('ORDEWELL_REF='))).toBe(false);
      lease.lease.release('done');
    });

    it('leaves no volume behind when its lease is refused', async () => {
      const cli = new RecordingCli();
      cli.probe = { hostPathsFound: ['/tmp/canary'] };
      const { backend } = backendWith({ cli });

      await opened(backend, scriptRequest, readOnlySpec).catch(() => undefined);

      const made = cli.lines().find((line) => line.startsWith('volume create') && line.includes('ordewell-task-'))!.split(' ').at(-1);
      expect(cli.lines()).toContain(`volume rm -f ${made}`);
    });

    it('leaves no volume behind when git cannot name what it would run on', async () => {
      const failingGit: GitInvoker = {
        exec: async (_file, args) => {
          if (args.includes('HEAD')) throw Object.assign(new Error('bad HEAD'), { stderr: 'fatal: bad HEAD' });
          return { stdout: 'abc123\n', stderr: '' };
        },
        resolvePath: async () => '/usr/bin',
      };
      const cli = new RecordingCli();
      const { backend } = backendWith({ cli, git: failingGit });

      await expect(opened(backend, scriptRequest, readOnlySpec)).rejects.toThrow(/bad HEAD/);

      expect(cli.lines()).toContain(`volume rm -f ${madeTaskVolume(cli)}`);
    });

    it('keeps nothing: its volume goes with its attempt, and a retry gets its own', async () => {
      const { backend, cli } = backendWith();
      const first = await opened(backend, scriptRequest, readOnlySpec);
      const volume = cli.entries[0].seen.find((arg) => arg.endsWith(':/task'))!.split(':')[0];

      first.lease.release('verdict');
      await vi.waitFor(() => expect(cli.lines()).toContain(`volume rm -f ${volume}`));

      const second = await opened(backend, scriptRequest, readOnlySpec);
      expect(cli.entries[1].seen.find((arg) => arg.endsWith(':/task'))!.split(':')[0]).not.toBe(volume);
      second.lease.release('verdict');
    });
  });
});

describe('a runner placed in the container', () => {
  it('reaches it by exec, with what it holds by name and never in an argument', async () => {
    const { backend } = backendWith();
    const lease = await opened(backend);

    const placed = await lease.placement!.place({ command: 'claude', args: ['-p'], env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, files: [] });

    expect(placed.command).toBe('docker');
    expect(placed.args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(placed.args).toContain('ANTHROPIC_API_KEY');
    expect(placed.args.join(' ')).not.toContain(placed.env.ANTHROPIC_API_KEY);
    expect(placed.args.join(' ')).toContain('claude -p');
    placed.ended();
    lease.lease.release('done');
  });

  it('leaves this host\'s HOME and PATH here', async () => {
    const { backend } = backendWith();
    const lease = await opened(backend);

    const placed = await lease.placement!.place({ command: 'claude', args: [], env: { HOME: '/Users/me', PATH: '/opt/bin' }, files: [] });

    expect(placed.env.HOME).toBeUndefined();
    expect(placed.env.PATH).toBeUndefined();
    placed.ended();
    lease.lease.release('done');
  });

  it('kills it where it runs, not only the client on this host', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);
    const placed = await lease.placement!.place({ command: 'claude', args: [], env: {}, files: [] });

    placed.stop();

    await vi.waitFor(() => expect(cli.lines().some((line) => line.startsWith('exec') && line.includes('kill -KILL'))).toBe(true));
    placed.ended();
    lease.lease.release('done');
  });
});

describe('how a lease ended (L3)', () => {
  it('reports the memory limit by its typed reason, and tells the user', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /memory\.events/, result: { stdout: 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n' } });
    const { backend, told } = backendWith({ cli });
    const lease = await opened(backend);

    await expect(lease.ended!()).resolves.toBe('oom');
    expect(told.some(({ level, text }) => level === 'error' && /memory/.test(text))).toBe(true);
  });

  it('reports a container that went from under it as killed', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    cli.entries[0].process.kill('SIGKILL');
    await vi.waitFor(() => expect(cli.entries[0].process.exitCode !== null || cli.entries[0].process.signalCode !== null).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(lease.ended!()).resolves.toBe('killed');
  });

  it('reports nothing for one that ended as asked', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /memory\.events/, result: { stdout: 'oom 0\noom_kill 0\n' } });
    const { backend } = backendWith({ cli });
    const lease = await opened(backend);

    await expect(lease.ended!()).resolves.toBeNull();
  });
});

describe('the next attempt of a task', () => {
  it("waits for the last attempt's work before its worktree is prepared: a Continue restores what that worktree holds", async () => {
    const cli = new RecordingCli();
    const { backend, local } = backendWith({ cli, git: takingGit(cli) });
    const first = await opened(backend);
    first.lease.release('failed');
    let preparedBeforeExport: number | null = null;
    cli.heard = (line) => { if (line.includes('ORDEWELL_REF=')) preparedBeforeExport ??= local.opened.length; };

    await opened(backend, taskRequest, { ...changeSpec, workspace: { kind: 'worktree', intent: 'restore', decision: { epoch: 1, mode: 'isolated' } } });

    expect(preparedBeforeExport).toBe(1);
    expect(local.opened).toHaveLength(2);
  });

  it('keeps the volume while the task has no record: a restore takes the record away for a moment', async () => {
    const { backend, cli, local } = backendWith();
    const first = await opened(backend);
    local.records = [];

    first.lease.release('failed');
    await first.ended!();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cli.lines().some((line) => line.startsWith('volume rm'))).toBe(false);
  });

  it('removes the volume of a task whose work has landed, where no `letGo` comes', async () => {
    const { backend, cli, local } = backendWith();
    const first = await opened(backend);
    local.records = [{ taskId: 'a', status: 'merged', worktrees: [] }];

    first.lease.release('verdict');

    await vi.waitFor(() => expect(cli.lines().some((line) => /^volume rm -f ordewell-task-/.test(line))).toBe(true));
  });
});

describe('the seam around the host (L4)', () => {
  it('hands what stays on the host to the local lease, untouched', async () => {
    const { backend, local, cli } = backendWith();
    await opened(backend, { ...taskRequest, role: 'child-plan' });

    expect(local.opened).toHaveLength(1);
    expect(cli.entries).toEqual([]);
    expect(cli.calls).toEqual([]);
  });

  it('refuses a slot as the local lease refuses it', () => {
    const { backend, local } = backendWith();
    local.limit = 0;

    expect(backend.refusal(taskRequest)).toBe('no slot for a');
    expect(backend.reserve(taskRequest)).toEqual({ refused: 'no slot for a' });
  });

  it('frees the slot synchronously, as the lease it wraps does', async () => {
    const { backend, local } = backendWith();
    local.limit = 1;
    const lease = await opened(backend);

    lease.lease.release('done');

    expect(local.held).toBe(0);
  });

  it('removes a task\'s volume when its worktree goes, with no lease needed', async () => {
    const { backend, cli, local } = backendWith();

    await backend.letGo('a', { keep: false, reason: 'cancelled' });

    expect(cli.lines().some((line) => /^volume rm -f ordewell-task-/.test(line))).toBe(true);
    expect(local.letGoCalls).toEqual([{ taskId: 'a', keep: false, reason: 'cancelled' }]);
  });

  it('keeps it when the worktree is kept', async () => {
    const { backend, cli } = backendWith();

    await backend.letGo('a', { keep: true, reason: 'failed' });

    expect(cli.lines().some((line) => line.startsWith('volume rm'))).toBe(false);
  });
});

describe('the containers setting', () => {
  it('reads what it is given and defaults the rest', () => {
    expect(parseContainerSettings({ image: 'mine', login: { kind: 'own-sign-in' } })).toMatchObject({ image: 'mine', memory: '4g', memoryBytes: 4 * 1024 ** 3, caches: ['npm'], required: ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata'] });
  });

  it('lists the registries of the caches it keeps, unless told otherwise', () => {
    const login = { kind: 'own-sign-in' };

    expect(parseContainerSettings({ image: 'mine', login })).toMatchObject({ allow: ['registry.npmjs.org'] });
    expect(parseContainerSettings({ image: 'mine', login, caches: ['pip', 'go'] })).toMatchObject({ allow: ['pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'sum.golang.org'] });
    expect(parseContainerSettings({ image: 'mine', login, allow: ['github.com', '*.example.com'] })).toMatchObject({ allow: ['github.com', '*.example.com'] });
    expect(parseContainerSettings({ image: 'mine', login, allow: [] })).toMatchObject({ allow: [] });
  });

  it.each([
    [{ login: { kind: 'own-sign-in' } }, /image/],
    [{ image: 'mine' }, /choose/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, memory: 'lots' }, /memory/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, caches: ['/etc'] }, /caches/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, required: ['fs.nothing'] }, /required/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, allow: 'github.com' }, /allow/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, allow: ['https://github.com'] }, /allow/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, allow: ['1.1.1.1'] }, /allow/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, allow: ['*'] }, /allow/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, allow: ['*.com'] }, /allow/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, allow: ['localhost'] }, /allow/],
    ['docker', /object/],
  ])('refuses %j: a setting it cannot use must never run a task on the host instead', (raw, why) => {
    expect(parseContainerSettings(raw)).toMatchObject({ refused: expect.stringMatching(why) });
  });
});

/*
 * `probe()` is the report a surface shows before any task runs (L3). It is a
 * throwaway container with no login and no gateway, so it cannot prove a key it
 * never held unreadable, and it does not mount the sign-in volume an own-sign-in
 * lease's runner will read. The lease's own open proves this properly.
 */
describe('what a probe reports before any task runs (L3)', () => {
  it.each([
    ['broker', { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }],
    ['own-sign-in', { kind: 'own-sign-in' }],
  ])('does not claim cred.unreadable proven for a %s login it never held', async (_case, login) => {
    const { backend } = backendWith({ settings: { image: 'ordewell-task', login } });

    const report = await backend.probe();

    expect(report['cred.unreadable']).toMatchObject({ proven: false, by: expect.stringContaining('held no login') });
  });

  it("goes out as an own-sign-in lease does, with Anthropic's hosts on its list", async () => {
    const cli = new RecordingCli();
    const { backend } = backendWith({ cli, settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' } } });

    await backend.probe();

    expect(cli.sidecars[0].seen.join(' ')).toContain('api.anthropic.com');
  });
});

/*
 * A gate refusal is the case ADR-0059 L2 calls "it will not bring back: lands
 * nothing and waits on the user". The next attempt would seed the same clone from
 * the host, resetting its worktree and branch, so nothing starts until the user
 * gives that work up.
 */
describe('work that did not come back (L2)', () => {
  /** A volume a real engine would keep, which is all that tells a later Session of held work. */
  class EngineCli extends RecordingCli {
    volumes = new Set<string>();

    override async call(args: readonly string[], opts?: DockerCall): Promise<DockerResult> {
      if (args[0] === 'volume' && args[1] === 'create') this.volumes.add(args.at(-1)!);
      if (args[0] === 'volume' && args[1] === 'rm') this.volumes.delete(args.at(-1)!);
      if (args[0] === 'volume' && args[1] === 'ls') {
        const named = args.at(-1)!.slice('name='.length);
        return { ...OK, stdout: [...this.volumes].filter((volume) => volume.includes(named)).join('\n') };
      }
      return super.call(args, opts);
    }
  }

  const refused = async () => {
    const cli = new EngineCli();
    cli.answers.push({ match: /ORDEWELL_REF=/, result: { code: 1, stderr: 'the gate refused it' } });
    const made = backendWith({ cli });
    (await opened(made.backend)).lease.release('failed');
    await made.backend.letGo('a', { keep: true, reason: 'failed' });
    return { ...made, cli };
  };

  it('does not let the next attempt reset the volume its warning says the work stays in', async () => {
    const { backend, local, cli, told } = await refused();
    expect(told.some(({ text }) => /stays in its container's volume/.test(text))).toBe(true);
    const made = local.opened.length;

    await expect(opened(backend)).rejects.toBeInstanceOf(KeptWorkError);

    expect(cli.entries).toHaveLength(1);
    expect(local.opened).toHaveLength(made);
    expect(cli.lines().some((line) => /volume rm/.test(line))).toBe(false);
  });

  it('holds for a Continue as for any start, and before anything that would give its workspace up', async () => {
    const { backend } = await refused();

    await expect(opened(backend, taskRequest, { ...changeSpec, workspace: { kind: 'worktree', intent: 'restore', decision: { epoch: 1, mode: 'isolated' } } })).rejects.toBeInstanceOf(KeptWorkError);
    const missing = backendWith({ cli: new EngineCli(), setupCommand: 'npm ci' });
    await expect(opened(missing.backend)).rejects.toThrow(/setup command/);
  });

  it('holds past this Session: what says so is in the engine, where no container reaches it', async () => {
    const { cli, local } = await refused();
    const later = new DockerExecutionBackend(local, {
      ...WHERE_CONTAINERS_RUN,
      settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } },
      cli, git: git(), broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' }), sessionId: () => 'session-1', tell: () => undefined,
    });

    await expect(opened(later)).rejects.toBeInstanceOf(KeptWorkError);
    expect(cli.entries).toHaveLength(1);
  });

  it('lands nothing: a landing that asks after its box has gone is told so', async () => {
    const { backend } = await refused();

    await expect(backend.collect('a')).rejects.toBeInstanceOf(KeptWorkError);
  });

  it('gives a landing its reason, and marks the work held as it refuses', async () => {
    const cli = new EngineCli();
    cli.answers.push({ match: /ORDEWELL_REF=/, result: { code: 1, stderr: 'the gate refused it' } });
    const { backend } = backendWith({ cli });
    await opened(backend);

    await expect(backend.collect('a')).rejects.toThrow(/stays in its container's volume: Could not read the attempt's work out of its volume: the gate refused it\. Nothing starts/);
    expect([...cli.volumes].some((volume) => volume.startsWith('ordewell-held-'))).toBe(true);
    await expect(opened(backend)).rejects.toBeInstanceOf(KeptWorkError);
  });

  it('starts over once the user retries, which gives that work up', async () => {
    const { backend, cli } = await refused();

    await backend.letGo('a', { keep: false, reason: 'retried' });

    expect([...cli.volumes].filter((volume) => /ordewell-(held|task)-/.test(volume))).toEqual([]);
    await opened(backend);
    expect(cli.entries).toHaveLength(2);
  });

  it('carries the labels a clean-up finds it by', async () => {
    const { cli } = await refused();

    const held = cli.lines().find((line) => line.includes('ordewell-held-'))!;
    expect(held).toContain('--label ordewell.tree=session-1');
  });
});

describe('a Session closing (ADR-0059 L5)', () => {
  it('takes every container with it, with the relay and the way out it holds, and keeps its volume for a Continue', async () => {
    const { backend, cli } = backendWith();
    await opened(backend);

    await backend.settle();

    expect(cli.lines().some((line) => line.startsWith('rm -f ordewell-'))).toBe(true);
    const ended = ({ process }: { process: ChildProcess }) => process.exitCode !== null || process.signalCode !== null;
    await vi.waitFor(() => expect([...cli.entries, ...cli.sidecars].every(ended)).toBe(true));
    expect(cli.lines().some((line) => /volume rm/.test(line))).toBe(false);
  });

  it('waits for work on its way back, as it was let go', async () => {
    const cli = new RecordingCli();
    let bring!: () => void;
    const brought = new Promise<void>((resolve) => { bring = resolve; });
    const { backend } = backendWith({ cli });
    const call = cli.call.bind(cli);
    cli.call = async (args, opts) => {
      if (opts?.env?.ORDEWELL_REF) await brought;
      return call(args, opts);
    };
    (await opened(backend)).lease.release('stopped');
    void backend.letGo('a', { keep: true, reason: 'stopped' }).catch(() => undefined);

    let settled = false;
    void backend.settle().then(() => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(settled).toBe(false);

    bring();
    await vi.waitFor(() => expect(settled).toBe(true));
  });
});

/** What a person fixed or broke between two starts counts, and a check that passed once proves nothing of the next start. */
describe('the check at every task start', () => {
  it('refuses a start after the engine moved off this machine, though an earlier one passed', async () => {
    const { backend, cli } = backendWith();
    const first = await opened(backend);
    first.lease.release('done');
    cli.answers.push({ match: /^context inspect/, result: { stdout: 'tcp://build-box.example:2376\n' } });

    await expect(opened(backend, { ...taskRequest, node: { sessionId: 'session-1', taskId: 'b' } }, { ...changeSpec, task: { ...changeSpec.task!, id: 'b' } })).rejects.toThrow(/not on this machine/);
    expect(cli.entries).toHaveLength(1);
  });

  it('tells a person the remedy, not only the fault', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /^version/, result: { code: 1, stderr: 'Cannot connect to the Docker daemon' } });
    const { backend } = backendWith({ cli });

    await expect(opened(backend)).rejects.toThrow(/does not answer: Cannot connect to the Docker daemon\. .*(colima start|systemctl start docker)/);
  });

  it('turns a task down on a setting that is on and not yet configured, and never the host in its place', async () => {
    const { backend, cli, local } = backendWith({ settings: {} });

    await expect(opened(backend)).rejects.toThrow(/No image has been chosen.*No login has been chosen/);
    expect(local.opened).toEqual([]);
    expect(cli.entries).toEqual([]);
  });
});

/** A sign-in one task could write is a sign-in the next one loads: one task's code would run in the next (ADR-0059 L7). */
describe('a person\'s own sign-in in a task', () => {
  const OWN = { settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' } } };

  it('never mounts the kept sign-in where a runner runs, and hands it a copy of its own', async () => {
    const { backend, cli } = backendWith(OWN);
    const lease = await opened(backend);

    const entry = cli.entries[0].seen.join(' ');
    expect(entry).not.toContain(LOGIN_VOLUME);
    expect(entry).not.toContain('/login:');
    expect(entry).toContain('CLAUDE_CONFIG_DIR=/task/login/claude');
    lease.lease.release('done');
  });

  it('copies it read-only, with no network, and before the runner has a container', async () => {
    const { backend, cli } = backendWith(OWN);
    const order: string[] = [];
    const isCopy = (line: string) => line.startsWith('run') && line.includes(LOGIN_VOLUME) && line.includes(COPY_SIGN_IN);
    cli.heard = (line) => { if (isCopy(line)) order.push(`copy, entries ${cli.entries.length}`); };
    const lease = await opened(backend);

    const copy = cli.lines().find(isCopy);
    expect(copy).toContain(`${LOGIN_VOLUME}:/login:ro`);
    expect(copy).toContain('--network none');
    expect(order).toEqual(['copy, entries 0']);
    lease.lease.release('done');
  });

  it('refuses a task it could not give the sign-in to, naming how to make one', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: new RegExp(`^run .*${LOGIN_VOLUME}[^]*cp -a`), result: { code: 3, stderr: 'no sign-in' } });
    const { backend } = backendWith({ ...OWN, cli });

    await expect(opened(backend)).rejects.toThrow(/sign in as docs\/containers\.md shows/i);
    expect(cli.entries).toEqual([]);
  });

  it('copies nothing for a script, which holds no login', async () => {
    const { backend, cli } = backendWith(OWN);
    const lease = await opened(backend, scriptRequest);

    expect(cli.lines().filter((line) => line.includes(LOGIN_VOLUME))).toEqual([]);
    lease.lease.release('done');
  });

  it('tells the probe where the copy is, so what it reports is of that', async () => {
    const { backend, cli, told } = backendWith(OWN);
    cli.probe = { loginReadable: true };
    const lease = await opened(backend);

    expect(cli.asked[0].login).toBe('/task/login/claude');
    expect(told.some(({ text }) => text.includes('cred.unreadable'))).toBe(true);
    lease.lease.release('done');
  });
});

/** A cache every task writes is a way for one task's code to run in the next. */
describe('package caches', () => {
  it('stay in the task\'s own volume, shared with no other task', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    const entry = cli.entries[0].seen.join(' ');
    expect(entry).not.toContain('ordewell-cache-');
    expect(entry).toContain('npm_config_cache=/task/caches/npm');
    lease.lease.release('done');
  });

  it('are no mounts the probe would call strange', async () => {
    const { backend } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, caches: ['npm', 'pip'] } });

    const lease = await opened(backend);

    expect(lease.guarantees['fs.hostHidden'].proven).toBe(true);
    lease.lease.release('done');
  });
});

describe('what a person is told of a lease\'s guarantees', () => {
  it('names what was not proven, once for a session', async () => {
    const { backend, cli, told } = backendWith();
    cli.probe = { kernel: `${osType()} ${release()}` };
    const first = await opened(backend);
    first.lease.release('done');
    const second = await opened(backend, { ...taskRequest, node: { sessionId: 'session-1', taskId: 'b' } }, { ...changeSpec, task: { ...changeSpec.task!, id: 'b' } });
    second.lease.release('done');

    const about = told.filter(({ text }) => text.includes('kernel.separate'));
    expect(about).toHaveLength(1);
    expect(about[0].text).not.toContain('fs.hostHidden');
  });
});

describe('a probe that fails', () => {
  it('leaves no container behind when its CLI gives up on it', async () => {
    const { backend, cli } = backendWith();
    cli.answers.push({ match: /ORDEWELL_PROBE=/, result: { code: 137, stdout: '', stderr: '' } });

    await expect(backend.probe()).rejects.toThrow(/probe/);

    const run = cli.calls.find(({ opts }) => opts?.env?.ORDEWELL_PROBE)!.args;
    const name = run[run.indexOf('--name') + 1];
    expect(run.join(' ')).toContain('ordewell.tree=');
    const lines = cli.lines();
    expect(lines.indexOf(`rm -f ${name}`)).toBeGreaterThan(-1);
    expect(lines.indexOf(`rm -f ${name}`)).toBeLessThan(lines.findIndex((line) => line.startsWith('network rm')));
  });

  it('gives its way out back whatever the probe threw', async () => {
    const closed = vi.fn(async () => undefined);
    const route: EgressRoute = { runArgs: [], env: {}, proxied: true, gateway: null, close: closed };
    const cli = new RecordingCli();
    cli.call = async function call(args, opts) {
      if (opts?.env?.ORDEWELL_PROBE) throw new Error('the CLI fell over');
      return RecordingCli.prototype.call.call(this, args, opts);
    };
    const backend = new DockerExecutionBackend(new FakeExecutionBackend(), {
      ...WHERE_CONTAINERS_RUN,
      settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } }, cli, git: git(), egress: { open: async () => route },
      broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'k' }), sessionId: () => 'session-1', tell: () => undefined,
    });

    await expect(backend.probe()).rejects.toThrow(/fell over/);

    expect(closed).toHaveBeenCalledOnce();
  });
});

/** A Codex change task, end to end at this seam: the real binary's half is codexContainer.e2e's. */
describe('a Codex task in a container', () => {
  const codexRequest: LeaseRequest = { ...taskRequest, runner: 'codex' };
  const otherTask: LeaseRequest = { ...codexRequest, node: { sessionId: 'session-1', taskId: 'b' } };
  const otherSpec: LeaseSpec = { ...changeSpec, task: { ...changeSpec.task!, id: 'b' } };
  const KEY = 'sk-proj-test-key';
  const BROKER = { settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['OPENAI_API_KEY'] } }, env: { OPENAI_API_KEY: KEY } };

  it('holds a lease token for its API key, and the key stays on this host', async () => {
    const { backend, cli } = backendWith(BROKER);
    const lease = await opened(backend, codexRequest);

    const placed = await lease.placement!.place({ command: 'codex', args: ['app-server'], env: {}, files: [] });

    expect(placed.env.OPENAI_API_KEY).toMatch(/^ordewell-lease-/);
    expect(JSON.stringify([placed, cli.calls, cli.entries.map(({ seen }) => seen), cli.sidecars.map(({ seen }) => seen)])).not.toContain(KEY);
    placed.ended();
    lease.lease.release('done');
  });

  it('gives two tasks at once a stand-in each for the one key, so neither holds what the other does', async () => {
    const { backend, cli } = backendWith(BROKER);
    const first = await opened(backend, codexRequest);
    const second = await opened(backend, otherTask, otherSpec);

    const [one, other] = await Promise.all([first, second].map(({ placement }) => placement!.place({ command: 'codex', args: ['app-server'], env: {}, files: [] })));

    expect(other.env.OPENAI_API_KEY).toMatch(/^ordewell-lease-/);
    expect(other.env.OPENAI_API_KEY).not.toBe(one.env.OPENAI_API_KEY);
    expect(cli.entries).toHaveLength(2);
    for (const placed of [one, other]) placed.ended();
    for (const { lease } of [first, second]) lease.release('done');
  });

  it('points app-server at the gateway, which is the one way Codex takes a key: it ignores both variables', async () => {
    const { backend } = backendWith(BROKER);
    const lease = await opened(backend, codexRequest);

    const placed = await lease.placement!.place({ command: 'codex', args: ['app-server', '-c', 'features.memories=false'], env: {}, files: [] });

    const line = placed.args.join(' ');
    expect(line).toMatch(/model_providers\.gateway=\{.*base_url="http:\/\/127\.0\.0\.1:\d+\/v1".*env_key="OPENAI_API_KEY".*wire_api="responses".*supports_websockets=false/);
    expect(line).toContain('model_provider="gateway"');
    placed.ended();
    lease.lease.release('done');
  });

  it('names the working directory the runner sees, which is the one its launch runs in', async () => {
    const { backend } = backendWith(BROKER);
    const lease = await opened(backend, codexRequest);

    const placed = await lease.placement!.place({ command: 'codex', args: ['app-server'], env: {}, files: [] });

    expect(lease.placement!.cwd).toMatch(/^\/task\/work(\/|$)/);
    expect(placed.args).toContain(lease.placement!.cwd);
    placed.ended();
    lease.lease.release('done');
  });

  it('refuses at start an image that holds no Codex, naming how to build one, and leaves nothing behind', async () => {
    const cli = new RecordingCli();
    cli.answers.push({ match: /^exec .*command -v/, result: { code: 1 } });
    const { backend } = backendWith({ ...BROKER, cli });

    await expect(opened(backend, codexRequest)).rejects.toThrow(/ordewell-task holds no codex.*docs\/containers\.md/s);

    const name = cli.entries[0].seen[cli.entries[0].seen.indexOf('--name') + 1];
    expect(cli.lines()).toContain(`rm -f ${name}`);
  });

  it('asks nothing of a script, which needs no runner in the image', async () => {
    const { backend, cli } = backendWith(BROKER);
    const lease = await opened(backend, scriptRequest);

    expect(cli.lines().filter((line) => line.includes('command -v'))).toEqual([]);
    lease.lease.release('done');
  });

  describe('on a person\'s own sign-in', () => {
    const OWN = { settings: { image: 'ordewell-task', login: { kind: 'own-sign-in' } } };

    it('never mounts the kept sign-in where a runner runs, or Claude\'s: it hands it a copy of its own', async () => {
      const { backend, cli } = backendWith(OWN);
      const lease = await opened(backend, codexRequest);

      const entry = cli.entries[0].seen.join(' ');
      expect(entry).not.toContain(CODEX_LOGIN_VOLUME);
      expect(entry).not.toContain('/login:');
      expect(cli.lines().filter((line) => line.includes(LOGIN_VOLUME))).toEqual([]);
      lease.lease.release('done');
    });

    it('copies it read-only, with no network, and before the runner has a container', async () => {
      const { backend, cli } = backendWith(OWN);
      const order: string[] = [];
      cli.heard = (line) => { if (line.includes(CODEX_LOGIN_VOLUME) && line.startsWith('run')) order.push(`copy, entries ${cli.entries.length}`); };
      const lease = await opened(backend, codexRequest);

      const copy = cli.lines().find((line) => line.includes(CODEX_LOGIN_VOLUME) && line.startsWith('run'));
      expect(copy).toContain(`${CODEX_LOGIN_VOLUME}:/login:ro`);
      expect(copy).toContain('--network none');
      expect(order).toEqual(['copy, entries 0']);
      lease.lease.release('done');
    });

    it('copies it into each task\'s own volume, so two tasks at once share no credentials file', async () => {
      const { backend, cli } = backendWith(OWN);
      const leases = [await opened(backend, codexRequest), await opened(backend, otherTask, otherSpec)];

      const copies = cli.lines().filter((line) => line.includes(CODEX_LOGIN_VOLUME) && line.startsWith('run'));
      const volumes = copies.map((line) => /-v (\S+):\/task\b/.exec(line)?.[1]);
      expect(volumes).toHaveLength(2);
      expect(volumes.every(Boolean)).toBe(true);
      expect(new Set(volumes).size).toBe(2);
      for (const { lease } of leases) lease.release('done');
    });

    it('refuses a sign-in the copy turned down, in the copy\'s words and naming how to make one', async () => {
      const cli = new RecordingCli();
      cli.answers.push({ match: new RegExp(`^run .*${CODEX_LOGIN_VOLUME}`), result: { code: 3, stderr: 'the kept sign-in has expired\n' } });
      const { backend } = backendWith({ ...OWN, cli });

      await expect(opened(backend, codexRequest)).rejects.toThrow(/the kept sign-in has expired.*sign in as docs\/containers\.md shows/is);
      expect(cli.entries).toEqual([]);
    });

    it('lets the sidecar reach the service a sign-in talks to, and not the one that would refresh it', async () => {
      const { backend, cli } = backendWith(OWN);
      const lease = await opened(backend, codexRequest);

      const sidecar = cli.sidecars[0].seen.join(' ');
      expect(sidecar).toContain('chatgpt.com');
      expect(sidecar).not.toContain('auth.openai.com');
      lease.lease.release('done');
    });

    it('tells the probe where the copy is, so what it reports is of that', async () => {
      const { backend, cli, told } = backendWith(OWN);
      cli.probe = { loginReadable: true };
      const lease = await opened(backend, codexRequest);

      expect(cli.asked[0].login).toBe('/task/home/.codex/auth.json');
      expect(told.some(({ text }) => text.includes('cred.unreadable'))).toBe(true);
      lease.lease.release('done');
    });

    it('has Codex read the file it was handed, wherever that person keeps their own, and no gateway', async () => {
      const { backend } = backendWith(OWN);
      const lease = await opened(backend, codexRequest);

      const placed = await lease.placement!.place({ command: 'codex', args: ['app-server'], env: {}, files: [] });

      expect(placed.args.join(' ')).toContain('cli_auth_credentials_store="file"');
      expect(placed.args.join(' ')).not.toContain('model_provider');
      placed.ended();
      lease.lease.release('done');
    });
  });

  it('leaves a script step of the same lease as it was written', async () => {
    const { backend } = backendWith(BROKER);
    const lease = await opened(backend, codexRequest);

    const placed = await lease.placement!.place({ command: 'sh', args: ['-c', 'codex app-server'], env: {}, files: [] });

    expect(placed.args.join(' ')).not.toContain('model_provider');
    placed.ended();
    lease.lease.release('done');
  });
});
