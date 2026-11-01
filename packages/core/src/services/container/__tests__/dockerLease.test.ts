import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialBroker } from '../credentialBroker';
import { DockerExecutionBackend, whereItRuns } from '../dockerLease';
import { parseContainerSettings } from '../containerSettings';
import { EGRESS_ENTRY } from '../egressSidecar';
import { RELAY_ENTRY } from '../leaseRelay';
import type { DockerCall, DockerCli, DockerResult } from '../dockerCli';
import type { ProbeAsked, ProbeFindings } from '../guaranteeProbe';
import { LeaseGuaranteeError, type LeaseRepo, type LeaseRequest, type LeaseSpec, type OpenLease } from '../../executionLease';
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

class RecordingCli implements DockerCli {
  calls: { args: readonly string[]; opts?: DockerCall }[] = [];
  entries: { args: readonly string[]; process: ChildProcess }[] = [];
  sidecars: { args: readonly string[]; process: ChildProcess }[] = [];
  probe: Partial<ProbeFindings> = {};
  /** Every probe it was told to run, as it was told. */
  asked: ProbeAsked[] = [];
  answers: { match: RegExp; result: Partial<DockerResult> }[] = [];

  /** Hears each call as it is made, for what must come before what. */
  heard: (line: string) => void = () => undefined;

  async call(args: readonly string[], opts?: DockerCall): Promise<DockerResult> {
    this.calls.push({ args, ...(opts ? { opts } : {}) });
    const line = args.join(' ');
    this.heard(line);
    const set = this.answers.find(({ match }) => match.test(line));
    if (set) return { ...OK, ...set.result };
    if (args.includes('rm') && args[0] === 'rm') for (const entry of this.entries) entry.process.kill('SIGKILL');
    const told = args.find((arg) => arg.startsWith('ORDEWELL_PROBE='));
    if (told) {
      const asked = JSON.parse(told.slice('ORDEWELL_PROBE='.length)) as ProbeAsked;
      this.asked.push(asked);
      return { ...OK, stdout: JSON.stringify({ ...cleanProbe(asked), ...this.probe }) };
    }
    return OK;
  }

  async entry(args: readonly string[]): Promise<ChildProcess> {
    const sidecar = args.includes(EGRESS_ENTRY);
    const child = sidecar
      ? spawn(process.execPath, ['-e', SIDECAR_READY], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.execPath, ['-e', OWN_LOOPBACK + RELAY_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    (sidecar ? this.sidecars : this.entries).push({ args, process: child });
    return child;
  }

  lines(): string[] { return this.calls.map(({ args }) => args.join(' ')); }
}

const repo: LeaseRepo = { path: '.', root: '/repo', worktree: '/repo/.ordewell/wt/a', branch: 'ordewell/a', integrationBranch: 'ordewell/integration', linked: [] };

/** git for what the backend asks of this host: every ref is one commit, and no push fails. */
const git = (hooks = '/no/such/hooks'): GitInvoker => ({ exec: async (_file, args) => ({ stdout: args.includes('--git-path') ? `${hooks}\n` : 'abc123\n', stderr: '' }), resolvePath: async () => '/usr/bin' });

function backendWith(over: { settings?: unknown; cli?: RecordingCli; env?: Record<string, string>; hooks?: string; setupCommand?: string } = {}) {
  const local = new FakeExecutionBackend();
  local.repos = [repo];
  const cli = over.cli ?? new RecordingCli();
  const told: { level: string; text: string }[] = [];
  const settings = parseContainerSettings(over.settings ?? { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } });
  const backend = new DockerExecutionBackend(local, {
    settings,
    cli,
    git: git(over.hooks),
    ...(over.setupCommand ? { setupCommand: () => over.setupCommand } : {}),
    broker: new CredentialBroker(over.env ?? { ANTHROPIC_API_KEY: 'sk-ant-api03-test' }),
    sessionId: () => 'session-1',
    tell: (level, text) => told.push({ level, text }),
  });
  return { backend, local, cli, told };
}

const taskRequest: LeaseRequest = { node: { sessionId: 'session-1', taskId: 'a' }, role: 'task', runner: 'claude-code' };
const changeSpec: LeaseSpec = { task: createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a' }), workspace: { kind: 'worktree', intent: 'fresh' }, required: [] };
const readOnlySpec: LeaseSpec = { ...changeSpec, workspace: { kind: 'worktree', intent: 'readOnly' } };
const checkoutSpec: LeaseSpec = { ...changeSpec, workspace: { kind: 'checkout' } };
const scriptRequest: LeaseRequest = { ...taskRequest, role: 'script' };

async function opened(backend: DockerExecutionBackend, request = taskRequest, spec = changeSpec, signal = new AbortController().signal): Promise<OpenLease & { lease: { release(reason: string): void } }> {
  const reserved = backend.reserve(request);
  if ('refused' in reserved) throw new Error(reserved.refused);
  return Object.assign(await reserved.lease.open(spec, signal), { lease: reserved.lease });
}

describe('what runs in a container (ADR-0059 L5)', () => {
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

  it('refuses when no login was chosen: a person chooses it', async () => {
    const { backend, local } = backendWith({ settings: { image: 'ordewell-task' } });

    await expect(opened(backend)).rejects.toThrow(/choose/);
    expect(local.opened).toEqual([]);
  });

  it('refuses a runner no container has been proven with', async () => {
    const { backend, local } = backendWith();

    await expect(opened(backend, { ...taskRequest, runner: 'codex' })).rejects.toThrow(/codex/);
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

    const args = cli.entries[0].args;
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

    expect(cli.entries[0].args.find((arg) => arg.endsWith(':/mirror:ro'))).toBeDefined();
    lease.lease.release('done');
  });

  it('gives a helper the same limits, and no network', async () => {
    const { backend, cli, local } = backendWith();
    local.repos = [repo];
    await opened(backend);
    await backend.collect('a').catch(() => undefined);

    const helper = cli.calls.find(({ args }) => args[0] === 'run' && args.join(' ').includes('--network none'));
    expect(helper?.args.join(' ')).toContain('--pids-limit 8192');
    expect(helper?.args).toContain('--init');
    expect(helper?.args.join(' ')).toContain('--memory 4g');
  });

  it('turns off the traffic a proxied lease must not make', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    expect(cli.entries[0].args).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
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

    const network = flagOf(cli.entries[0].args, '--network');
    const made = cli.lines().find((line) => line.startsWith('network create'))!;
    expect(made).toContain('--internal');
    expect(made.endsWith(network)).toBe(true);
    expect(cli.entries[0].args.filter((arg) => arg === '--network')).toHaveLength(1);
    lease.lease.release('done');
  });

  it('runs one sidecar for it, on that network, and gives only the sidecar the bridge', async () => {
    const { backend, cli } = backendWith();
    const lease = await opened(backend);

    expect(cli.sidecars).toHaveLength(1);
    const { args } = cli.sidecars[0];
    expect(flagOf(args, '--network')).toBe(flagOf(cli.entries[0].args, '--network'));
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

    const sidecar = flagOf(cli.sidecars[0].args, '--name');
    for (const variable of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) expect(cli.entries[0].args).toContain(`${variable}=http://${sidecar}:3128`);
    expect(cli.entries[0].args.find((arg) => arg.startsWith('NO_PROXY='))).toContain('127.0.0.1');
    expect(cli.entries[0].args.find((arg) => arg.startsWith('no_proxy='))).toContain('127.0.0.1');
    lease.lease.release('done');
  });

  const listOf = (cli: RecordingCli) => (JSON.parse(cli.sidecars[0].args.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))!.slice('ORDEWELL_EGRESS='.length)) as { allow: string[] }).allow;

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
    const box = flagOf(cli.entries[0].args, '--name');
    const sidecar = flagOf(cli.sidecars[0].args, '--name');
    const network = flagOf(cli.entries[0].args, '--network');

