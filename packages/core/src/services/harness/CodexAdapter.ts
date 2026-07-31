import type { AgentEvent, AgentStartOptions } from './AgentAdapter';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { probeCodexSandbox, codexSandboxUnavailableMessage, type CodexSandboxDecision } from './codexSandbox';

const HANDSHAKE_TIMEOUT_MS = 30000;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * One entry of a Codex turn. Field names are the app-server protocol's, taken
 * from `codex app-server generate-json-schema`, not invented here.
 */
interface ThreadItem {
  id?: string;
  type?: string;
  text?: string;
  /** Reasoning carries arrays of blocks, not a string — see `flattenText`. */
  summary?: unknown;
  content?: unknown;
  command?: string | string[];
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  status?: string;
  success?: boolean;
  query?: string;
  /** `final_answer` vs `commentary`; both are prose the user should see. */
  phase?: string;
}

/**
 * Codex carries prose as arrays of blocks — `reasoning.summary`, and the
 * `content` of an MCP tool result — where each block is a string or an object
 * with a `text` field. Reading them as plain strings produced empty thinking
 * events against the real CLI, which is why this exists.
 */
function flattenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    const content = (value as { content?: unknown }).content;
    if (content !== undefined) return flattenText(content);
  }
  return '';
}

/**
 * Server→client requests that carry a refusal in their own result schema, and
 * the exact payload that expresses it. Anything not listed here is refused with
 * a JSON-RPC error instead — see {@link CodexAdapter.answerServerRequest}.
 */
const DECLINE_RESULTS: Record<string, Record<string, unknown>> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'mcpServer/elicitation/request': { action: 'decline' },
  // The pre-`item/*` spellings, still emitted by older app-servers.
  execCommandApproval: { decision: 'denied' },
  applyPatchApproval: { decision: 'denied' },
};

const LANDLOCK_FALLBACK_NOTE = [
  "Codex's bubblewrap sandbox cannot create user namespaces on this machine, so planning fell back to its legacy Landlock backend.",
  'Exploration works and writes are still denied, but that backend is deprecated upstream. To fix the host:',
  '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
].join('\n');

/** Requests worth showing in the timeline: the planner reached for something it may not have. */
const ANNOUNCED_REQUESTS = new Set([
  ...Object.keys(DECLINE_RESULTS),
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'item/tool/call',
]);

/**
 * Codex as a planner, over its `app-server` stdio JSON-RPC transport
 * (ADR-0009).
 *
 * Ordewell already speaks a slice of this protocol — `ModelDiscovery` drives
 * `initialize` → `model/list` to build the Codex model catalog — so the
 * handshake here is that one continued into a thread.
 *
 * Codex's own CLI marks `app-server` experimental, and it is the transport
 * most likely to drift: the method names below (`thread/start`, `turn/start`,
 * `item/completed`) come from the schema the installed binary generates, and a
 * version that renames them will surface as a visible dead turn rather than a
 * hang, because the base class watches the process as well as the protocol.
 */
export class CodexAdapter extends StdioAgentAdapter {
  readonly agentId = 'codex';

  private threadId: string | null = null;
  private nextRequestId = 100;
  private settleHandshake: ((ok: boolean) => void) | null = null;
  private handshakeError: string | null = null;
  private startOpts: AgentStartOptions | null = null;
  /** Whether this turn has already emitted prose — see the `agentMessage` case. */
  private turnHasText = false;
  private resumeAttempted = false;
  private resumeFallbackSent = false;
  private sandbox: CodexSandboxDecision = 'default';

  protected spawnSpec(opts: AgentStartOptions): SpawnSpec {
    this.startOpts = opts;
    return { command: 'codex', args: ['app-server'] };
  }

