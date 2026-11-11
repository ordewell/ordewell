import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import { confinedRead, CONFINED_RESEARCH_TOOLS } from '../ResearchSubagents';
import { NO_TURN_OPEN } from '../harness/harnessResearchAgent';
import type { AgentProcessDeps } from '../harness/AgentAdapter';
import {
  lazyServe, loginResearchAgent, openCodeResearchAgent, openCodeVersion, researchSessionRules, researchToolNames, startResearchServe, type ResearchServe,
} from '../harness/openCodeResearchAgent';

/*
 * The login-backed research agent (ADR-0066) against a fake OpenCode 2.x
 * serve that applies v2.2.7's tool-snapshot rule. What the fake cannot
 * settle — the real snapshot, a real model, the real login — is the live
 * probe's (bench/live/opencode-login-research-agent-probe.mjs).
 */
const FAKE = resolve(__dirname, '../../../../../bench/pipeline/fake-opencode/fake-opencode-v2.mjs');
const cue = (spec: unknown) => `Research this. <fake-opencode>${JSON.stringify(spec)}</fake-opencode>`;

function fakeFs(): { fs: IFileSystem; touched: string[] } {
  const touched: string[] = [];
  const ok = (name: string) => async (...args: unknown[]) => {
    touched.push(`${name}:${JSON.stringify(args[0])}`);
    return { success: true, output: `${name} output`, truncated: false };
  };
  return {
    touched,
    fs: {
      readFile: ok('readFile'), readFiles: ok('readFiles'), glob: ok('glob'), grep: ok('grep'),
      findSymbol: ok('findSymbol'), listDir: ok('listDir'), bash: ok('bash'),
      getWorkspaceRoot: () => '/ws',
    },
  };
}