    await lease.ended!();

    const lines = cli.lines();
    const order = [`rm -f ${box}`, `rm -f ${sidecar}`, `network rm ${network}`].map((line) => lines.indexOf(line));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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
    expect(JSON.stringify(cli.entries.map(({ args }) => args))).not.toContain('sk-ant-api03-test');
    expect(JSON.stringify(cli.sidecars.map(({ args }) => args))).not.toContain('sk-ant-api03-test');
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

    expect(cli.entries[0].args.join(' ')).not.toContain('/login');
    expect(cli.entries[0].args.join(' ')).not.toContain('CLAUDE_CONFIG_DIR');
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

    expect(cli.sidecars[0].args.find((arg) => arg.startsWith('ORDEWELL_EGRESS='))).toContain('"allow":[]');
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
      const lone = new DockerExecutionBackend(local, { settings: parseContainerSettings({ image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } }), cli, git: refusing, broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'k' }), sessionId: () => 'session-1', tell: () => undefined });

      await expect(opened(lone, scriptRequest, checkoutSpec)).rejects.toThrow(/git repository/);
      expect(cli.entries).toEqual([]);
      void backend;
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

      expect(cli.entries[0].args.join(' ')).toContain('--network none');
      expect(cli.sidecars).toEqual([]);
      expect(cli.lines().some((line) => line.startsWith('network create'))).toBe(false);
      expect(cli.entries[0].args.some((arg) => /^HTTPS?_PROXY=/.test(arg))).toBe(false);
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

    it('keeps nothing: its volume goes with its attempt, and a retry gets its own', async () => {
      const { backend, cli } = backendWith();
      const first = await opened(backend, scriptRequest, readOnlySpec);
      const volume = cli.entries[0].args.find((arg) => arg.endsWith(':/task'))!.split(':')[0];

      first.lease.release('verdict');
      await vi.waitFor(() => expect(cli.lines()).toContain(`volume rm -f ${volume}`));

      const second = await opened(backend, scriptRequest, readOnlySpec);
      expect(cli.entries[1].args.find((arg) => arg.endsWith(':/task'))!.split(':')[0]).not.toBe(volume);
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
    const { backend, cli, local } = backendWith();
    const first = await opened(backend);
    first.lease.release('failed');
    let preparedBeforeExport: number | null = null;
    cli.heard = (line) => { if (line.includes('ORDEWELL_REF=')) preparedBeforeExport ??= local.opened.length; };

    await opened(backend, taskRequest, { ...changeSpec, workspace: { kind: 'worktree', intent: 'restore' } });

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
