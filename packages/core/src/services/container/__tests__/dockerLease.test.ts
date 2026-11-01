import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialBroker } from '../credentialBroker';
import { DockerExecutionBackend, whereItRuns } from '../dockerLease';
import { parseContainerSettings } from '../containerSettings';
import { RELAY_ENTRY } from '../leaseRelay';
import type { DockerCall, DockerCli, DockerResult } from '../dockerCli';
import type { ProbeFindings } from '../guaranteeProbe';
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

/** What a probe finds in a container this lease built: all it can prove, proven. */
const cleanProbe: ProbeFindings = {
  hostPathsFound: [],
  mounts: [{ point: '/', type: 'overlay' }, { point: '/task', type: 'ext4' }, { point: '/mirror', type: 'ext4' }, { point: '/tmp', type: 'tmpfs' }],
  dockerSocket: false,
  writesPassed: [],
  workspaceWritable: true,
  kernel: 'Linux 6.8.0',
  memoryMax: '4294967296',
  swapMax: '0',
  pidsMax: '8192',
  metadata: 'ECONNREFUSED',
  gateway: 'ECONNREFUSED',
  credentialsVisible: [],
  loginReadable: false,
};

class RecordingCli implements DockerCli {
  calls: { args: readonly string[]; opts?: DockerCall }[] = [];
  entries: { args: readonly string[]; process: ChildProcess }[] = [];
  probe: Partial<ProbeFindings> = {};
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
    if (line.includes('ORDEWELL_PROBE=')) return { ...OK, stdout: JSON.stringify({ ...cleanProbe, ...this.probe }) };
    return OK;
  }

  async entry(args: readonly string[]): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['-e', RELAY_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.entries.push({ args, process: child });
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

async function opened(backend: DockerExecutionBackend, request = taskRequest, spec = changeSpec, signal = new AbortController().signal): Promise<OpenLease & { lease: { release(reason: string): void } }> {
  const reserved = backend.reserve(request);
  if ('refused' in reserved) throw new Error(reserved.refused);
  return Object.assign(await reserved.lease.open(spec, signal), { lease: reserved.lease });
}

describe('what runs in a container (ADR-0059 L5)', () => {
  it('runs a change task there', () => {
    expect(whereItRuns(taskRequest, changeSpec)).toBe('container');
  });

  it.each<[LeaseRequest['role']]>([['planner'], ['merge'], ['script'], ['child-plan']])('leaves a %s on the host', (role) => {
    expect(whereItRuns({ ...taskRequest, role }, changeSpec)).toBe('host');
  });

  it('leaves a read-only task on the host, sealed as it always is', () => {
    expect(whereItRuns(taskRequest, { ...changeSpec, workspace: { kind: 'worktree', intent: 'readOnly' } })).toBe('host');
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

  it('refuses a guarantee the settings require and no probe can prove: the allowlist, until L7', async () => {
    const { backend } = backendWith({ settings: { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, required: ['net.allowlist'] } });

    await expect(opened(backend)).rejects.toThrow(/net\.allowlist/);
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

  it('says plainly that its network is not limited, once', async () => {
    const { backend, told } = backendWith();
    const first = await opened(backend);
    first.lease.release('done');

    expect(told.filter(({ text }) => /network/.test(text))).toHaveLength(1);
    expect(told.find(({ text }) => /network/.test(text))?.level).toBe('warn');
  });
});

describe('a runner placed in the container', () => {
  it('reaches it by exec, with secrets by name and never in an argument', async () => {
    const { backend } = backendWith();
    const lease = await opened(backend);

    const placed = await lease.placement!.place({ command: 'claude', args: ['-p'], env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, files: [] });

    expect(placed.command).toBe('docker');
    expect(placed.args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(placed.args).toContain('ANTHROPIC_API_KEY');
    expect(placed.args.join(' ')).not.toContain('sk-ant-api03-test');
    expect(placed.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
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
    await opened(backend, { ...taskRequest, role: 'script' });

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
    expect(parseContainerSettings({ image: 'mine', login: { kind: 'own-sign-in' } })).toMatchObject({ image: 'mine', memory: '4g', memoryBytes: 4 * 1024 ** 3, caches: ['npm'], required: ['fs.hostHidden', 'fs.writeScope', 'limits.memory'] });
  });

  it.each([
    [{ login: { kind: 'own-sign-in' } }, /image/],
    [{ image: 'mine' }, /choose/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, memory: 'lots' }, /memory/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, caches: ['/etc'] }, /caches/],
    [{ image: 'mine', login: { kind: 'own-sign-in' }, required: ['fs.nothing'] }, /required/],
    ['docker', /object/],
  ])('refuses %j: a setting it cannot use must never run a task on the host instead', (raw, why) => {
    expect(parseContainerSettings(raw)).toMatchObject({ refused: expect.stringMatching(why) });
  });
});
