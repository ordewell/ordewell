import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import type { AgentAdapterFactory, AgentEvent, AgentProcessDeps, SpawnFn, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { createTaskAdapter } from '../harness/connectors';
import type { RunnerManifest } from '../../plugins/types';
import type { McpCredential, OrdewellMcpServer, PlannerTokenScope, PlannerToolHandler } from '../mcp';

/**
 * The one test seam for harness planners (ADR-0009): a fake process boundary,
 * injected as {@link AgentProcessDeps}' `spawn`.
 *
 * Driving the service through this exercises adapter parsing, event mapping,
 * reply classification and the repair loop as a single observable behavior —
 * which is the point. The adapters are not separately mocked; the service
 * tests are what prove each one satisfies the interface.
 */

export interface FakeAgentProcess extends ChildProcess {
  /** Everything the adapter wrote to stdin, one entry per write. */
  readonly written: string[];
  /** Whether the adapter closed stdin — what makes a real CLI waiting for input exit. */
  readonly stdinEnded: boolean;
  /** Push a chunk onto the fake stdout, as the real CLI would. */
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  /** End the process, as a crash or a normal exit. */
  exit(code: number, signal?: string): void;
  /**
   * End the process while something it started still holds its stdout and
   * stderr — an inherited pipe, a descendant setsid'd out of the group: Node
   * reports 'exit', and the pipes neither end nor close.
   */
  exitHoldingPipes(code: number | null, signal?: string): void;
}

/**
 * Replies to each write with the next scripted response. A response is either
 * raw text pushed to stdout, or a function for the cases that need to look at
 * what was written (a resume flag, a corrective re-emit) or to kill the
 * process mid-turn.
 */
export type ScriptedReply = string | ((written: string, proc: FakeAgentProcess) => void);

export interface FakeSpawnResult {
  spawn: SpawnFn;
  /** Every process the code under test spawned, in order. Probes excluded. */
  readonly processes: FakeAgentProcess[];
  /** The argv of the most recent spawn — how the read-only flags are asserted. */
  lastArgs(): string[];
  lastCommand(): string;
  /** The environment of the most recent spawn. */
  lastEnv(): NodeJS.ProcessEnv;
  /** The working directory of the most recent spawn. */
  lastCwd(): string | undefined;
  /** The argv of each sandbox probe, in order — see {@link FakeSpawnOptions.probe}. */
  probeArgs(): string[][];
}

export interface FakeSpawnOptions {
  claudeAccount?: { subscriptionType?: string; apiKeySource?: string };
  autoMcpAttached?: boolean;
  codexDiscovery?: (method: string) => Record<string, unknown>;
  /**
   * Answers the sandbox capability probe Codex runs before its handshake
   * (`codex sandbox … /bin/true`). Given the probe's argv, return the exit code
   * and anything it printed. The default is a machine whose sandbox works, so
   * scenarios that are not about the sandbox never mention it.
   */
  probe?: (args: string[]) => { code: number; output?: string };
  /** Every spawned agent says `output` on stderr and exits with `code` at once, before it answers anything, as a CLI that refuses to start does. */
  exitOnSpawn?: { code: number; output: string };
  /** What a spawned agent does with the argv it was given before it answers anything, as a CLI refusing a `--resume` does. */
  beforeAnswering?: (proc: FakeAgentProcess, args: string[]) => void;
}

function makeProcess(): FakeAgentProcess {
  const proc = new EventEmitter() as unknown as FakeAgentProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const written: string[] = [];
  let killed = false;
  let stdinEnded = false;

  // The order a real child reports an end in: the process's `exit`, then the
  // stdio streams draining (`end`), then `close` once they have. Adapters act
  // on `close` and flush a partial last line on `end`, so the fake has to send
  // both or a turn would never finish.
  const end = (code: number | null, signal: string | null) => {
    proc.emit('exit', code, signal);
    stdout.emit('end');
    stderr.emit('end');
    proc.emit('close', code, signal);
  };

  Object.defineProperties(proc, {
    stdout: { value: stdout, writable: false },
    stderr: { value: stderr, writable: false },
    written: { get: () => written },
    killed: { get: () => killed },
    stdinEnded: { get: () => stdinEnded },
    // An emitter, as a real pipe is: an `error` on it with no listener throws.
    stdin: {
      value: Object.assign(new EventEmitter(), {
        write(chunk: string) {
          written.push(chunk);
          // Deliver asynchronously: a real CLI never answers inside the same
          // tick as the write, and a synchronous answer would let a test pass
          // against code that races the listener registration.
          queueMicrotask(() => proc.emit('__written', chunk));
          return true;
        },
        end() { stdinEnded = true; },
      }),
      writable: false,
    },
    kill: {
      value: (signal?: string) => {
        if (killed) return false;
        killed = true;
        queueMicrotask(() => end(null, signal ?? 'SIGTERM'));
        return true;
      },
      writable: false,
    },
    emitStdout: { value: (chunk: string) => stdout.emit('data', Buffer.from(chunk)), writable: false },
    emitStderr: { value: (chunk: string) => stderr.emit('data', Buffer.from(chunk)), writable: false },
    exit: {
      value: (code: number, signal?: string) => { killed = true; end(code, signal ?? null); },
      writable: false,
    },
    exitHoldingPipes: {
      value: (code: number | null, signal?: string) => { killed = true; proc.emit('exit', code, signal ?? null); },
      writable: false,
    },
  });

  // A never-listened-to 'error' on an EventEmitter throws; adapters attach one,
  // but a test that never sends a turn would otherwise be fragile.
  proc.on('error', () => { /* observed by the adapter */ });
  return proc;
}

/**
 * The fake process boundary both spawns below are built on: every write to a
 * process's stdin is handed to `onWrite` with the argv it was spawned under.
 */
function spawner(onWrite: (written: string, proc: FakeAgentProcess, args: string[]) => void, options: FakeSpawnOptions): FakeSpawnResult {
  const processes: FakeAgentProcess[] = [];
  const probes: string[][] = [];
  let command = '';
  let args: string[] = [];
  let env: NodeJS.ProcessEnv = {};
  let cwd: string | undefined;

  const spawn: SpawnFn = (cmd, argv, spawnOptions) => {
    // The sandbox probe is a short-lived side process, not the agent's
    // transport: it is kept out of `processes` and `lastArgs` so that adding it
    // does not shift the indices every other scenario asserts on.
    if (argv[0] === 'sandbox') {
      const proc = makeProcess();
      probes.push(argv);
      const { code, output } = options.probe?.(argv) ?? { code: 0 };
      queueMicrotask(() => {
        if (output) proc.emitStderr(output);
        proc.exit(code);
      });
      return proc as unknown as ChildProcess;
    }

    command = cmd;
    args = argv;
    env = spawnOptions?.env ?? {};
    cwd = spawnOptions?.cwd?.toString();
    const proc = makeProcess();
    processes.push(proc);
    if (options.exitOnSpawn) {
      const { code, output } = options.exitOnSpawn;
      queueMicrotask(() => { proc.emitStderr(output); proc.exit(code); });
    }
    proc.once('__written', () => options.beforeAnswering?.(proc, argv));
    proc.on('__written', (chunk: string) => onWrite(chunk, proc, argv));
    return proc as unknown as ChildProcess;
  };

  return {
    spawn,
    processes,
    lastArgs: () => args,
    lastCommand: () => command,
    lastEnv: () => env,
    lastCwd: () => cwd,
    probeArgs: () => probes,
  };
}

/**
 * A fake spawn whose process answers each stdin write with the next scripted
 * reply. Unscripted writes are ignored, which is how "the agent never
 * answered" is tested.
 *
 * One reply is consumed per *write*, not per turn — and adapters write on the
 * control channel too (a Claude Code permission denial, a Codex JSON-RPC
 * response). A scenario that answers a request mid-turn must either account for
 * those writes or use a function reply that inspects `written` and only answers
 * the user turns.
 */
export function fakeSpawn(replies: ScriptedReply[], options: FakeSpawnOptions = {}): FakeSpawnResult {
  const queue = [...replies];
  return spawner((chunk, proc, args) => {
    if (answeredAttachCheck(chunk, proc, args) || answeredModelControl(chunk, proc, options.claudeAccount)) return;
    let rpc: { id?: number; method?: string } = {};
    try { rpc = JSON.parse(chunk) as typeof rpc; } catch { /* another runner's input */ }
    if (rpc.method === 'skills/list' || rpc.method === 'mcpServerStatus/list') {
      proc.emitStdout(`${JSON.stringify({ id: rpc.id, result: options.codexDiscovery?.(rpc.method) ?? { data: [], nextCursor: null } })}\n`);
      return;
    }
    // A read-only task asks for the MCP servers Codex's configuration would start (ADR-0046).
    if (rpc.method === 'config/read') {
      const answer = options.codexDiscovery?.(rpc.method) ?? { result: { config: { mcp_servers: {} }, origins: {} } };
      proc.emitStdout(`${JSON.stringify({ id: rpc.id, ...answer })}\n`);
      return;
    }
    const reply = queue.shift();
    if (reply !== undefined) {
      if (typeof reply === 'function') reply(chunk, proc);
      else proc.emitStdout(reply);
    }
    if (options.autoMcpAttached !== false) reportCodexStartup(chunk, proc);
  }, options);
}

/**
 * Claude Code's `mcp_status` check, answered as the CLI would: the Ordewell
 * server connected when the process was handed one. Every task, and every
 * planner given tools, asks before its first turn (ADR-0022, S4), so the
 * check does not take a scripted reply.
 */
function answeredAttachCheck(chunk: string, proc: FakeAgentProcess, args: string[]): boolean {
  let msg: { type?: string; request_id?: string; request?: { subtype?: string } };
  try { msg = JSON.parse(chunk) as typeof msg; } catch { return false; }
  if (msg.type !== 'control_request' || msg.request?.subtype !== 'mcp_status') return false;
  const mcpServers = args.includes('--mcp-config') ? [{ name: 'ordewell', status: 'connected' }] : [];
  proc.emitStdout(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers } } })}\n`);
  return true;
}

/**
 * Claude Code's `initialize` and `set_model` control requests, answered as
 * `claude` 2.1.296 does: `initialize` lists each model value with the id it
 * runs as, and (2.1.299) the commands it offers; (2.1.302) the name it shows
 * each model under. Control traffic, so neither takes a scripted reply.
 */
export const CLAUDE_INITIALIZE_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
  { value: 'claude-haiku-5-5', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
];

/**
 * The commands `initialize` lists, as `claude` 2.1.299 did in a repository
 * with a project skill (`pingskill`) and command (`hellocmd`): a subset, the
 * longer descriptions cut. `doctor` is one the CLI runs only in its own TUI.
 */
export const CLAUDE_INITIALIZE_COMMANDS = [
  { name: 'tdd', description: 'Test-driven development. (user)', argumentHint: '' },
  { name: 'pingskill', description: 'Reply with the word PONG-SKILL and nothing else. (project)', argumentHint: '' },
  { name: 'hellocmd', description: 'Say hello-command (project)', argumentHint: 'name' },
  { name: 'doctor', description: "Health-check the user's Claude Code setup and fix issues.", argumentHint: '[prompt-audit [<path>]]', aliases: ['checkup'], builtin: true },
  { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', argumentHint: '[name]', aliases: ['reset', 'new'], builtin: true },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', builtin: true },
  { name: 'docs', description: 'docs (editable docs people share and comment on). (claude.ai sync)', argumentHint: '', aliases: ['anthropic-skills:docs'] },
  { name: '__remote-workflow', description: '', argumentHint: '', builtin: true },
];

function answeredModelControl(chunk: string, proc: FakeAgentProcess, account?: FakeSpawnOptions['claudeAccount']): boolean {
  let msg: { type?: string; request_id?: string; request?: { subtype?: string } };
  try { msg = JSON.parse(chunk) as typeof msg; } catch { return false; }
  if (msg.type !== 'control_request') return false;
  const subtype = msg.request?.subtype;
  if (subtype !== 'initialize' && subtype !== 'set_model') return false;
  const response = subtype === 'initialize' ? { response: { commands: CLAUDE_INITIALIZE_COMMANDS, models: CLAUDE_INITIALIZE_MODELS, ...(account ? { account } : {}) } } : {};
  proc.emitStdout(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, ...response } })}\n`);
  return true;
}

