import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentProcessDeps, AgentStartOptions, SpawnFn } from '../harness/AgentAdapter';
import { FakeAcpAgent, type FakeAcpStep } from './fakeAcpAgent';
import { fakeSpawn, fixture, respondingSpawn, sseResponse, type FakeAgentProcess, type FakeEventStream, type FakeSpawnResult } from './harnessTestKit';

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
  /**
   * Whether the latest launch lets the tool the runner calls `name` run with
   * nobody asked: read from what it was launched with, or for a runner that
   * asks its client about every call (ACP), from how the adapter answers.
   */
  preAllows(name: string): boolean | Promise<boolean>;
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
  /**
   * The start options as the server would hand them out. ACP reports no MCP
   * status, so the attach evidence is the server's own record of the token's
   * first use (ADR-0022, S2), which a fake of such a runner supplies.
   */
  withServer?(start: AgentStartOptions): AgentStartOptions;
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
    } else if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], models: [] } } }));
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
    instructions: () => {
      const args = spawned.lastArgs();
      return args[args.indexOf('--append-system-prompt') + 1] ?? '';
    },
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
      proc.emitStdout(line({ ...(JSON.parse(fixture('codex', 'task-thread')) as RpcLine), id: msg.id }));
      if (params.config?.mcp_servers?.ordewell) {
        const status = script.attach === 'connected' ? 'ready' : 'failed';
        proc.emitStdout(line({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated', params: { name: 'ordewell', status } }));
      }
    } else if (msg.method === 'config/read') {
      proc.emitStdout(line({ jsonrpc: '2.0', id: msg.id, result: { config: { mcp_servers: {} }, origins: {} } }));
    } else if (msg.method === 'skills/list' || msg.method === 'mcpServerStatus/list') {
      proc.emitStdout(line({ jsonrpc: '2.0', id: msg.id, result: { data: [], nextCursor: null } }));
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
  let system = '';
  let prompted = false;
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
    if (path.endsWith('/prompt_async') || path === `/session/${SES}/message`) prompted = true;
    if (typeof body?.system === 'string') system = body.system;
    const permission = path.match(/^\/permission\/([^/]+)\/reply$/);
    if (permission) {
      replies.set(permission[1], String(body?.reply));
      return respond(200, true);
    }
    if (method === 'POST' && path === `/session/${SES}/message`) {
      // A planner's turn is this request; with nothing scripted it stays open, as a working server's does.
      // Held as a real socket is: it ends with an abort, or with the server's death.
      if (script.reply === undefined) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
          spawned.processes[spawned.processes.length - 1]?.once('close', () => reject(new Error('socket hang up')));
        });
      }
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
    instructions: () => system,
    turnOpen: async () => {
      // One `/event` connection per turn.
      await answered(() => (streams.length > turns && prompted ? true : undefined));
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

/** Copilot's own answer to `initialize`, as recorded. */
const COPILOT_INITIALIZED = (JSON.parse(readFileSync(join(__dirname, 'fixtures/acp/copilot-cli/ordewell-tool.jsonl'), 'utf8').split('\n')[2]) as { line: { result: unknown } }).line.result;
const COPILOT_SESSION = 'sess-copilot';

/**
 * Copilot CLI over ACP, in the words its recordings show: a tool call
 * reported as `ordewell-<tool>`, then a permission request for it under the
 * bare `<tool>`; with `--allow-all` it asks about nothing.
 */
function copilotCli(script: FakeRunnerScript): FakeRunner {
  const kit = fakeSpawn([]);
  const agents: FakeAcpAgent[] = [];
  // Read at spawn: the directory is removed with the process that read it.
  const instructions: string[] = [];
  let calls = 0;
  const steps = (): FakeAcpStep[] => [
    { expect: 'initialize', reply: COPILOT_INITIALIZED },
    { expect: 'session/new', reply: { sessionId: COPILOT_SESSION } },
    // Copilot lists the server's tools once the session has it, and that use
    // of the token is the only attach evidence ACP leaves (ADR-0060, R5). Not
    // awaited: a start given a contact record of its own names no live server.
    ...(script.attach === 'connected' ? [{ run: (agent: FakeAcpAgent) => { void agent.listMcpTools().catch(() => undefined); } }] : []),
    script.reply === undefined
      ? { expect: 'session/prompt' }
      : { expect: 'session/prompt', reply: (_params: unknown, agent: FakeAcpAgent) => { agent.send('session/update', update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.reply } })); return { stopReason: 'end_turn' }; } },
  ];
  const update = (body: Record<string, unknown>) => ({ sessionId: COPILOT_SESSION, update: body });
  const spawn: SpawnFn = (cmd, argv, options) => {
    // A restricted start finds AGENTS.md in the private directory it starts in.
    const dir = options.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? (typeof options.cwd === 'string' ? options.cwd : undefined);
    instructions.push(dir && existsSync(join(dir, 'AGENTS.md')) ? readFileSync(join(dir, 'AGENTS.md'), 'utf8') : '');
    const proc = kit.spawn(cmd, argv, options);
    const agent = new FakeAcpAgent(steps());
    agent.attach(proc as unknown as FakeAgentProcess);
    agents.push(agent);
    return proc;
  };
  const agent = () => agents[agents.length - 1];
  const ask = async (report: Record<string, unknown>, permission: Record<string, unknown>): Promise<RunnerAnswer> => {
    const toolCallId = `call_${++calls}`;
    agent().send('session/update', update({ sessionUpdate: 'tool_call', toolCallId, status: 'pending', rawInput: {}, ...report }));
    let outcome: { outcome?: string; optionId?: string } | undefined;
    void agent().ask('session/request_permission', {
      sessionId: COPILOT_SESSION,
      toolCall: { toolCallId, status: 'pending', rawInput: {}, ...permission },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ],
    }).then((answer) => { outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome ?? {}; });
    const answer = await answered(() => outcome);
    return answer === undefined ? 'open' : answer.optionId?.startsWith('allow') ? 'allow' : 'deny';
  };
  const allowsAll = () => kit.lastArgs().includes('--allow-all');
  const bare = (name: string) => (name.startsWith('ordewell-') ? name.slice('ordewell-'.length) : name);
  return {
    deps: baseDeps(spawn, noHttp),
    launches: () => agents.length,
    injectedUrl: (n = agents.length - 1) => agents[n]?.mcpServers.find((server) => server.name === 'ordewell')?.url ?? null,
    commandLine: () => kit.lastArgs().join(' '),
    preAllows: async (name) => allowsAll() || (await ask({ title: name, kind: 'other' }, { title: bare(name), kind: 'other' })) === 'allow',
    instructions: () => instructions[instructions.length - 1] ?? '',
    turnOpen: async () => { await answered(() => (agent().requests('session/prompt').length > 0 ? true : undefined)); },
    callOrdewellTool: (tool) => {
      agent().send('session/update', update({ sessionUpdate: 'tool_call', toolCallId: `call_${tool}`, title: `ordewell-${tool}`, kind: 'other', status: 'pending', rawInput: {} }));
      // A pending call is not yet running, and is not reported until it is.
      agent().send('session/update', update({ sessionUpdate: 'tool_call_update', toolCallId: `call_${tool}`, status: 'in_progress' }));
    },
    askOrdewellTool: (tool) => ask({ title: `ordewell-${tool}`, kind: 'other' }, { title: tool, kind: 'other' }),
    askWrite: () => ask({ title: 'Creating /repo/a.txt', kind: 'edit' }, { title: 'Create file', kind: 'edit' }),
    say: (text) => {
      agent().send('session/update', update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }));
    },
    killed: (n) => kit.processes[n]?.killed ?? false,
    withServer: (start) => {
      if (!start.mcp) return start;
      const used = script.attach === 'connected';
      return { ...start, mcp: { ...start.mcp, contact: { contacted: () => used, whenContacted: async () => used } } };
    },
  };
}

