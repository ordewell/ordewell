import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { accountLimitsText } from '../../../models/AccountLimits';
import { AccountLimitMonitor } from '../../AccountLimitMonitor';
import { claudeAccountLimitCollector } from '../claudeAccountLimits';
import type { AgentProcessDeps, SpawnFn } from '../AgentAdapter';
import { argvWithFiles, silentSpawn, type FakeAgentProcess, type FakeLaunch } from '../../__tests__/harnessTestKit';

/**
 * The real collector and the real ClaudeCodeAdapter control channel against a
 * fake `claude` process that answers each control request as the test says,
 * so a test sees every line the probe wrote and every argument it ran with.
 */

/** `initialize`'s account, as `claude` 2.1.309 answered it for a Max login (email and organization replaced). */
const SIGNED_IN = { email: 'someone@example.com', organization: 'Example Org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' };

/**
 * `get_usage {skip_behaviors: true}` as `claude` 2.1.309 answered it, trimmed:
 * the documented windows, one of the undocumented buckets beside them, the
 * server's own rows and the spend, which are not windows of their own.
 */
const LIVE_USAGE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 937, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 37, resets_at: '2096-10-25T18:29:59.758364+00:00', limit_dollars: null, used_dollars: null },
    seven_day: { utilization: 44, resets_at: '2096-10-30T01:59:59.758388+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    iguana_necktie: { utilization: 77.79, resets_at: '2096-11-05T07:59:00+00:00', limit_dollars: 250 },
    extra_usage: { is_enabled: false, monthly_limit: 6000, used_credits: 0, utilization: 0, currency: 'USD' },
    limits: [{ kind: 'session', group: 'session', percent: 37, severity: 'normal', resets_at: '2096-10-25T18:29:59.758364+00:00', scope: null, is_active: false }],
    model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2096-10-30T02:00:00+00:00' }],
  },
  behaviors: null,
};

interface ControlRequest { type?: string; request_id?: string; request?: { subtype?: string; skip_behaviors?: boolean } }

/** How the fake answers one request: a payload, an error envelope, raw lines, or nothing. */
type Answer = { success: unknown } | { error: string } | { raw: (requestId: string) => unknown[] } | 'hang';

interface Script {
  initialize?: Answer;
  get_usage?: Answer;
  /** The process says this on stderr and exits at once, as a CLI refusing its arguments does. */
  refuse?: string;
}

const spawned: { proc: FakeAgentProcess; args: string[]; cwd: string; env: NodeJS.ProcessEnv; launch: FakeLaunch }[] = [];
afterEach(() => { spawned.length = 0; });