/**
 * Codex's startup report for the Ordewell server, sent as the app-server does
 * once a thread that was handed it opens: connected. A notification, so it
 * takes no scripted reply.
 */
function reportCodexStartup(chunk: string, proc: FakeAgentProcess): void {
  let msg: { method?: string; params?: { config?: { mcp_servers?: Record<string, unknown> } } };
  try { msg = JSON.parse(chunk) as typeof msg; } catch { return; }
  if (msg.method !== 'thread/start' && msg.method !== 'thread/resume') return;
  if (!msg.params?.config?.mcp_servers?.ordewell) return;
  queueMicrotask(() => proc.emitStdout(`${JSON.stringify({ method: 'mcpServer/startupStatus/updated', params: { name: 'ordewell', status: 'ready' } })}\n`));
}

/**
 * An Ordewell MCP server that issues tokens without listening: what a planner
 * or a task is handed when the test is not about the server itself.
 */
export type FakeMcpServer = OrdewellMcpServer & {
  readonly issued: string[];
  readonly revoked: string[];
  /** The handler each planner token was issued with, in order: what a fake agent's tool calls reach. */
  readonly plannerHandlers: PlannerToolHandler[];
  /** The scope each planner token was issued for, in order. */
  readonly plannerScopes: PlannerTokenScope[];
};

