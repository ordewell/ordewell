import { readFileSync } from 'fs';
import type { AgentProcessDeps, SpawnFn } from '../harness/AgentAdapter';
import { fakeSpawn, fixture, respondingSpawn, sseResponse, type FakeEventStream, type FakeSpawnResult } from './harnessTestKit';

/**
 * One fake per built-in runner, each speaking that runner's own protocol, so a
 * contract can be checked against every connector the same way (ADR-0022).
 * Each fake models what the runner itself does with what it was launched with
 * — which tools it lets run unasked, how it reports a tool call or asks a
 * permission — and records how the adapter answered it.
 */

/** How the adapter answered a request the runner raised; `open` means it was left for a person. */
export type RunnerAnswer = 'allow' | 'deny' | 'open';

export interface FakeRunnerScript {
  /** What the runner reports for the Ordewell server's connection. */
  attach: 'connected' | 'failed';
  /** What the runner says to each message and then ends its turn. Absent: every turn stays open for the scenario to drive. */
  reply?: string;
}

export interface FakeRunner {
  deps: AgentProcessDeps;
  /** Every process launched, oldest first. */
  launches(): number;
  /** The Ordewell server URL launch `n` (default: the latest) was given, read where the runner reads it; null when none. */
  injectedUrl(n?: number): string | null;
  /** The argv of the latest launch, as one string — which every local user can list, so a token must never be in it (ADR-0022, A5). */
  commandLine(): string;
  /** Whether the latest launch lets the tool the runner calls `name` run with nobody asked. */
  preAllows(name: string): boolean;
  /** What the latest launch tells the model about its tools besides the tool list, if anything. */
  instructions(): string;
  /** Resolves once the turn the adapter just sent is open on the runner's side. */
  turnOpen(): Promise<void>;
  /** The runner reports calling the Ordewell tool `tool`, in its own words for it. */
  callOrdewellTool(tool: string): void;
  /** The runner asks permission to call the Ordewell tool `tool`. */
  askOrdewellTool(tool: string): Promise<RunnerAnswer>;
  /** The runner asks permission to write a file or run a command. */
  askWrite(): Promise<RunnerAnswer>;
  /** The runner says `text` in the open turn. */
  say(text: string): void;
  /** Whether launch `n` was killed. */
  killed(n: number): boolean;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function answered<T>(read: () => T | undefined): Promise<T | undefined> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await tick();
  }
  return undefined;
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function baseDeps(spawn: SpawnFn, fetch: typeof globalThis.fetch): AgentProcessDeps {
  return {
    spawn,
    fetch,
    resolvePath: async () => '/usr/bin',
    // Pinned, not inherited: Codex's sandbox probe is Linux-only.
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
}

const noHttp = (async () => { throw new Error('no HTTP for this runner'); }) as unknown as typeof fetch;

function claudeCode(script: FakeRunnerScript): FakeRunner {
  const answers = new Map<string, string>();
  const argvs: string[][] = [];
  let asks = 0;
  const serverOf = (args: string[]): { url: string } | null => {
    const at = args.indexOf('--mcp-config');
    if (at < 0) return null;
    return (JSON.parse(readFileSync(args[at + 1], 'utf8')) as { mcpServers: Record<string, { url: string }> }).mcpServers.ordewell ?? null;
  };
  // Read at spawn: the file is removed with the process that read it.
  const urls: (string | null)[] = [];
  const spawned: FakeSpawnResult = respondingSpawn((written, proc, args) => {
    const msg = JSON.parse(written) as {
      type: string;
      request_id?: string;
      request?: { subtype?: string };
      response?: { request_id?: string; response?: { behavior?: string } };
    };
    if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
      const mcpServers = args.includes('--mcp-config') ? [{ name: 'ordewell', status: script.attach }] : [];
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers } } }));
    } else if (msg.type === 'control_response' && msg.response?.request_id) {
      answers.set(msg.response.request_id, msg.response.response?.behavior ?? '');
    } else if (msg.type === 'user' && script.reply !== undefined) {
      const permissionMode = args[args.indexOf('--permission-mode') + 1];
      proc.emitStdout(line({ type: 'system', subtype: 'init', session_id: 'sess-1', permissionMode }));
      proc.emitStdout(line({ type: 'assistant', session_id: 'sess-1', message: { id: 'm-reply', content: [{ type: 'text', text: script.reply }] } }));
      proc.emitStdout(line({ type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false, result: script.reply }));
    }
  });
  const spawn: SpawnFn = (cmd, argv, options) => {
    argvs.push(argv);
    urls.push(serverOf(argv)?.url ?? null);
    return spawned.spawn(cmd, argv, options);
  };
  const proc = () => spawned.processes[spawned.processes.length - 1];
  const ask = async (toolName: string, input: Record<string, unknown>): Promise<RunnerAnswer> => {
    const id = `req-${++asks}`;
    proc().emitStdout(line({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: `tu-${id}` } }));
    const behavior = await answered(() => answers.get(id));
    return behavior === undefined ? 'open' : behavior === 'allow' ? 'allow' : 'deny';
  };
  return {
    deps: baseDeps(spawn, noHttp),
    launches: () => argvs.length,
    injectedUrl: (n = argvs.length - 1) => urls[n] ?? null,
    commandLine: () => spawned.lastArgs().join(' '),
    preAllows: (name) => {
      const args = spawned.lastArgs();
      const at = args.indexOf('--allowedTools');
      return at >= 0 && args[at + 1].split(',').includes(name);
    },
    instructions: () => '',
    turnOpen: async () => { await answered(() => (proc().written.some((w) => w.includes('"type":"user"')) ? true : undefined)); },
    callOrdewellTool: (tool) => {
      proc().emitStdout(line({ type: 'assistant', session_id: 'sess-1', message: { id: `m-${tool}`, content: [{ type: 'tool_use', id: `tu-${tool}`, name: `mcp__ordewell__${tool}`, input: {} }] } }));
    },
    askOrdewellTool: (tool) => ask(`mcp__ordewell__${tool}`, {}),
    askWrite: () => ask('Write', { file_path: '/repo/a.txt', content: 'a' }),
    say: (text) => {
      proc().emitStdout(line({ type: 'assistant', session_id: 'sess-1', message: { id: 'm-say', content: [{ type: 'text', text }] } }));
    },
    killed: (n) => spawned.processes[n]?.killed ?? false,
  };
}

