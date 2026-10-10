import { describe, it, expect, afterEach, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../ClaudeCodeAdapter';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import { CodexAdapter } from '../CodexAdapter';
import type { AgentAdapter, AgentEvent, AgentProcessDeps, TaskStartOptions } from '../AgentAdapter';
import { fakeSpawn } from '../../__tests__/harnessTestKit';
import { OPENCODE_PLANNER_PERMISSION } from '../openCodeOrdewell';

/**
 * What the harness adapters owe the runner process they start, whatever its
 * protocol: a write racing its death must not take the host down with it,
 * and the host's own debugging and nesting variables stay with the host.
 */

/** Just enough of `opencode serve` for a planner session to start. */
const serveFetch = (async (input: unknown, init?: RequestInit) => {
  if (init?.method !== 'POST' || !String(input).endsWith('/session')) throw new Error(`unrouted request: ${String(input)}`);
  return { ok: true, status: 200, json: async () => ({ id: 'ses_1' }) } as unknown as Response;
}) as unknown as typeof fetch;

function deps(spawned: ReturnType<typeof fakeSpawn>, workspace: Record<string, string> = {}, envs: NodeJS.ProcessEnv[] = []): AgentProcessDeps {
  return {
    spawn: (command, args, options) => { envs.push(options.env); return spawned.spawn(command, args, options); },
    fetch: serveFetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => workspace,
  };
}

async function startOpenCode(spawned: ReturnType<typeof fakeSpawn>, processDeps = deps(spawned)): Promise<OpenCodeAdapter> {
  const adapter = new OpenCodeAdapter(processDeps);
  const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' });
  for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
  spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
  await started;
  return adapter;
}

const taskStart: TaskStartOptions = { kind: 'task', cwd: '/repo', mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} } };

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('a write to a dying runner', () => {
  it('does not throw from the stdio adapter\'s stdin', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    await adapter.start(taskStart);
    expect(() => spawned.processes[0].stdin!.emit('error', epipe())).not.toThrow();
    adapter.dispose();
  });

  it('does not throw from the OpenCode server\'s stdin', async () => {
    const spawned = fakeSpawn([]);
    const adapter = await startOpenCode(spawned);
    expect(() => spawned.processes[0].stdin!.emit('error', epipe())).not.toThrow();
    adapter.dispose();
  });
});

describe('the environment a runner starts under', () => {
  const HOST_ONLY = ['CLAUDECODE', 'NODE_OPTIONS', 'NODE_INSPECT', 'NODE_DEBUG'];

  afterEach(() => { vi.unstubAllEnvs(); });

  function hostLaunchedFromClaudeCode(): void {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('NODE_OPTIONS', '--inspect');
    vi.stubEnv('NODE_INSPECT', '1');
    vi.stubEnv('NODE_DEBUG', 'net');
    vi.stubEnv('ORDEWELL_TEST_KEPT', 'yes');
  }

  const adapters: Array<[string, (spawned: ReturnType<typeof fakeSpawn>, processDeps: AgentProcessDeps) => Promise<AgentAdapter>]> = [
    ['the stdio adapter', async (_spawned, processDeps) => {
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart);
      return adapter;
    }],
    ['the OpenCode adapter', startOpenCode],
  ];

  it.each(adapters)('%s leaves the host\'s nesting and debugging variables behind', async (_label, start) => {
    hostLaunchedFromClaudeCode();
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const adapter = await start(spawned, deps(spawned, {}, envs));
    for (const name of HOST_ONLY) expect(envs[0]).not.toHaveProperty(name);
    expect(envs[0].ORDEWELL_TEST_KEPT).toBe('yes');
    adapter.dispose();
  });

  it.each(adapters)('%s leaves a parent Ordewell\'s MCP tokens behind, under any spelling', async (_label, start) => {
    vi.stubEnv('ORDEWELL_MCP_TOKEN_0', 'Bearer parent-synthetic-0');
    vi.stubEnv('Ordewell_Mcp_Token_3', 'Bearer parent-synthetic-3');
    vi.stubEnv('ORDEWELL_TEST_KEPT', 'yes');
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const adapter = await start(spawned, deps(spawned, {}, envs));
    expect(Object.keys(envs[0]).filter((name) => name.toUpperCase().startsWith('ORDEWELL_MCP_TOKEN_'))).toEqual([]);
    expect(envs[0].ORDEWELL_TEST_KEPT).toBe('yes');
    expect(envs[0].PATH).toBe('/usr/bin');
    adapter.dispose();
  });

  it.each(adapters)('%s leaves a parent Ordewell\'s OpenCode server behind, from the host and the workspace alike', async (label, start) => {
    const parent = { type: 'remote', url: 'http://127.0.0.1:4999/mcp', headers: { Authorization: 'Bearer parent-synthetic' } };
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ model: 'host/model', mcp: { ordewell: parent }, permission: { 'ordewell_*': 'allow' } }));
    const workspace = { Opencode_Config_Content: JSON.stringify({ model: 'workspace/model', mcp: { ordewell: parent, other: { type: 'local', command: ['x'] } } }) };
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const adapter = await start(spawned, deps(spawned, workspace, envs));
    expect(Object.values(envs[0]).some((value) => value?.includes('parent-synthetic'))).toBe(false);
    // The OpenCode planner's server carries Ordewell's own permission policy in place of any it inherited (ADR-0026).
    const planner = label === 'the OpenCode adapter' ? { permission: OPENCODE_PLANNER_PERMISSION } : {};
    expect(JSON.parse(envs[0].OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({ model: 'host/model', ...planner });
    expect(JSON.parse(envs[0].Opencode_Config_Content ?? 'null')).toEqual({ model: 'workspace/model', mcp: { other: { type: 'local', command: ['x'] } } });
    adapter.dispose();
  });

  it.each(adapters)('%s starts its runner as the leader of a process group, so Stop reaches what it starts', async (_label, start) => {
    const spawned = fakeSpawn([]);
    const detached: Array<boolean | undefined> = [];
    const processDeps = deps(spawned);
    const adapter = await start(spawned, { ...processDeps, spawn: (command, args, options) => { detached.push(options.detached); return processDeps.spawn(command, args, options); } });
    expect(detached).toEqual([true]);
    adapter.dispose();
  });

  it.each(adapters)('%s still passes one the workspace sets on purpose (ADR-0016)', async (_label, start) => {
    hostLaunchedFromClaudeCode();
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const adapter = await start(spawned, deps(spawned, { NODE_OPTIONS: '--max-old-space-size=8192' }, envs));
    expect(envs[0].NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(envs[0]).not.toHaveProperty('CLAUDECODE');
    adapter.dispose();
  });
});