export function fakeMcpServer(): FakeMcpServer {
  const issued: string[] = [];
  const revoked: string[] = [];
  const plannerHandlers: PlannerToolHandler[] = [];
  const plannerScopes: PlannerTokenScope[] = [];
  const issue = async (): Promise<McpCredential> => {
    const token = `tok-${issued.length + 1}`;
    issued.push(token);
    return { url: 'http://127.0.0.1:1/mcp', token };
  };
  const server = {
    issued,
    revoked,
    plannerHandlers,
    plannerScopes,
    heldTokens: () => issued.filter((token) => !revoked.includes(token)),
    issueTaskToken: issue,
    issuePlannerToken: async (scope: PlannerTokenScope, handler: PlannerToolHandler = {}) => {
      plannerScopes.push(scope);
      plannerHandlers.push(handler);
      const credential = await issue();
      return scope.hidden?.length ? { ...credential, hidden: [...scope.hidden] } : credential;
    },
    revoke: (token: string) => { revoked.push(token); },
  };
  return server as unknown as FakeMcpServer;
}

/**
 * A fake spawn that answers model initialization like `fakeSpawn`, then hands
 * other writes to `onWrite` with the spawn argv. Scenarios own the remaining
 * control requests and user turns.
 */
export function respondingSpawn(
  onWrite: (written: string, proc: FakeAgentProcess, args: string[]) => void,
  options: FakeSpawnOptions = {},
): FakeSpawnResult {
  return spawner((written, proc, args) => {
    if (!answeredModelControl(written, proc, options.claudeAccount)) onWrite(written, proc, args);
  }, options);
}