  /**
   * `initialize`, then `thread/start`, both before the first user message. The
   * thread is pinned to the read-only sandbox with approvals set to `never` —
   * with nobody watching a planner's prompts, "ask" would mean "hang", which is
   * ADR-0008's absent-is-denial invariant kept by construction.
   */
  protected async handshake(opts: AgentStartOptions): Promise<void> {
    // Before the protocol, the machine: a Codex whose sandbox cannot start runs
    // no command and plans from imagination instead of from the repository.
    this.sandbox = await probeCodexSandbox(this.deps, opts.cwd, this.spawnEnv);
    if (this.sandbox === 'unavailable') throw new Error(codexSandboxUnavailableMessage());

    const ready = new Promise<boolean>((resolve) => { this.settleHandshake = resolve; });
    this.writeLine({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'ordewell', title: 'Ordewell', version: '0.1.0' } },
    });

    const ok = await Promise.race([
      ready,
      // A binary that rejects `app-server` outright dies immediately; waiting
      // out the timeout would turn a one-line diagnostic into a 30s stall.
      this.processEnded.then(() => false),
      new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), HANDSHAKE_TIMEOUT_MS); t.unref?.(); }),
    ]);
    this.settleHandshake = null;
    if (!ok) {
      throw new Error(this.handshakeError ?? `The Codex app-server did not complete its handshake.\n\n${this.exitMessage()}`);
    }
    void opts;
  }

  /**
   * Open the thread this session plans in. A resume id means the previous
   * process died mid-session: `thread/resume` puts the agent back in front of
   * the context it already paid to read. A failed resume is not an error — the
   * response handler falls back to a fresh thread, which is the same
   * degradation `restoreChat` performs on every surface (T4).
   */
  private startThread(resumeSessionId?: string): void {
    const opts = this.startOpts;
    this.resumeAttempted = this.resumeAttempted || !!resumeSessionId;
    this.writeLine({
      jsonrpc: '2.0',
      id: 2,
      method: resumeSessionId ? 'thread/resume' : 'thread/start',
      params: {
        ...(resumeSessionId ? { threadId: resumeSessionId } : {}),
        cwd: opts?.cwd,
        ...(opts?.model ? { model: opts.model } : {}),
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ...(this.sandbox === 'legacy-landlock'
          ? { config: { features: { use_legacy_landlock: true } } }
          : {}),
        // `developerInstructions` layers on top of Codex's own base prompt, the
        // way Claude Code's `--append-system-prompt` does. `baseInstructions`
        // replaces it — which takes Codex's description of its own tools with
        // it, and a planner that has forgotten it can read the workspace
        // answers from a web search instead.
        developerInstructions: opts?.systemPrompt,
      },
    });
  }

  protected turnPayload(message: string): string {
    const opts = this.startOpts;
    return `${JSON.stringify({
      jsonrpc: '2.0',
      id: this.nextRequestId++,
      method: 'turn/start',
      params: {
        threadId: this.threadId,
        input: [{ type: 'text', text: message }],
        ...(opts?.effort ? { effort: opts.effort } : {}),
      },
    })}\n`;
  }

  protected handleLine(line: string, emit: (event: AgentEvent) => void): void {
    const msg = StdioAgentAdapter.parse<RpcMessage>(line);
    if (!msg) return;

    if (msg.id === 1 && !msg.method) {
      if (msg.error) {
        this.handshakeError = `The Codex app-server rejected initialize: ${msg.error.message ?? 'unknown error'}`;
        this.settleHandshake?.(false);
        return;
      }
      this.startThread(this.startOpts?.resumeSessionId);
      return;
    }

    if (msg.id === 2 && !msg.method) {
      const thread = msg.result?.thread as { id?: string } | undefined;
      if (msg.error || !thread?.id) {
        if (this.resumeAttempted && !this.resumeFallbackSent) {
          this.resumeFallbackSent = true;
          this.startThread();
          return;
        }
        this.handshakeError = `The Codex app-server could not start a thread: ${msg.error?.message ?? 'no thread id returned'}`;
        this.settleHandshake?.(false);
        return;
      }
      this.threadId = thread.id;
      this.sessionId = thread.id;
      this.settleHandshake?.(true);
      return;
    }

    // Every server→client request — one that carries both a method and an id —
    // gets an answer, because an unanswered one stalls the turn forever. That
    // is ADR-0008's absent-is-denial invariant applied to the whole request
    // surface rather than to the three approval methods that happened to be
    // known when this adapter was written.
    if (msg.method && msg.id !== undefined) {
      this.answerServerRequest(msg, emit);
      return;
    }

    switch (msg.method) {
      case 'item/started':
        this.emitItemStart(msg.params?.item as ThreadItem | undefined, emit);
        return;
      case 'item/completed':
        this.emitItemDone(msg.params?.item as ThreadItem | undefined, emit);
        return;
      case 'turn/started':
        this.turnHasText = false;
        return;
      // Codex reports a setup problem once, at startup, and then plans anyway.
      // Surfacing it is enough: the warning is not always fatal, and refusing to
      // plan on an unrecognized one would be worse than showing it.
      case 'configWarning': {
        const warning = msg.params as { summary?: string; details?: string } | undefined;
        const text = [warning?.summary, warning?.details].filter(Boolean).join('\n');
        // Codex emits the bubblewrap warning from its default config, before the
        // thread picks a backend, so it arrives even on the Landlock fallback
        // that just fixed it. Passing it through would be a false alarm, and
        // dropping it would hide a host that still needs fixing — Landlock is
        // deprecated upstream, so this is a reprieve, not a repair.
        if (this.sandbox === 'legacy-landlock' && /bubblewrap|user namespace/i.test(text)) {
          emit({ type: 'thinking', text: LANDLOCK_FALLBACK_NOTE });
          return;
        }
        if (text) emit({ type: 'thinking', text: `Codex configuration warning: ${text}` });
        return;
      }
      // A turn that fails without retry may never reach `turn/completed` — a
      // rate limit or an exhausted context window would otherwise hang until
      // the process died.
      case 'error': {
        const failure = msg.params as { error?: { message?: string }; willRetry?: boolean } | undefined;
        if (failure?.willRetry) return;
        emit({ type: 'error', message: failure?.error?.message || 'Codex ended the turn with an error.' });
        return;
      }
      case 'turn/completed': {
        const turn = msg.params?.turn as { status?: string; error?: { message?: string } } | undefined;
        if (turn?.status === 'failed') {
          emit({ type: 'error', message: turn.error?.message || 'Codex ended the turn with an error.' });
        } else {
          emit({ type: 'turn_end' });
        }
        return;
      }
      // Deltas (`item/agentMessage/delta`, `item/reasoning/*Delta`) are skipped:
      // the completed item follows and would otherwise be counted twice.
      default:
        return;
    }
  }

  /**
   * Refuse one server→client request. Requests whose result schema can express
   * a refusal get that payload; everything else — a permission grant, a
   * question for a user who is not watching, a tool call the client is supposed
   * to run — gets a JSON-RPC error, which Codex surfaces to the model as a
   * failed request and plans around, rather than waiting on.
   */
  private answerServerRequest(msg: RpcMessage, emit: (e: AgentEvent) => void): void {
    const method = msg.method!;
    const result = DECLINE_RESULTS[method];
    if (result) {
      this.writeLine({ jsonrpc: '2.0', id: msg.id, result });
    } else if (method === 'currentTime/read') {
      // Answered rather than refused: it is not a capability request, and
      // failing it would break a tool for no reason.
      this.writeLine({ jsonrpc: '2.0', id: msg.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    } else {
      this.writeLine({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'The Ordewell planner is read-only and has no user to consult. Mutation belongs to the runners that execute the plan.' },
      });
    }
    if (!ANNOUNCED_REQUESTS.has(method)) return;
    emit({
      type: 'permission_request',
      id: String(msg.id ?? ''),
      name: method.split('/').pop() ?? method,
      detail: JSON.stringify(msg.params ?? {}),
    });
  }

  /** A tool item entering `inProgress` — announce the call so the timeline moves. */
  private emitItemStart(item: ThreadItem | undefined, emit: (e: AgentEvent) => void): void {
    if (!item?.id) return;
    switch (item.type) {
      case 'commandExecution':
        emit({ type: 'tool_call', id: item.id, name: 'shell', args: { command: item.command, cwd: item.cwd } });
        return;
      case 'mcpToolCall':
        emit({ type: 'tool_call', id: item.id, name: item.tool ?? 'mcp_tool', args: item.arguments ?? {} });
        return;
      case 'dynamicToolCall':
        emit({ type: 'tool_call', id: item.id, name: item.tool ?? 'tool', args: item.arguments ?? {} });
        return;
      case 'webSearch':
        emit({ type: 'tool_call', id: item.id, name: 'web_search', args: { query: item.query } });
        return;
      default:
        return;
    }
  }

  private emitItemDone(item: ThreadItem | undefined, emit: (e: AgentEvent) => void): void {
    if (!item?.type) return;
    const id = item.id ?? '';
    switch (item.type) {
      // A Codex turn is several whole messages — progress commentary, then the
      // final answer — not a token stream. Concatenated raw they run together
      // ("…as requested.`head` failed because…"), so each one after the first
      // opens a paragraph.
      case 'agentMessage':
        if (!item.text) return;
        emit({ type: 'assistant_text', text: this.turnHasText ? `\n\n${item.text}` : item.text });
        this.turnHasText = true;
        return;
      case 'reasoning': {
        const text = flattenText(item.summary) || flattenText(item.content) || item.text || '';
        if (text.trim()) emit({ type: 'thinking', text });
        return;
      }
      case 'commandExecution':
        emit({
          type: 'tool_result', id, name: 'shell',
          output: item.aggregatedOutput ?? '',
          success: (item.exitCode ?? 0) === 0,
        });
        return;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        emit({
          type: 'tool_result', id, name: item.tool ?? 'tool',
          output: item.error ?? flattenText(item.result) ?? '',
          success: item.status !== 'error' && item.success !== false && !item.error,
        });
        return;
      // The query is empty when the search starts and filled when it lands, so
      // the result — not the call — is what carries what was actually searched.
      case 'webSearch':
        emit({ type: 'tool_result', id, name: 'web_search', output: item.query ?? '', success: true });
        return;
      // `fileChange` can only appear if the read-only sandbox was bypassed;
      // reporting it keeps that visible rather than silent.
      case 'fileChange':
        emit({ type: 'tool_result', id, name: 'file_change', output: JSON.stringify(item), success: false });
        return;
      default:
        return;
    }
  }
}