async function rpc(url: string, token: string, method: string, params: unknown): Promise<{ result?: { tools: { name: string }[]; content?: { text?: string }[] }; error?: { message: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}

/** How the serve is launched: the fake, under `workspace` as the workspace's own variables, each child kept. */
function launchWith(workspace: Record<string, string>, children: ChildProcess[] = []): AgentProcessDeps {
  return {
    spawn: (command, args, options) => { const child = nodeSpawn(command, args, options); children.push(child); return child; },
    fetch: globalThis.fetch,
    workspaceEnv: async () => workspace,
  };
}

describe('the research serve and its agent', () => {
  let mcp: OrdewellMcpServer;
  let scratch: string;
  let token: string;
  let url: string;
  let files: ReturnType<typeof fakeFs>;
  let serves: ReturnType<typeof lazyServe>;
  let serve: ResearchServe;
  let events: ResearchProgress[];
  let turnOpen = true;
  const sink = () => (turnOpen ? (p: ResearchProgress) => { events.push(p); } : undefined);

  beforeAll(async () => {
    mcp = new OrdewellMcpServer({ heartbeatMs: 60_000 });
    files = fakeFs();
    const credential = await mcp.issueResearchToken({ sessionId: 'planner-1' }, {
      read: async (name, args, { signal }) => {
        const out = await confinedRead(name, args, files.fs, signal);
        return { text: out.output, isError: !out.success };
      },
    });
    token = credential.token;
    url = credential.url;
    scratch = mkdtempSync(join(tmpdir(), 'oc-research-test-'));
    serves = lazyServe(() => startResearchServe({
      cwd: scratch,
      mcp: { url, token },
      command: process.execPath,
      args: [FAKE],
      launch: launchWith({ HOME: join(scratch, 'user-home'), XDG_DATA_HOME: join(scratch, 'user-data'), OPENCODE_CONFIG: '/user/opencode.json', OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_DB: 'z.db' }),
    }));
    serve = await serves.get();
  }, 30_000);

  afterAll(async () => {
    await serves?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const agent = (extra: Partial<Parameters<typeof openCodeResearchAgent>[0]> = {}) =>
    openCodeResearchAgent({ serve: () => serves.get(), model: 'opencode/planner-model', turnSink: sink, interruptGraceMs: 2_000, ...extra });
  const fresh = () => { events = []; turnOpen = true; };

  it('offers the session the six ordewell reads and nothing else: every built-in, skill, subagent, execute and opencode_* tool is dropped', async () => {
    const created = await serve.json<{ data: { id: string } }>('POST', '/api/session', { agent: 'plan', permissions: researchSessionRules() });
    const { tools } = await serve.json<{ tools: string[] }>('GET', `/api/fake/offered/${created.data.id}`);
    expect([...tools].sort()).toEqual(researchToolNames().sort());
    expect(researchToolNames()).toHaveLength(CONFINED_RESEARCH_TOOLS.size);
  });

  it('starts the serve with a throwaway config, home and state, the user\'s data directory, and no user OPENCODE_* setting but where the login is', async () => {
    const env = await serve.json<{ home: string; xdgData: string; xdgCache: string; xdgConfig: string; configDir: string; noProject: string; openCodeKeys: string[]; config: { mcp: Record<string, unknown>; permissions: unknown[] } }>('GET', '/api/fake/env');
    expect(env.xdgData).toBe(join(scratch, 'user-data'));
    expect(env.xdgCache).toBe(process.env.XDG_CACHE_HOME || join(scratch, 'user-home', '.cache'));
    expect(env.home.startsWith(join(tmpdir(), 'ordewell-research-'))).toBe(true);
    expect(env.xdgConfig.startsWith(join(tmpdir(), 'ordewell-research-'))).toBe(true);
    expect(env.configDir.startsWith(join(tmpdir(), 'ordewell-research-'))).toBe(true);
    expect(env.noProject).toBe('1');
    expect(Object.keys(env.config.mcp)).toEqual(['ordewell']);
    expect(env.config.permissions).toEqual(researchSessionRules());
    expect(env.openCodeKeys).toEqual(['OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DB', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']);
  });

  it('runs a brief to a digest within the call, with its steps on the timeline and its usage under its subagent id on the planner\'s model', async () => {
    fresh();
    const run = agent({ newId: () => 'sub-1' });
    const reply = await run({ prompt: cue({ steps: [{ calls: [{ name: 'ordewell_read_file', args: { path: 'src/a.ts' } }, { name: 'ordewell_grep', args: { pattern: 'x' } }] }], text: 'a.ts:1 holds x', usage: { input: 100, output: 20 } }) }, { signal: new AbortController().signal });
    expect(reply).toEqual({ text: 'a.ts:1 holds x' });
    expect(files.touched).toEqual(expect.arrayContaining(['readFile:"src/a.ts"', 'grep:"x"']));
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.tool)).toEqual(['read_file', 'grep']);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.length).toBe(2);
    for (const u of usage) expect(u.record?.subagentId).toBe('sub-1');
    expect(events.at(-1)).toMatchObject({ type: 'subagent_finished', outcome: 'done', subagentId: 'sub-1' });
    expect(events[0]).toMatchObject({ type: 'subagent_started', model: 'opencode/planner-model' });
  });

  it.each([
    ['bash'], ['write'], ['execute'], ['read'], ['skill'], ['subagent'], ['webfetch'],
    ['opencode_models'], ['opencode_session_rename'], ['opencode_worktree_list'], ['ordewell_run_command'], ['ordewell_spawn_research_agent'],
  ])('fails closed when a brief gets the model to call %s: nothing runs and no digest is used', async (tool) => {
    fresh();
    const before = (await serve.json<{ ran: unknown[] }>('GET', '/api/fake/ran')).ran.length;
    const reply = await agent()({ prompt: cue({ steps: [{ calls: [{ name: tool, args: { command: 'cat ~/.local/share/opencode/opencode.db' } }] }], text: 'pwned' }) }, { signal: new AbortController().signal });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(`it called ${tool}`);
    expect((await serve.json<{ ran: unknown[] }>('GET', '/api/fake/ran')).ran.length).toBe(before);
    expect(files.touched.some((t) => t.startsWith('bash'))).toBe(false);
  });

  it('fails closed when a child session of the research session appears', async () => {
    fresh();
    const reply = await agent()({ prompt: cue({ child: true, delayMs: 500, text: 'nested' }) }, { signal: new AbortController().signal });
    expect(reply).toMatchObject({ isError: true });
    expect(reply.text).toContain('started a session of its own');
  });

  it('refuses a read outside the workspace at the token, whatever the runner allows', async () => {
    fresh();
    files.touched.length = 0;
    const reply = await agent()({ prompt: cue({ steps: [{ calls: [{ name: 'ordewell_read_file', args: { path: '/home/u/.local/share/opencode/opencode.db' } }] }], text: 'could not read it' }) }, { signal: new AbortController().signal });
    expect(reply.text).toBe('could not read it');
    expect(files.touched).toEqual([]);
    expect(events.find((e) => e.type === 'tool_result')?.step?.outcome).not.toBe('success');
  });

  it('serves only the six reads on a research token, and names every other Ordewell tool as withheld', async () => {
    const listed = await rpc(url, token, 'tools/list', {});
    expect((listed.result?.tools ?? []).map((t) => t.name).sort()).toEqual([...CONFINED_RESEARCH_TOOLS].sort());
    for (const name of ['run_command', 'fetch', 'web_search', 'spawn_research_agent', 'task_complete', 'post']) {
      const called = await rpc(url, token, 'tools/call', { name, arguments: {} });
      const text = called.error?.message ?? called.result?.content?.[0]?.text ?? '';
      expect(text).toMatch(/disabled on this token: research agents read the workspace only|unknown tool/);
    }
  });

  it('interrupts the session when the planner\'s call is cancelled, and returns at once', async () => {
    fresh();
    const stop = new AbortController();
    const started = Date.now();
    const pending = agent()({ prompt: cue({ delayMs: 20_000, text: 'late' }) }, { signal: stop.signal });
    setTimeout(() => stop.abort(), 300);
    const reply = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reply).toMatchObject({ isError: true, text: '[research agent stopped]' });
    expect(events.at(-1)).toMatchObject({ type: 'subagent_finished', outcome: 'stopped' });
  });

  it('runs at most three at once across calls', async () => {
    fresh();
    let active = 0;
    let peak = 0;
    turnOpen = true;
    const counting = openCodeResearchAgent({
      serve: () => serves.get(), turnSink: () => (p) => {
        if (p.type === 'subagent_started') peak = Math.max(peak, ++active);
        if (p.type === 'subagent_finished') active--;
      },
    });
    const replies = await Promise.all(Array.from({ length: 5 }, (_, i) => counting({ prompt: cue({ delayMs: 300, text: `r${i}` }) }, { signal: new AbortController().signal })));
    expect(replies.map((r) => r.text)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(peak).toBe(3);
  });

  it('when the budget runs out, returns what it wrote marked partial and names what the extra step left unread', async () => {
    fresh();
    const steps = [
      ...Array.from({ length: 10 }, () => ({ calls: [{ name: 'ordewell_list_dir', args: { path: '.' } }] })),
      { calls: [{ name: 'ordewell_read_file', args: { path: 'src/left-over.ts' } }] },
      { calls: [{ name: 'ordewell_list_dir', args: { path: '.' } }] },
    ];
    const reply = await agent({ maxSteps: 10 })({ prompt: cue({ steps, text: 'never' }) }, { signal: new AbortController().signal });
    expect(reply.isError).toBeFalsy();
    expect(reply.text).toMatch(/^\[PARTIAL/);
    expect(reply.text).toContain('10-step budget');
    expect(reply.text).toMatch(/Left unread:[\s\S]*src\/left-over\.ts/);
  });

  it('refuses a call while no turn is open', async () => {
    turnOpen = false;
    expect(await agent()({ prompt: 'x' }, { signal: new AbortController().signal })).toEqual({ text: NO_TURN_OPEN, isError: true });
    turnOpen = true;
  });
});

describe('the login research agent a planner session holds', () => {
  let mcp: OrdewellMcpServer;
  let scratch: string;

  beforeAll(() => {
    mcp = new OrdewellMcpServer({ heartbeatMs: 60_000 });
    scratch = mkdtempSync(join(tmpdir(), 'oc-login-research-test-'));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function login(workspace: Record<string, string> = {}, wrapFetch?: (real: typeof fetch) => typeof fetch) {
    const logs: string[] = [];
    const children: ChildProcess[] = [];
    const events: ResearchProgress[] = [];
    const agent = loginResearchAgent({
      cwd: scratch,
      sessionId: 'planner-login',
      model: 'opencode/planner-model',
      fs: fakeFs().fs,
      turnSink: () => (p) => { events.push(p); },
      mcpServer: mcp,
      launch: (() => {
        const launch = launchWith({ HOME: join(scratch, 'home'), ...workspace }, children);
        return wrapFetch ? { ...launch, fetch: wrapFetch(launch.fetch) } : launch;
      })(),
      command: process.execPath,
      args: [FAKE],
      log: (line) => logs.push(line),
      interruptGraceMs: 2_000,
    });
    const call = (prompt: string) => agent.handler({ prompt }, { signal: new AbortController().signal });
    return { agent, call, logs, children, events };
  }
  const exited = (child: ChildProcess) => new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done());
  });

  it('answers a brief on the planner\'s model, in a session titled for Ordewell', async () => {
    const { agent, call, logs } = login();
    try {
      const reply = await call(cue({ text: 'found it' }));
      expect(reply).toEqual({ text: 'found it' });
      expect(logs).toEqual([]);
    } finally { await agent.close(); }
  });

  it('names the session after the start of its brief, so it reads as Ordewell\'s in OpenCode\'s session list', async () => {
    const children: ChildProcess[] = [];
    const credential = await mcp.issueResearchToken({ sessionId: 'planner-title' }, { read: async () => ({ text: '' }) });
    const serves = lazyServe(() => startResearchServe({ cwd: scratch, mcp: credential, command: process.execPath, args: [FAKE], launch: launchWith({}, children) }));
    try {
      const run = openCodeResearchAgent({ serve: () => serves.get(), turnSink: () => () => undefined });
      await run({ prompt: `Find   where the\nplanner session is discarded and what it closes ${cue({ text: 'ok' })}` }, { signal: new AbortController().signal });
      const { sessions } = await (await serves.get()).json<{ sessions: { title?: string }[] }>('GET', '/api/fake/sessions');
      expect(sessions.map((s) => s.title)).toEqual(['Ordewell research: Find where the planner session is discarded and…']);
    } finally {
      await serves.close();
      mcp.revoke(credential.token);
    }
  });

  it.each([
    ['a permission rule of its own', { FAKE_OPENCODE_EXTRA_RULE: JSON.stringify({ action: 'bash', resource: '*', effect: 'allow' }) }, /permission rules/],
    ['an MCP server besides Ordewell\'s', { FAKE_OPENCODE_EXTRA_MCP: 'github' }, /MCP server.*github/],
    ['a plugin beyond OpenCode\'s built-ins', { FAKE_OPENCODE_EXTRA_PLUGIN: 'opencode-evil' }, /plugin.*opencode-evil/],
  ])('is unavailable when the serve loaded %s: the planner is told to use research tasks, once logged, and the serve is gone', async (_what, workspace, why) => {
    const { agent, call, logs, children } = login(workspace);
    try {
      const reply = await call(cue({ text: 'never' }));
      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(/research task/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(why);
      await Promise.all(children.map(exited));
      expect(await call(cue({ text: 'never' }))).toEqual(reply);
      expect(children).toHaveLength(1);
      expect(logs).toHaveLength(1);
    } finally { await agent.close(); }
  });

  it('is unavailable for the rest of the session when its serve fails to start', async () => {
    const { agent, call, logs, children } = login({ FAKE_OPENCODE_EXIT: '1' });
    try {
      const reply = await call(cue({ text: 'never' }));
      expect(reply).toMatchObject({ isError: true });
      expect(reply.text).toMatch(/research task/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/refusing to start|exited/);
      await call(cue({ text: 'never' }));
      expect(children).toHaveLength(1);
      expect(logs).toHaveLength(1);
    } finally { await agent.close(); }
  });

  it('authenticates every call to its serve as `opencode`, the only user real OpenCode 2.x accepts, whatever OPENCODE_SERVER_USERNAME the host sets', async () => {
    const users = new Set<string>();
    const calls: string[] = [];
    const { agent, call, logs } = login({ OPENCODE_SERVER_USERNAME: 'someone-else' }, (real) => (input, init) => {
      const header = new Headers(init?.headers).get('authorization') ?? '';
      users.add(Buffer.from(header.replace(/^Basic /, ''), 'base64').toString().split(':')[0]);
      calls.push(String(input).replace(/^https?:\/\/[^/]+/, ''));
      return real(input, init);
    });
    try {
      expect(await call(cue({ text: 'found it' }))).toEqual({ text: 'found it' });
      expect(logs).toEqual([]);
      expect([...users]).toEqual(['opencode']);
      expect(calls).toEqual(expect.arrayContaining(['/api/info', '/api/session', '/api/event']));
    } finally { await agent.close(); }
  });

  it('tells the planner the HTTP status and the start of the body when its serve refuses a start-up call', async () => {
    const { agent, call, logs } = login({}, (real) => (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Basic ${Buffer.from('ordewell:wrong').toString('base64')}`);
      return real(input, { ...init, headers });
    });
    try {
      const reply = await call(cue({ text: 'never' }));
      expect(reply.text).toMatch(/research task/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/\/api\/info.*401.*unauthorized/);
      expect(logs[0]).not.toMatch(/no version/);
    } finally { await agent.close(); }
  });

  it('is unavailable when the serve is not OpenCode 2.x', async () => {
    const { agent, call, logs } = login({ FAKE_OPENCODE_VERSION: '1.4.0' });
    try {
      expect((await call(cue({ text: 'never' }))).text).toMatch(/research task/);
      expect(logs[0]).toMatch(/2\.x/);
    } finally { await agent.close(); }
  });

  it.each([['provider.auth'], ['provider.no-route']])('is unavailable for the rest of the session once a call fails with %s, and closes its serve', async (type) => {
    const { agent, call, logs, children } = login();
    try {
      const reply = await call(cue({ fail: { type, message: 'no login for opencode/planner-model' } }));
      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(/research task/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('no login for opencode/planner-model');
      await Promise.all(children.map(exited));
      expect((await call(cue({ text: 'never' }))).text).toBe(reply.text);
      expect(children).toHaveLength(1);
    } finally { await agent.close(); }
  });

  it('stays available after a call fails for any other reason', async () => {
    const { agent, call, logs } = login();
    try {
      expect((await call(cue({ fail: { type: 'provider.rate-limit', message: 'slow down' } }))).text).toContain('slow down');
      expect(await call(cue({ text: 'fine now' }))).toEqual({ text: 'fine now' });
      expect(logs).toEqual([]);
    } finally { await agent.close(); }
  });

  it('closes its serve and revokes its token when closed, and answers nothing after', async () => {
    const { agent, call, children } = login();
    await call(cue({ text: 'ok' }));
    expect(children).toHaveLength(1);
    await agent.close();
    await Promise.all(children.map(exited));
    expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
    expect((await call(cue({ text: 'late' }))).isError).toBe(true);
    expect(children).toHaveLength(1);
  });

  it('starts nothing until it is first called', async () => {
    const { agent, children } = login();
    await agent.close();
    expect(children).toEqual([]);
  });
});

describe('openCodeVersion', () => {
  it('reads the version OpenCode prints, or null when it cannot be run', async () => {
    const cwd = tmpdir();
    expect(await openCodeVersion({ cwd, launch: launchWith({}), command: process.execPath, args: [FAKE] })).toBe('2.2.7');
    expect(await openCodeVersion({ cwd, launch: launchWith({ FAKE_OPENCODE_VERSION: '1.4.0' }), command: process.execPath, args: [FAKE] })).toBe('1.4.0');
    expect(await openCodeVersion({ cwd, launch: launchWith({}), command: join(cwd, 'no-such-opencode') })).toBeNull();
  });
});

let titleBase: string;

interface Frame { type: string; data: { sessionID?: string; source?: string; cost?: number; tokens?: unknown } }

/** Runs one prompt on a fresh session and returns every frame the session produced, up to its end. */
async function framesOf(session: Record<string, unknown>): Promise<Frame[]> {
  const stream = await fetch(`${titleBase}/api/event`);
  const reader = stream.body!.getReader();
  const created = await (await fetch(`${titleBase}/api/session`, { method: 'POST', body: JSON.stringify(session) })).json() as { data: { id: string } };
  const id = created.data.id;
  await fetch(`${titleBase}/api/session/${id}/prompt`, { method: 'POST', body: JSON.stringify({ text: 'Do the work.' }) });
  const frames: Frame[] = [];
  let buffered = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split('\n\n');
    buffered = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const frame = JSON.parse(line.slice(5)) as Frame;
      if (frame.data.sessionID !== id) continue;
      frames.push(frame);
    }
    if (frames.some((f) => f.type === 'session.execution.succeeded')) break;
  }
  await reader.cancel();
  return frames;
}

/*
 * The fake models the one hidden call v2.2.7 makes: an untitled session's
 * first prompt generates a title, whose usage reaches a client only as a
 * `session.usage.recorded` frame. The runner tests lean on it.
 */
describe('the fake OpenCode 2.x serve and its title call', () => {
  let titleChild: ChildProcess;
  beforeAll(async () => {
    titleChild = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'ignore'] });
    titleBase = await new Promise<string>((done, fail) => {
      titleChild.once('error', fail);
      titleChild.stdout!.on('data', (chunk: Buffer) => {
        const m = /listening on (http:\/\/\S+)/.exec(chunk.toString());
        if (m) done(m[1]);
      });
    });
  });
  afterAll(() => { titleChild.kill(); });

  it('reports a title call\'s usage for an untitled session, before the model\'s own work', async () => {
    const frames = await framesOf({});
    const usage = frames.filter((f) => f.type === 'session.usage.recorded');
    expect(usage).toHaveLength(1);
    expect(usage[0].data).toMatchObject({ source: 'title', cost: 0.0004, tokens: { input: 900, output: 12 } });
    expect(frames.findIndex((f) => f.type === 'session.usage.recorded')).toBeLessThan(frames.findIndex((f) => f.type === 'session.step.started'));
  });

  it('makes no title call, and reports none, for a session created with a title', async () => {
    const frames = await framesOf({ title: 'Ordewell task' });
    expect(frames.filter((f) => f.type === 'session.usage.recorded')).toEqual([]);
    expect(frames.some((f) => f.type === 'session.step.ended')).toBe(true);
  });
});