/**
 * A fake spawn that answers nothing on its own: every write goes to `onWrite`,
 * `initialize` included, for a scenario about the control channel itself.
 */
export function silentSpawn(
  onWrite: (written: string, proc: FakeAgentProcess, args: string[]) => void,
  options: FakeSpawnOptions = {},
): FakeSpawnResult {
  return spawner(onWrite, options);
}

/**
 * Read a recorded agent transcript. One fixture per agent per scenario;
 * re-recording one against a newer CLI is how schema drift becomes a
 * reviewable diff.
 *
 * `{{PLAN}}` is substituted with a JSON-escaped plan body rather than being
 * baked into the fixture. A plan object escaped inside a JSON string inside a
 * JSONL line is unreadable, and would silently rot the day the validator's
 * required fields change — the transport shape is what these fixtures are for.
 */
export function fixture(agent: string, name: string, vars: Record<string, string> = {}): string {
  const raw = readFileSync(join(__dirname, 'fixtures', 'harness', agent, `${name}.jsonl`), 'utf8');
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(JSON.stringify(value).slice(1, -1)),
    raw,
  );
}

/**
 * A recorded Codex response, answered under the id its request was sent
 * with: a read-only task asks `config/read` before its thread (ADR-0046),
 * which the recording's fixed ids do not leave room for.
 */