describe('a runner that fails to start', () => {
  afterEach(() => { vi.useRealTimers(); });

  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await Promise.resolve();
    if (!condition()) throw new Error('condition never held');
  };

  // Nobody holds an adapter whose start threw — neither caller assigns it —
  // so a process it left running would be orphaned for the host's lifetime.
  it('takes the Codex app-server down with a rejected initialize, reporting the rejection unchanged', async () => {
    const spawned = fakeSpawn([`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unsupported client' } })}\n`]);
    const adapter = new CodexAdapter(deps(spawned));

    await expect(adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' }))
      .rejects.toThrow(/^The Codex app-server rejected initialize: unsupported client$/);
    expect(spawned.processes[0].killed).toBe(true);
  });

  it('takes the Codex app-server down when its handshake times out, with its stderr in the message', async () => {
    vi.useFakeTimers();
    const spawned = fakeSpawn([]);
    const adapter = new CodexAdapter(deps(spawned));
    const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' });
    const rejected = expect(started).rejects.toThrow(/did not complete its handshake[\s\S]*exited with code unknown\.\n\nstill loading/);
    await until(() => (spawned.processes[0]?.written.length ?? 0) > 0);
    spawned.processes[0].emitStderr('still loading');

    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(spawned.processes[0].killed).toBe(true);
  });

  it('takes the OpenCode server down when it never prints where it listens', async () => {
    vi.useFakeTimers();
    const spawned = fakeSpawn([]);
    const adapter = new OpenCodeAdapter(deps(spawned));
    const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' });
    const rejected = expect(started).rejects.toThrow(/^The OpenCode planner server did not start\.$/);
    await until(() => spawned.processes.length > 0);

    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(spawned.processes[0].killed).toBe(true);
    // Given up on, the scanner is detached rather than buffering the server's output for good.
    expect(spawned.processes[0].stdout!.listenerCount('data')).toBe(0);
  });

  it('takes the OpenCode server down when it hands back no session', async () => {
    const spawned = fakeSpawn([]);
    const processDeps = { ...deps(spawned), fetch: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch };

    await expect(startOpenCode(spawned, processDeps)).rejects.toThrow('The OpenCode planner server did not return a session id.');
    expect(spawned.processes[0].killed).toBe(true);
  });
});

describe('the OpenCode server banner', () => {
  it('takes the address from stdout, not from a URL in a stderr warning', async () => {
    const spawned = fakeSpawn([]);
    const urls: string[] = [];
    const processDeps = { ...deps(spawned), fetch: ((input: unknown, init?: RequestInit) => { urls.push(String(input)); return serveFetch(input as string, init); }) as unknown as typeof fetch };
    const adapter = new OpenCodeAdapter(processDeps);
    const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' });
    for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();

    spawned.processes[0].emitStderr('Warning: could not reach https://models.dev/api.json\n');
    spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
    await started;

    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:4096\//);
    adapter.dispose();
  });

  it('stops scanning once the address is known', async () => {
    const spawned = fakeSpawn([]);
    const adapter = await startOpenCode(spawned);
    expect(spawned.processes[0].stdout!.listenerCount('data')).toBe(0);
    adapter.dispose();
  });
});

describe('a runner\'s output split mid-character', () => {
  /** `text` as bytes, cut inside its first multibyte character after `after`. */
  function splitInside(text: string, after: string): [Buffer, Buffer] {
    const bytes = Buffer.from(text);
    const cut = Buffer.byteLength(text.slice(0, text.indexOf(after) + after.length)) + 1;
    return [bytes.subarray(0, cut), bytes.subarray(cut)];
  }

  it('reaches the stdio adapter\'s protocol whole', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    await adapter.start(taskStart);
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (event) => events.push(event));
    await Promise.resolve();

    const assistant = `${JSON.stringify({ type: 'assistant', session_id: 's1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'déjà 日本' }] } })}\n`;
    for (const part of splitInside(assistant, 'déjà ')) spawned.processes[0].stdout!.emit('data', part);
    spawned.processes[0].emitStdout(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', is_error: false, result: 'déjà 日本' })}\n`);
    await turn;

    const text = events.filter((e) => e.type === 'assistant_text').map((e) => (e as { text: string }).text).join('');
    expect(text).toContain('déjà 日本');
    expect(text).not.toContain('�');
    adapter.dispose();
  });

  it('reaches the stdio adapter\'s failure message whole', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    await adapter.start(taskStart);
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (event) => events.push(event));
    await Promise.resolve();

    for (const part of splitInside('Fehler: Schlüssel ungültig\n', 'Schl')) spawned.processes[0].stderr!.emit('data', part);
    spawned.processes[0].exit(1);
    await turn;

    expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('Fehler: Schlüssel ungültig') });
  });
});
