import type { ChildProcess } from 'child_process';
import { augmentedPath, withPath } from '../../utils/shellPath';
import { planDirectLaunch, isExecutableResolved, ExecutableNotFoundError } from '../../utils/launch';
import { assertWorkspaceExists } from '../../utils/workspace';
import { killTree } from '../../utils/processTree';
import type { AgentAdapter, AgentEvent, AgentProcessDeps, AgentStartOptions } from './AgentAdapter';

const SERVER_READY_TIMEOUT_MS = 30000;
const STDERR_TAIL_CHARS = 4000;
/** How long a turn waits for `/event` before posting anyway. See {@link OpenCodeAdapter.send}. */
const STREAM_CONNECT_TIMEOUT_MS = 5000;

/**
 * Tools withheld from a planning session (T1). `question` is the load-bearing
 * one: it blocks the turn on an answer from a user who is not watching, and the
 * message POST then never returns — an absent answer has to mean denial, not a
 * hung planner. The rest are the write tools, withheld for the same reason
 * {@link ClaudeCodeAdapter} names them despite `--permission-mode plan`: the
 * `plan` agent already refuses them, and a future default must not quietly
 * hand the planner an edit.
 */
const DISABLED_TOOLS: Record<string, boolean> = {
  question: false,
  edit: false,
  write: false,
  apply_patch: false,
  todowrite: false,
};

interface OpenCodePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  messageID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
}

/** `permission.asked` (and its v2 spelling) — the only server→client request OpenCode makes. */
interface OpenCodePermissionAsk {
  id?: string;
  sessionID?: string;
  permission?: string;
  action?: string;
  patterns?: string[];
  resources?: string[];
  metadata?: Record<string, unknown>;
}

interface OpenCodeMessageResponse {
  parts?: OpenCodePart[];
  /** `AssistantMessage.error` is a tagged union: `{ name, data: { message } }`. */
  info?: { id?: string; error?: { name?: string; data?: { message?: string } } };
  error?: { message?: string } | string;
}

/**
 * OpenCode addresses a model as `{providerID, modelID}`; discovery and the
 * plan artifact carry the flat `provider/model` id the CLI's `--model` flag
 * takes. Split on the first slash — provider ids never contain one, model ids
 * sometimes do (`openrouter/anthropic/claude-sonnet-4`).
 */