export function codexAnswer(name: string): ScriptedReply {
  return (written, proc) => {
    const { id } = JSON.parse(written) as { id: number };
    proc.emitStdout(`${JSON.stringify({ ...(JSON.parse(fixture('codex', name)) as object), id })}\n`);
  };
}

/** A plan the validator accepts, as the JSON object an agent would emit. */
export function planJson(runner = 'claude-code'): string {
  return JSON.stringify({
    tasks: [
      {
        id: 'task-1',
        order: 1,
        title: 'Add the thing',
        description: 'Adds the thing',
        type: 'ai',
        dependencies: [],
        prompt: 'Add the thing to src/thing.ts',
        assignedRunner: runner,
        assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet' },
        autonomy: 'AFK',
        sliceType: 'AFK',
        subtasks: [],
      },
    ],
  });
}

/**
 * An adapter that plays one scripted event list per `send`, for the service's
 * own mapping rules — the events no recorded transcript produces yet, or
 * orderings a fixture would bury. Adapters themselves are proven through
 * {@link fakeSpawn}; this skips them on purpose.
 */
export function scriptedAdapter(turns: AgentEvent[][], agentId = 'claude-code'): AgentAdapterFactory {
  const queue = [...turns];
  return () => ({
    agentId,
    exited: false,
    start: async () => {},
    send: async (_message, onEvent) => {
      for (const event of queue.shift() ?? [{ type: 'turn_end' }]) onEvent(event);
    },
    nativeSessionId: () => null,
    dispose: () => {},
    mcpAttached: async () => true,
  });
}

/**
 * The structured runner's `createAdapter`, with Claude Code as it was before
 * it took messages mid-turn (ADR-0023): the real adapter, `steer` taken away.
 * The transcripts recorded before `--replay-user-messages` carry no
 * echoes, so the scenarios that play them keep covering the turn-end queue
 * and taking a message back.
 */
export function claudeTurnEndQueue(runner: string, deps: AgentProcessDeps): TaskModeAgentAdapter {
  const adapter = createTaskAdapter(runner, deps);
  return adapter instanceof ClaudeCodeAdapter ? Object.assign(adapter, { steer: undefined }) : adapter;
}

/**
 * A Claude Code task turn recorded from `claude` 2.1.291 under
 * `--replay-user-messages` (ADR-0023), cut where the steer was written so the
 * rest arrives only once it is, as from the CLI. `before` answers the prompt;
 * `answer` answers the steer, echoing the uuid it was written under.
 *
 * - `mid-turn`: written during a `sleep`, after the Bash call went out; read
 *   with the call's result, inside the turn.
 * - `after-result`: written while a text-only reply streamed; the turn ends,
 *   then the CLI runs the message as a turn of its own.
 */