interface RpcLine {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface CodexThreadParams {
  developerInstructions?: string;
  config?: { mcp_servers?: Record<string, { url?: string; default_tools_approval_mode?: string }> };
}

function codex(script: FakeRunnerScript): FakeRunner {
  const threads: CodexThreadParams[] = [];
  const answers = new Map<number, RpcLine>();
  let requests = 100;
  let turns = 0;
  const spawned: FakeSpawnResult = respondingSpawn((written, proc) => {
    const msg = JSON.parse(written) as RpcLine;
    if (msg.method === 'initialize') {
      proc.emitStdout(fixture('codex', 'handshake'));
    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      const params = (msg.params ?? {}) as CodexThreadParams;
      threads[spawned.processes.indexOf(proc)] = params;
      proc.emitStdout(fixture('codex', 'task-thread'));
      if (params.config?.mcp_servers?.ordewell) {
        const status = script.attach === 'connected' ? 'ready' : 'failed';
        proc.emitStdout(line({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated', params: { name: 'ordewell', status } }));
      }
    } else if (msg.method === 'turn/start') {
      const turn = `turn-${++turns}`;
      proc.emitStdout(line({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turn, status: 'inProgress', items: [] } } }));
      proc.emitStdout(line({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-task-1', turn: { id: turn, status: 'inProgress', items: [] } } }));
      if (script.reply === undefined) return;
      proc.emitStdout(line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-task-1', turnId: turn, item: { id: `item-${turn}`, type: 'agentMessage', text: script.reply } } }));
      proc.emitStdout(line({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: turn, status: 'completed', items: [] } } }));
    } else if (!msg.method && typeof msg.id === 'number') {
      answers.set(msg.id, msg);
    }
  });
  const proc = () => spawned.processes[spawned.processes.length - 1];
  const thread = (n = spawned.processes.length - 1) => threads[n];
  const ask = async (method: string, params: Record<string, unknown>, allowed: (answer: RpcLine) => boolean): Promise<RunnerAnswer> => {
    const id = ++requests;
    proc().emitStdout(line({ jsonrpc: '2.0', id, method, params: { threadId: 'thr-task-1', turnId: `turn-${turns}`, ...params } }));
    const answer = await answered(() => answers.get(id));
    return answer === undefined ? 'open' : allowed(answer) ? 'allow' : 'deny';
  };
  return {
    deps: baseDeps(spawned.spawn, noHttp),
    launches: () => spawned.processes.length,
    injectedUrl: (n) => thread(n)?.config?.mcp_servers?.ordewell?.url ?? null,
    commandLine: () => spawned.lastArgs().join(' '),
    // Codex grants by server, and calls that server's tools `mcp__<server>__<tool>`.
    preAllows: (name) => name.startsWith('mcp__ordewell__') && thread()?.config?.mcp_servers?.ordewell?.default_tools_approval_mode === 'approve',
    instructions: () => thread()?.developerInstructions ?? '',
    turnOpen: async () => { await answered(() => (turns > 0 ? true : undefined)); },
    callOrdewellTool: (tool) => {
      proc().emitStdout(line({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thr-task-1', turnId: `turn-${turns}`, item: { id: `mcp-${tool}`, type: 'mcpToolCall', server: 'ordewell', tool, status: 'inProgress', arguments: {} } } }));
    },
    askOrdewellTool: (tool) => ask(
      'mcpServer/elicitation/request',
      { serverName: 'ordewell', mode: 'form', message: `Allow ordewell to run ${tool}?`, requestedSchema: { type: 'object', properties: {} } },
      (answer) => answer.result?.action === 'accept',
    ),
    askWrite: () => ask(
      'item/commandExecution/requestApproval',
      { itemId: 'item-c', startedAtMs: 1, command: 'rm -rf src', cwd: '/repo' },
      (answer) => answer.result?.decision === 'accept' || answer.result?.decision === 'acceptForSession',
    ),
    say: (text) => {
      proc().emitStdout(line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-task-1', turnId: `turn-${turns}`, item: { id: 'item-say', type: 'agentMessage', text } } }));
    },
    killed: (n) => spawned.processes[n]?.killed ?? false,
  };
}

const OPENCODE_BASE = 'http://127.0.0.1:4096';
const SES = 'ses_fake';

function respond(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  } as unknown as Response;
}

function openCode(script: FakeRunnerScript): FakeRunner {
  const spawned = fakeSpawn([]);
  const envs: NodeJS.ProcessEnv[] = [];
  const streams: FakeEventStream[] = [];
  const replies = new Map<string, string>();
  let asks = 0;
  let turns = 0;
  const spawn: SpawnFn = (cmd, argv, options) => {
    envs.push(options.env ?? {});
    const proc = spawned.spawn(cmd, argv, options);
    queueMicrotask(() => spawned.processes[spawned.processes.length - 1].emitStdout(`opencode server listening on ${OPENCODE_BASE}\n`));
    return proc;
  };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace(OPENCODE_BASE, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (path === '/event') {
      const { response, stream } = sseResponse(init);
      streams.push(stream);
      return response;
    }
    // A 1.x server: no `/api/info`.
    if (path === '/api/info') return respond(404);
    if (method === 'POST' && path === '/session') return respond(200, { id: SES });
    if (path === '/mcp') return respond(200, { ordewell: { status: script.attach } });
    const permission = path.match(/^\/permission\/([^/]+)\/reply$/);
    if (permission) {
      replies.set(permission[1], String(body?.reply));
      return respond(200, true);
    }
    if (method === 'POST' && path === `/session/${SES}/message`) {
      // A planner's turn is this request; with nothing scripted it stays open, as a working server's does.
      if (script.reply === undefined) return new Promise<Response>(() => undefined);
      return respond(200, { info: { id: 'msg_reply', role: 'assistant', sessionID: SES }, parts: [{ id: 'prt_reply', messageID: 'msg_reply', type: 'text', text: script.reply }] });
    }
    if (path.endsWith('/prompt_async')) return respond(204);
    if (path === '/session/status') return respond(200, {});
    if (method === 'GET' && path.endsWith('/message')) return respond(200, []);
    return respond(200, true);
  }) as unknown as typeof fetch;
  const configOf = (n = envs.length - 1): { mcp?: Record<string, { url?: string }>; permission?: Record<string, unknown> } | null => {
    const content = envs[n]?.OPENCODE_CONFIG_CONTENT;
    return content ? JSON.parse(content) as { mcp?: Record<string, { url?: string }>; permission?: Record<string, unknown> } : null;
  };
  const stream = () => streams[streams.length - 1];
  const frame = (type: string, properties: Record<string, unknown>) => stream().push({ type, properties: { sessionID: SES, ...properties } });
  const ask = async (permission: string): Promise<RunnerAnswer> => {
    const id = `per_${++asks}`;
    frame('permission.asked', { id, permission, patterns: ['*'], metadata: {} });
    const reply = await answered(() => replies.get(id));
    return reply === undefined ? 'open' : reply === 'reject' ? 'deny' : 'allow';
  };
  return {
    deps: baseDeps(spawn, fetchImpl),
    launches: () => envs.length,
    injectedUrl: (n) => configOf(n)?.mcp?.ordewell?.url ?? null,
    commandLine: () => spawned.lastArgs().join(' '),
    // OpenCode's permission rules, as it matches them: a trailing `*` is a prefix.
    preAllows: (name) => Object.entries(configOf()?.permission ?? {}).some(([rule, action]) =>
      action === 'allow' && (rule === name || (rule.endsWith('*') && name.startsWith(rule.slice(0, -1))))),
    instructions: () => '',
    turnOpen: async () => {
      // One `/event` connection per turn.
      await answered(() => (streams.length > turns ? true : undefined));
      turns = streams.length;
      frame('session.status', { status: { type: 'busy' } });
      frame('message.updated', { info: { id: 'msg_turn', role: 'assistant', sessionID: SES } });
    },
    callOrdewellTool: (tool) => {
      frame('message.part.updated', { part: { id: `prt_${tool}`, messageID: 'msg_turn', sessionID: SES, callID: `call_${tool}`, type: 'tool', tool: `ordewell_${tool}`, state: { status: 'running', input: { from: 'fake' } } } });
    },
    askOrdewellTool: (tool) => ask(`ordewell_${tool}`),
    askWrite: () => ask('edit'),
    say: (text) => {
      frame('message.part.updated', { part: { id: 'prt_say', messageID: 'msg_turn', sessionID: SES, type: 'text', text, time: { start: 1, end: 2 } } });
    },
    killed: (n) => spawned.processes[n]?.killed ?? false,
  };
}

/** A fake for every built-in runner, by runner id. */
export const FAKE_RUNNERS: Record<string, (script: FakeRunnerScript) => FakeRunner> = {
  'claude-code': claudeCode,
  codex,
  opencode: openCode,
};