/** Qwen Code's own answers to `initialize` and `session/new`, as recorded. */
const QWEN_RECORDING = readFileSync(join(__dirname, 'fixtures/acp/qwen-code/ordewell-tool.jsonl'), 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text) as { dir: string; line?: { id?: number; result?: unknown } });
const qwenAnswer = (id: number) => QWEN_RECORDING.find((entry) => entry.dir === 'in' && entry.line?.id === id)!.line!.result as { sessionId?: string; configOptions?: Array<{ id: string; currentValue: unknown }> };
const QWEN_SESSION = qwenAnswer(2).sessionId!;

/**
 * Qwen Code over ACP, in the words its recordings show: every request names
 * the tool in `_meta.toolName` (an MCP tool as `mcp__ordewell__<tool>`, a
 * native one bare) and puts the call's arguments in its title; a call is first
 * reported under a placeholder title ("ToolCall"). Its mode is a config
 * option set after `session/new`; in `yolo` it asks about nothing.
 */
function qwenCode(script: FakeRunnerScript): FakeRunner {
  const kit = fakeSpawn([]);
  const agents: FakeAcpAgent[] = [];
  let calls = 0;
  const steps = (): FakeAcpStep[] => [
    { expect: 'initialize', reply: qwenAnswer(1) },
    { expect: 'session/new', reply: qwenAnswer(2) },
    // Qwen contacts the server while the session is made, and that use of the
    // token is the only attach evidence ACP leaves (ADR-0060, R5).
    ...(script.attach === 'connected' ? [{ run: (agent: FakeAcpAgent) => { void agent.listMcpTools().catch(() => undefined); } }] : []),
    // It answers a setting with the whole list, the new value in it.
    {
      expect: 'session/set_config_option',
      reply: (params: unknown) => {        const { configId, value } = params as { configId: string; value: string };
        return { configOptions: qwenAnswer(2).configOptions!.map((option) => (option.id === configId ? { ...option, currentValue: value } : option)) };
      },
    },
    script.reply === undefined
      ? { expect: 'session/prompt' }
      : { expect: 'session/prompt', reply: (_params: unknown, agent: FakeAcpAgent) => { agent.send('session/update', update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.reply } })); return { stopReason: 'end_turn' }; } },
  ];
  const update = (body: Record<string, unknown>) => ({ sessionId: QWEN_SESSION, update: body });
  const spawn: SpawnFn = (cmd, argv, options) => {
    const proc = kit.spawn(cmd, argv, options);
    const agent = new FakeAcpAgent(steps());
    agent.attach(proc as unknown as FakeAgentProcess);
    agents.push(agent);
    return proc;
  };
  const agent = () => agents[agents.length - 1];
  const ask = async (tool: string, kind: string, title: string): Promise<RunnerAnswer> => {
    const toolCallId = `call_${++calls}`;
    let outcome: { outcome?: string; optionId?: string } | undefined;
    void agent().ask('session/request_permission', {
      sessionId: QWEN_SESSION,
      toolCall: { toolCallId, status: 'pending', title, kind, content: [], locations: [], rawInput: {}, _meta: { toolName: tool } },
      options: [
        { optionId: 'proceed_always_project', name: 'Always Allow in project', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    }).then((answer) => { outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome ?? {}; });
    const answer = await answered(() => outcome);
    return answer === undefined ? 'open' : answer.optionId?.startsWith('proceed') ? 'allow' : 'deny';
  };
  return {
    deps: baseDeps(spawn, noHttp),
    launches: () => agents.length,
    injectedUrl: (n = agents.length - 1) => agents[n]?.mcpServers.find((server) => server.name === 'ordewell')?.url ?? null,
    commandLine: () => kit.lastArgs().join(' '),
    preAllows: async (name) => (await ask(name, 'other', JSON.stringify({ from: 'fake' }))) === 'allow',
    // The contract rides in the first prompt: Qwen has no channel apart from it.
    instructions: () => ((agent().requests('session/prompt')[0]?.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt ?? []).map((part) => part.text ?? '').join('\n'),
    turnOpen: async () => { await answered(() => (agent().requests('session/prompt').length > 0 ? true : undefined)); },
    callOrdewellTool: (tool) => {
      agent().send('session/update', update({ sessionUpdate: 'tool_call', toolCallId: `call_${tool}`, status: 'pending', title: 'ToolCall', kind: 'other', rawInput: {}, _meta: { toolName: 'tool_call', provenance: 'builtin', phase: 'preparing' } }));
      agent().send('session/update', update({ sessionUpdate: 'tool_call_update', toolCallId: `call_${tool}`, status: 'in_progress', title: `${tool} (ordewell MCP Server): {}`, kind: 'other', _meta: { toolName: `mcp__ordewell__${tool}`, provenance: 'mcp', serverId: 'ordewell' } }));
    },
    askOrdewellTool: (tool) => ask(`mcp__ordewell__${tool}`, 'other', JSON.stringify({ from: 'fake' })),
    askWrite: () => ask('write_file', 'edit', 'Writing to a.txt'),
    say: (text) => {
      agent().send('session/update', update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }));
    },
    killed: (n) => kit.processes[n]?.killed ?? false,
    withServer: (start) => {
      if (!start.mcp) return start;
      const used = script.attach === 'connected';
      return { ...start, mcp: { ...start.mcp, contact: { contacted: () => used, whenContacted: async () => used } } };
    },
  };
}

/** A fake for every built-in runner, by runner id. */
export const FAKE_RUNNERS: Record<string, (script: FakeRunnerScript) => FakeRunner> = {
  'claude-code': claudeCode,
  codex,
  opencode: openCode,
  'copilot-cli': copilotCli,
  'qwen-code': qwenCode,
};