export function claudeSteerRecording(when: 'mid-turn' | 'after-result'): { before: string; answer: ScriptedReply } {
  const name = when === 'mid-turn' ? 'task-steer' : 'task-steer-after-result';
  const lines = fixture('claude-code', name).split('\n');
  const cut = when === 'mid-turn'
    ? lines.findIndex((line) => line.includes('"task_started"'))
    : lines.findIndex((line) => line.includes('"text_delta"')) + 1;
  return {
    before: `${lines.slice(0, cut).join('\n')}\n`,
    answer: (written, proc) => {
      const { uuid } = JSON.parse(written) as { uuid: string };
      const rest = fixture('claude-code', name, { STEER_UUID: uuid }).split('\n').slice(cut);
      // The CLI's own turn starts a second or so after the `result`, never in
      // the same chunk: the session has settled the closed turn by then.
      const opens = rest.findIndex((line) => line.includes('"subtype":"init"'));
      if (opens < 0) { proc.emitStdout(rest.join('\n')); return; }
      proc.emitStdout(`${rest.slice(0, opens).join('\n')}\n`);
      setTimeout(() => proc.emitStdout(rest.slice(opens).join('\n')), 5);
    },
  };
}

/**
 * One recorded OpenCode turn. OpenCode answers over HTTP rather than stdio, so
 * a turn is two recordings, not one transcript: the `/event` frames the server
 * pushed while the turn ran, and the settled response to the message POST.
 * Frames come back SSE-encoded, ready to hand to {@link sseResponse}.
 */
export function openCodeFixture(name: string): { sessionId: string; frames: string[]; response: { info: { id: string; sessionID: string } } } {
  const dir = join(__dirname, 'fixtures', 'harness', 'opencode');
  const response = JSON.parse(readFileSync(join(dir, `${name}.response.json`), 'utf8')) as { info: { id: string; sessionID: string } };
  const frames = readFileSync(join(dir, `${name}.events.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => `data: ${line}\n\n`);
  return { sessionId: response.info.sessionID, frames, response };
}

/** One open server-sent-events connection a test feeds. */
export interface FakeEventStream {
  /** Queue one frame as one read, SSE-encoded the way OpenCode sends it. */
  push(frame: unknown): void;
  /** Queue raw text as one read: half a frame, several at once, or a line that is no frame at all. */
  pushRaw(chunk: string): void;
  /** Resolves the first time a read finds nothing queued — everything queued so far has been read. */
  readonly drained: Promise<void>;
}

/**
 * A streaming `fetch` response, as OpenCode's `/event` (1.x) and `/api/event`
 * (2.x) answer: `chunks` are read first, then each read waits for a push, and
 * the stream ends once the request's signal aborts — the way a live server
 * stays open until the adapter closes it.
 */
export function sseResponse(init?: RequestInit, chunks: string[] = []): { response: Response; stream: FakeEventStream } {
  const queue = [...chunks];
  const signal = init?.signal ?? undefined;
  const encoder = new TextEncoder();
  let wake: (() => void) | null = null;
  let markDrained: () => void = () => {};
  const drained = new Promise<void>((resolve) => { markDrained = resolve; });
  const enqueue = (chunk: string) => {
    queue.push(chunk);
    wake?.();
  };
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      for (;;) {
        if (signal?.aborted) return { done: true };
        const next = queue.shift();
        if (next !== undefined) return { done: false, value: encoder.encode(next) };
        markDrained();
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        wake = null;
      }
    },
  };
  return {
    response: { ok: true, status: 200, statusText: 'OK', body: { getReader: () => reader } } as unknown as Response,
    stream: {
      push: (frame) => enqueue(`data: ${JSON.stringify(frame)}\n\n`),
      pushRaw: enqueue,
      drained,
    },
  };
}

/** Every mode a runner offers, so a per-mode test cannot quietly run over none. */
export function modeIds(manifest: RunnerManifest): string[] {
  const ids = (manifest.modes ?? []).map((mode) => mode.id);
  if (ids.length === 0) throw new Error(`${manifest.name} lists no modes`);
  return ids;
}