function fakeClaude(script: Script | (() => Script)) {
  const fake = silentSpawn((written, proc) => {
    const answers = typeof script === 'function' ? current.get(proc)! : script;
    let msg: ControlRequest;
    try { msg = JSON.parse(written) as ControlRequest; } catch { return; }
    if (msg.type !== 'control_request' || !msg.request_id) return;
    const subtype = msg.request?.subtype;
    const answer: Answer = subtype === 'initialize' ? answers.initialize ?? { success: { account: SIGNED_IN } }
      : subtype === 'get_usage' ? answers.get_usage ?? { success: LIVE_USAGE }
      : { error: `Unsupported control request subtype: ${subtype}` };
    if (answer === 'hang') return;
    const lines = 'raw' in answer ? answer.raw(msg.request_id)
      : [{ type: 'control_response', response: 'success' in answer
        ? { subtype: 'success', request_id: msg.request_id, response: answer.success }
        : { subtype: 'error', request_id: msg.request_id, error: answer.error } }];
    proc.emitStdout(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  });
  const current = new Map<FakeAgentProcess, Script>();
  const spawn: SpawnFn = (command, args, options) => {
    const child = fake.spawn(command, args, options);
    const proc = fake.processes.at(-1)!;
    spawned.push({ proc, args, cwd: options.cwd, env: options.env, launch: fake.lastLaunch() });
    const answers = typeof script === 'function' ? script() : script;
    current.set(proc, answers);
    if (answers.refuse) {
      const words = answers.refuse;
      queueMicrotask(() => { proc.emitStderr(words); proc.exit(1); });
    }
    return child;
  };
  const deps: Partial<AgentProcessDeps> = { spawn, resolvePath: async () => '/usr/bin', platform: 'linux', exists: () => true };
  return deps;
}

function collector(script: Script | (() => Script), timeoutMs = 2000) {
  return claudeAccountLimitCollector({ isInstalled: async () => true, timeoutMs, deps: fakeClaude(script) });
}

const read = (c: ReturnType<typeof collector>, signal = new AbortController().signal) => c.acquire(signal);

/** Every line the probe wrote, parsed. */
const writes = (proc: FakeAgentProcess) => proc.written.map((w) => JSON.parse(w) as ControlRequest);

describe('the Claude Code account-limit collector', () => {
  it('asks initialize, then get_usage without the transcript scan, on its own request ids, and never writes a user message', async () => {
    const reading = await read(collector({}));

    expect(reading.kind).toBe('limits');
    const { proc } = spawned[0];
    const sent = writes(proc);
    expect(sent.map((w) => [w.type, w.request])).toEqual([
      ['control_request', { subtype: 'initialize' }],
      ['control_request', { subtype: 'get_usage', skip_behaviors: true }],
    ]);
    expect(new Set(sent.map((w) => w.request_id)).size).toBe(2);
    expect(proc.stdinEnded).toBe(true);
    expect(proc.killed).toBe(true);
  });

  it('runs a launch of its own: OAuth kept, nothing of the user, the repository, plugins, hooks, tools or MCP started, no session saved', async () => {
    await read(collector({}));

    const { args, cwd, launch } = spawned[0];
    // Its settings in files, as every Claude launch's are (ADR-0010 §1): JSON on the command line holds a quote.
    const shown = argvWithFiles(launch);
    expect(shown.args).toEqual([
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--verbose',
      '--safe-mode',
      '--setting-sources=',
      '--settings', '<settings.json>',
      '--strict-mcp-config',
      '--mcp-config', '<no-mcp-servers.json>',
      '--tools=',
      '--permission-mode=default',
      '--no-session-persistence',
    ]);
    expect(shown.files).toEqual({ 'settings.json': '{"disableAllHooks":true}', 'no-mcp-servers.json': '{"mcpServers":{}}' });
    expect([...launch.files.keys()].filter((file) => existsSync(file))).toEqual([]);
    // `--bare` never reads the OAuth login a subscription's limits belong to.
    expect(args).not.toContain('--bare');
    expect(args.some((a) => a.startsWith('--model') || a.startsWith('--resume') || a.startsWith('--append-system-prompt') || a.startsWith('--add-dir'))).toBe(false);
    // An empty directory of its own, gone after the read: no workspace, no CLAUDE.md, no project settings.
    expect(cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it('files the account window first and every scoped window after it under its own name, ignoring undocumented buckets and spend', async () => {
    const reading = await read(collector({}));

    expect(reading).toEqual({
      kind: 'limits',
      owner: expect.any(String),
      plan: 'max',
      buckets: [
        { id: 'claude', windows: [
          { slot: 'primary', usedPercent: 37, durationMinutes: 300, resetsAt: '2096-10-25T18:29:59.758Z' },
          { slot: 'secondary', usedPercent: 44, durationMinutes: 10080, resetsAt: '2096-10-30T01:59:59.758Z' },
        ] },
        { id: 'model:Fable', name: 'Fable', windows: [{ slot: 'primary', usedPercent: 0, durationMinutes: 10080, resetsAt: '2096-10-30T02:00:00.000Z' }] },
      ],
    });
  });

  it('reads the fixed per-model and OAuth-app weekly windows beside the model-scoped ones, in the order the protocol documents them', async () => {
    const reading = await read(collector({ get_usage: { success: { ...LIVE_USAGE, rate_limits: {
      seven_day: { utilization: 10, resets_at: null },
      seven_day_oauth_apps: { utilization: 5, resets_at: null },
      seven_day_opus: { utilization: 20, resets_at: null },
      seven_day_sonnet: { utilization: 30, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 40, resets_at: null }],
    } } } }));

    expect(reading.kind === 'limits' && reading.buckets.map((b) => [b.id, b.name, b.windows.map((w) => w.usedPercent)])).toEqual([
      ['claude', undefined, [10]],
      ['seven_day_oauth_apps', 'OAuth apps', [5]],
      ['seven_day_opus', 'Opus', [20]],
      ['seven_day_sonnet', 'Sonnet', [30]],
      ['model:Fable', 'Fable', [40]],
    ]);
  });

  it('keeps a reported 0% and an unreported share apart, and refuses shares and resets outside the contract instead of coercing them', async () => {
    const reading = await read(collector({ get_usage: { success: { ...LIVE_USAGE, rate_limits: {
      five_hour: { utilization: 0, resets_at: '2096-01-01T00:00:00Z' },
      seven_day: { utilization: null, resets_at: '2096-01-08T00:00:00-05:00' },
      seven_day_opus: { utilization: '12', resets_at: '2096-01-08T00:00:00' },
      seven_day_sonnet: { utilization: 101, resets_at: 'next week' },
      seven_day_oauth_apps: { utilization: -1, resets_at: 1_900_000_000 },
      model_scoped: [{ utilization: 3, resets_at: null }, 'Fable', { display_name: '', utilization: 3 }, { display_name: 'Haiku', utilization: 100 }],
    } } } }));

    expect(reading).toMatchObject({ kind: 'limits', buckets: [
      { id: 'claude', windows: [
        { slot: 'primary', usedPercent: 0, durationMinutes: 300, resetsAt: '2096-01-01T00:00:00.000Z' },
        // An offset is kept as the instant it names.
        { slot: 'secondary', usedPercent: null, durationMinutes: 10080, resetsAt: '2096-01-08T05:00:00.000Z' },
      ] },
      { id: 'model:Haiku', name: 'Haiku', windows: [{ usedPercent: 100, resetsAt: null }] },
    ] });
  });

  it('keeps the account bucket first even with none of its own windows, so a scoped share is never worded as the account\'s', async () => {
    const monitor = new AccountLimitMonitor({ collectors: [collector({ get_usage: { success: { ...LIVE_USAGE, rate_limits: {
      five_hour: null,
      model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: null }],
    } } } })] });
    monitor.refresh();
    await vi.waitFor(() => expect(monitor.snapshots()[0].status).toBe('fresh'));

    expect(accountLimitsText(monitor.snapshots()[0])).toBe('Claude Code Fable Weekly 12% used');
    monitor.dispose();
  });

  it('reports a login whose plan limits do not apply as unsupported, never as an account with nothing used', async () => {
    const reading = await read(collector({
      initialize: { success: { account: { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' } } },
      get_usage: { success: { ...LIVE_USAGE, subscription_type: null, rate_limits_available: false, rate_limits: null } },
    }));

    expect(reading).toEqual({ kind: 'unsupported' });
  });

  it('reports a CLI without get_usage as unsupported, and any other refusal as a failure of the account it saw', async () => {
    expect(await read(collector({ get_usage: { error: 'Unsupported control request subtype: get_usage' } }))).toEqual({ kind: 'unsupported' });

    const failed = await read(collector({ get_usage: { error: 'Failed to fetch usage: 503' } }));
    const fresh = await read(collector({}));
    expect(failed).toEqual({ kind: 'failed', owner: expect.any(String) });
    expect(fresh.kind === 'limits' && fresh.owner).toBe(failed.kind === 'failed' && failed.owner);
  });

  it('reports a CLI that refuses one of the probe\'s flags as unsupported', async () => {
    const reading = await read(collector({ refuse: "error: unknown option '--safe-mode'\n" }));

    expect(reading).toEqual({ kind: 'unsupported' });
  });

  it('fails a read whose answer has no usable rate limits, or a shape it cannot read, rather than show an empty account', async () => {
    expect(await read(collector({ get_usage: { success: { ...LIVE_USAGE, rate_limits: null } } }))).toEqual({ kind: 'failed', owner: expect.any(String) });
    expect(await read(collector({ get_usage: { success: { ...LIVE_USAGE, rate_limits_available: 'yes' } } }))).toEqual({ kind: 'failed', owner: expect.any(String) });
    expect(await read(collector({ get_usage: { success: null } }))).toEqual({ kind: 'failed', owner: expect.any(String) });
  });

  it('takes only the answer under its own request id', async () => {
    const reading = await read(collector({ get_usage: { raw: (id) => [
      { type: 'control_response', response: { subtype: 'success', request_id: `${id}-other`, response: { ...LIVE_USAGE, rate_limits: { five_hour: { utilization: 99, resets_at: null } } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: id, response: LIVE_USAGE } },
    ] } }));

    expect(reading.kind === 'limits' && reading.buckets[0].windows[0].usedPercent).toBe(37);
  });

  it('gives up on an initialize that never answers, without asking for usage, and takes the process down', async () => {
    const reading = await read(collector({ initialize: 'hang' }, 50));

    expect(reading).toEqual({ kind: 'failed' });
    expect(writes(spawned[0].proc).map((w) => w.request?.subtype)).toEqual(['initialize']);
    await vi.waitFor(() => expect(spawned[0].proc.killed).toBe(true));
  });

  it('gives up on a get_usage that never answers as a failure of the account initialize named', async () => {
    const reading = await read(collector({ get_usage: 'hang' }, 50));

    expect(reading).toEqual({ kind: 'failed', owner: expect.any(String) });
    await vi.waitFor(() => expect(spawned[0].proc.killed).toBe(true));
  });

  it('ends a read the monitor aborts at once, takes the process down and asks it nothing more', async () => {
    const controller = new AbortController();
    const pending = read(collector({ get_usage: 'hang' }, 60_000), controller.signal);
    await vi.waitFor(() => expect(spawned[0]?.proc.written.length).toBe(2));
    controller.abort();

    expect(await pending).toEqual({ kind: 'failed', owner: expect.any(String) });
    expect(spawned[0].proc.killed).toBe(true);
    expect(spawned[0].proc.written).toHaveLength(2);
  });

  it('spawns nothing for a Claude Code that is not installed', async () => {
    const c = claudeAccountLimitCollector({ isInstalled: async () => false, deps: fakeClaude({}) });

    expect(await read(c)).toEqual({ kind: 'not_installed' });
    expect(spawned).toHaveLength(0);
  });

  it('tells accounts apart by who initialize names, never by plan, and gives an unnamed login a key no other read matches', async () => {
    const owner = async (account: unknown) => {
      const r = await read(collector({ initialize: { success: { account } } }));
      return r.kind === 'limits' ? r.owner : undefined;
    };
    const first = await owner(SIGNED_IN);
    expect(await owner({ ...SIGNED_IN, subscriptionType: undefined })).toBe(first);
    expect(await owner({ ...SIGNED_IN, email: 'other@example.com' })).not.toBe(first);
    expect(await owner({ ...SIGNED_IN, organization: 'Other Org' })).not.toBe(first);
    const unnamed = await owner({ subscriptionType: 'Claude Max' });
    expect(unnamed).toEqual(expect.any(String));
    expect(await owner({ subscriptionType: 'Claude Max' })).not.toBe(unnamed);
  });
});

describe('Claude Code account limits through the monitor', () => {
  it('drops the old account\'s read when a new one fails, and shows the plan the new one reports, never the old one\'s', async () => {
    let script: Script = {};
    let clock = Date.parse('2026-03-02T10:00:00Z');
    const monitor = new AccountLimitMonitor({ collectors: [collector(() => script)], now: () => clock });
    const again = async (next: Script, count: number) => {
      script = next;
      clock += 11_000;
      monitor.refresh();
      await vi.waitFor(() => expect(spawned).toHaveLength(count));
    };

    monitor.refresh();
    await vi.waitFor(() => expect(monitor.snapshots()[0]).toMatchObject({ harness: 'claude-code', label: 'Claude Code', status: 'fresh', plan: 'max' }));

    const second = { success: { account: { ...SIGNED_IN, email: 'second@example.com', subscriptionType: undefined } } };
    await again({ initialize: second, get_usage: { error: 'Failed to fetch usage: 503' } }, 2);
    await vi.waitFor(() => expect(monitor.snapshots()[0]).toMatchObject({ status: 'unknown', buckets: [] }));

    await again({ initialize: second, get_usage: { success: { ...LIVE_USAGE, subscription_type: null } } }, 3);
    await vi.waitFor(() => expect(monitor.snapshots()[0].status).toBe('fresh'));
    expect(monitor.snapshots()[0].plan).toBeUndefined();
    monitor.dispose();
  });

  it('keeps the same account\'s last read, marked stale, when a later read of it fails', async () => {
    let script: Script = {};
    let clock = Date.parse('2026-03-02T10:00:00Z');
    const monitor = new AccountLimitMonitor({ collectors: [collector(() => script)], now: () => clock });
    monitor.refresh();
    await vi.waitFor(() => expect(monitor.snapshots()[0].status).toBe('fresh'));

    script = { get_usage: 'hang' };
    clock += 11_000;
    monitor.refresh();
    await vi.waitFor(() => expect(monitor.snapshots()[0].status).toBe('stale'), { timeout: 15_000 });
    expect(accountLimitsText(monitor.snapshots()[0])).toBe('Claude Code 5h 37% used · Weekly 44% used · Fable Weekly 0% used (stale)');
    monitor.dispose();
  });

  it('reads the account the workspace\'s own environment chooses, as the planner and its tasks run under', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-claude-workspace-'));
    try {
      mkdirSync(join(workspace, '.ordewell'));
      writeFileSync(join(workspace, '.ordewell', 'env'), 'CLAUDE_CONFIG_DIR=/accounts/work-claude\n');
      const c = claudeAccountLimitCollector({ isInstalled: async () => true, timeoutMs: 2000, deps: fakeClaude({}), workspaceRoot: () => workspace });

      expect((await read(c)).kind).toBe('limits');
      expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe('/accounts/work-claude');
      // Still an empty directory of its own, not the workspace: no project settings or CLAUDE.md.
      expect(spawned[0].cwd.startsWith(tmpdir())).toBe(true);
      expect(spawned[0].cwd.startsWith(workspace)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('scopes what it read to the Claude config directory the probe inherits', () => {
    const c = collector({});
    const before = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = '/one';
      const one = c.scope();
      process.env.CLAUDE_CONFIG_DIR = '/two';
      expect(c.scope()).not.toBe(one);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
});