function splitModelId(id: string): { providerID: string; modelID: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/**
 * OpenCode as a planner, over its headless HTTP server (ADR-0009).
 *
 * The odd one out: `opencode serve` is a real server rather than a stdio
 * protocol, so this adapter owns both halves of the boundary — it spawns the
 * process through the same injected `spawn` every other adapter uses, then
 * talks to it through the injected `fetch`. Both are part of the one seam the
 * tests drive.
 *
 * The turn ends when the message POST resolves. Live events stream from the
 * server's `/event` channel, but the POST is what settles the turn: an event
 * name that changes between OpenCode versions then costs liveness, not
 * correctness.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly agentId = 'opencode';

  private process: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private sessionId: string | null = null;
  private stderrTail = '';
  private exited = false;
  private disposed = false;
  private opts: AgentStartOptions | null = null;
  /** Whether this turn has already emitted reply text — see {@link emitPart}. */
  private turnHasText = false;

  constructor(private deps: AgentProcessDeps) {}

  async start(opts: AgentStartOptions): Promise<void> {
    this.opts = opts;
    // Checked before anything else: a workspace deleted out from under a
    // stale `process.cwd()` otherwise surfaces as `spawn`'s ENOENT, which
    // reads as a missing `opencode` binary rather than a missing directory.
    assertWorkspaceExists(opts.cwd, { isDirectory: this.deps.isDirectory });
    const resolvePath = this.deps.resolvePath ?? augmentedPath;
    const PATH = await resolvePath();

    // On POSIX this is `opencode` unchanged; on Windows it resolves the real
    // executable, because CreateProcess performs no PATHEXT lookup.
    const launch = await planDirectLaunch('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      platform: this.deps.platform,
      resolvePath,
    });
    if (!isExecutableResolved('opencode', launch, PATH, { platform: this.deps.platform, exists: this.deps.exists })) {
      throw new ExecutableNotFoundError('opencode', PATH);
    }
    this.process = this.deps.spawn(launch.file, launch.args, {
      env: withPath(process.env, PATH),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      windowsVerbatimArguments: launch.verbatim,
    });

    const banner = new Promise<string | null>((resolve) => {
      let seen = '';
      const scan = (chunk: Buffer) => {
        seen += chunk.toString();
        const match = seen.match(/https?:\/\/[^\s]+/);
        if (match) resolve(match[0].replace(/[.,)]$/, ''));
      };
      this.process!.stdout?.on('data', scan);
      this.process!.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        scan(chunk);
      });
      this.process!.on('exit', () => { this.exited = true; resolve(null); });
      this.process!.on('error', (err) => {
        this.exited = true;
        this.stderrTail = (this.stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_CHARS);
        resolve(null);
      });
      const timer = setTimeout(() => resolve(null), SERVER_READY_TIMEOUT_MS);
      timer.unref?.();
    });

    this.baseUrl = await banner;
    if (!this.baseUrl) {
      throw new Error(`The OpenCode planner server did not start.${this.stderrTail.trim() ? `\n\n${this.stderrTail.trim()}` : ''}`);
    }

    // A resume id names a session on disk, not on this process — so it is
    // checked rather than trusted. A stale one degrades to a fresh session
    // (T4), where the caller reseeds from Ordewell's own transcript.
    if (opts.resumeSessionId) {
      const existing = await this.json<{ id?: string }>('GET', `/session/${opts.resumeSessionId}`).catch(() => null);
      if (existing?.id) {
        this.sessionId = existing.id;
        return;
      }
    }
    const created = await this.json<{ id?: string }>('POST', '/session', {});
    if (!created?.id) throw new Error('The OpenCode planner server did not return a session id.');
    this.sessionId = created.id;
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.baseUrl || !this.sessionId) throw new Error('OpenCode planner session is not started');
    if (this.exited) {
      onEvent({ type: 'error', message: this.exitMessage() });
      return;
    }

    const seen = new Set<string>();
    this.turnHasText = false;
    const streamAbort = new AbortController();
    let connected: () => void = () => {};
    const streamReady = new Promise<void>((resolve) => { connected = resolve; });
    // The live stream carries tool activity only. It also replays the user's
    // own message back as text parts, and the event frame gives no role to
    // filter on — so prose is taken from the settled response instead, where
    // `info.id` says exactly which message is the assistant's. Letting the
    // echo through would put the user's goal into the planner's reply text,
    // and a goal containing JSON would then be parsed as the plan.
    const live = this.streamEvents(
      streamAbort.signal,
      (part) => { if (part.type === 'tool') this.emitPart(part, seen, onEvent); },
      (ask) => this.denyPermission(ask, seen, onEvent),
      connected,
      onActivity,
    );

    // The stream stopped being best-effort the moment permission denial moved
    // onto it: a request raised before we connect is one nobody answers, and
    // the message POST then hangs until its own timeout. Waiting is bounded so
    // a server that never opens `/event` still gets its turn.
    await Promise.race([streamReady, new Promise<void>((r) => { const t = setTimeout(r, STREAM_CONNECT_TIMEOUT_MS); t.unref?.(); })]);

    try {
      const model = this.opts?.model ? splitModelId(this.opts.model) : null;
      const body = {
        parts: [{ type: 'text', text: message }],
        // The read-only guarantee: OpenCode's own plan agent has no write tools.
        agent: 'plan',
        tools: DISABLED_TOOLS,
        ...(model ? { model } : {}),
        ...(this.opts?.effort ? { variant: this.opts.effort } : {}),
        ...(this.opts?.systemPrompt ? { system: this.opts.systemPrompt } : {}),
      };
      const reply = await this.json<OpenCodeMessageResponse>('POST', `/session/${this.sessionId}/message`, body, signal);

      if (signal?.aborted) { this.dispose(); return; }

      const failure = typeof reply?.error === 'string'
        ? reply.error
        : (reply?.error as { message?: string } | undefined)?.message ?? reply?.info?.error?.data?.message;
      if (failure) {
        onEvent({ type: 'error', message: failure });
        return;
      }
      // The settled response is authoritative: it names the assistant message,
      // so its parts are the ones that make up the reply. Tool parts already
      // seen live are deduplicated by call id; anything the stream missed
      // (including a stream that never connected) arrives here.
      const assistantId = reply?.info?.id;
      for (const part of reply?.parts ?? []) {
        if (part.type !== 'tool' && assistantId && part.messageID !== assistantId) continue;
        this.emitPart(part, seen, onEvent);
      }
      onEvent({ type: 'turn_end' });
    } catch (err) {
      if (signal?.aborted) { this.dispose(); return; }
      onEvent({ type: 'error', message: `The OpenCode planner turn failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      streamAbort.abort();
      await live.catch(() => { /* the stream is best-effort */ });
    }
  }

  /**
   * Emit one message part, once. OpenCode reports a tool part repeatedly as it
   * moves through pending → running → completed, so parts are keyed by id and
   * only the terminal state produces a result.
   */
  private emitPart(part: OpenCodePart, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    if (!part?.type) return;
    const id = part.id ?? part.callID ?? '';

    if (part.type === 'text' && part.text) {
      if (seen.has(`text:${id}`)) return;
      seen.add(`text:${id}`);
      // One message can carry text on both sides of a tool call. Concatenated
      // raw they run together, so each part after the first opens a paragraph.
      onEvent({ type: 'assistant_text', text: this.turnHasText ? `\n\n${part.text}` : part.text });
      this.turnHasText = true;
      return;
    }
    if (part.type === 'reasoning' && part.text) {
      if (seen.has(`reasoning:${id}`)) return;
      seen.add(`reasoning:${id}`);
      onEvent({ type: 'thinking', text: part.text });
      return;
    }
    if (part.type !== 'tool') return;

    const callId = part.callID ?? id;
    const name = part.tool ?? 'tool';
    const status = part.state?.status;
    const input = part.state?.input;
    // A `pending` tool part carries no input yet, so announcing it there gave
    // every call an empty arg summary. Waiting for the first state that has
    // input costs a moment of liveness and buys a readable timeline.
    if (!seen.has(`call:${callId}`) && (status !== 'pending' || (input && Object.keys(input).length > 0))) {
      seen.add(`call:${callId}`);
      onEvent({ type: 'tool_call', id: callId, name, args: input ?? {} });
    }
    if ((status === 'completed' || status === 'error') && !seen.has(`result:${callId}`)) {
      seen.add(`result:${callId}`);
      onEvent({
        type: 'tool_result',
        id: callId,
        name,
        output: part.state?.output ?? part.state?.error ?? '',
        success: status === 'completed',
      });
    }
  }

  /**
   * Deny one permission request (T1). OpenCode blocks the turn until the
   * request is answered, so this must answer — `reject` rather than a silent
   * drop, which is the same "absent answer is a denial" invariant ADR-0008
   * states for Ordewell's own tools. The refusal is announced so the timeline
   * shows the planner reaching for something it may not have.
   */
  private denyPermission(ask: OpenCodePermissionAsk, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    const id = ask.id;
    if (!id || seen.has(`perm:${id}`)) return;
    seen.add(`perm:${id}`);
    const name = ask.permission ?? ask.action ?? 'permission';
    const scope = (ask.patterns ?? ask.resources ?? []).join(', ');
    onEvent({
      type: 'permission_request',
      id,
      name,
      detail: JSON.stringify({ ...(scope ? { scope } : {}), ...(ask.metadata ?? {}) }),
    });
    void this.json('POST', `/session/${ask.sessionID ?? this.sessionId}/permissions/${id}`, { response: 'reject' })
      .catch(() => { /* a server that forgot the request will not hang on it either */ });
  }

  /**
   * Server-sent events from `/event`. Tool activity on it is liveness only —
   * the settled POST repeats it — but permission requests arrive nowhere else,
   * so the stream is load-bearing for {@link denyPermission}.
   */
  private async streamEvents(
    signal: AbortSignal,
    onPart: (part: OpenCodePart) => void,
    onPermission: (ask: OpenCodePermissionAsk) => void,
    onConnected: () => void,
    onActivity?: () => void,
  ): Promise<void> {
    const response = await this.deps.fetch(`${this.baseUrl}/event`, { signal }).catch(() => null);
    const body = response?.body;
    if (!body) { onConnected(); return; }
    onConnected();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      // Any bytes at all mean the server is still talking, independent of
      // whether this chunk resolves into a part this adapter forwards —
      // the same gap that made Claude Code's watchdog false-positive on
      // filtered subagent output, closed here before it can recur.
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim()) as {
            type?: string;
            properties?: (OpenCodePermissionAsk & { part?: OpenCodePart });
          };
          const props = event.properties;
          if (!props) continue;
          if (props.sessionID && props.sessionID !== this.sessionId) continue;
          if (event.type === 'permission.asked' || event.type === 'permission.v2.asked') onPermission(props);
          else if (props.part) onPart(props.part);
        } catch {
          // A partial or unrecognized frame costs one event, not the turn.
        }
      }
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
    const response = await this.deps.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    return (await response.json().catch(() => null)) as T | null;
  }

  nativeSessionId(): string | null { return this.sessionId; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.process;
    this.process = null;
    this.baseUrl = null;
    // Tree-wide: `opencode serve` is a server, and on Windows it may sit behind
    // a cmd.exe shim. A surviving server keeps the port and the session.
    killTree(proc, { platform: this.deps.platform });
  }

  private exitMessage(): string {
    const tail = this.stderrTail.trim();
    return `The OpenCode planner server exited.${tail ? `\n\n${tail}` : ''}`;
  }
}
