import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { extractPresentedToken } from '../../utils/daemonToken';
import { PLANNER_TOOLS, READ_ONLY_TASK_TOOLS, TASK_TOOLS, type McpTool, type PlannerToolHandler, type TaskToolHandler } from './tools';

/**
 * The Ordewell MCP server (ADR-0022): one loopback listener per process,
 * shared by every session in it, where the caller's token alone decides which
 * tools it sees and which session and task its calls reach.
 */

export const ORDEWELL_MCP_PATH = '/mcp';

/**
 * Claude Code aborts an HTTP MCP tool call that has sent neither a response nor
 * a progress notification for CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (300s unless
 * set; a per-server `timeout` or the variable raises it, 0 disables), and
 * no other limit bites a person-length wait — its hard cap on a call defaults
 * to 1e8 ms. A progress notification resets the idle clock, so a call that
 * waits on a person heartbeats well inside that default instead of asking
 * every user to reconfigure their runner (checked against Claude Code 2.1.289).
 */
const DEFAULT_HEARTBEAT_MS = 30_000;

export interface OrdewellMcpServerOptions {
  /** How often a call that is still waiting tells its caller so. */
  heartbeatMs?: number;
}

export interface TaskTokenScope {
  sessionId: string;
  taskId: string;
  /** The attempt generation the token is good for; a later attempt gets a new token. */
  attempt: number;
  /** A read-only task's attempt (ADR-0046): its token lists `run_command`, `fetch` and `web_search` too, and no other task's does. */
  readOnly?: boolean;
}

export interface PlannerTokenScope {
  sessionId: string;
  /**
   * Planner tools this token neither lists nor serves, by their names on the
   * server: the ones a runner carries natively instead (ADR-0027), which a
   * model would otherwise pick over its own.
   */
  hidden?: readonly string[];
}

/** Where a runner reaches the server and what it presents there. Never put either half in a prompt. */
export interface McpCredential {
  url: string;
  token: string;
  /** The planner tools the token hides ({@link PlannerTokenScope.hidden}), so the runner is told of and pre-allows only what it is served. */
  hidden?: readonly string[];
  /** The token serves a read-only task's tools ({@link TaskTokenScope.readOnly}), so the runner is told of and pre-allows `run_command`, `fetch` and `web_search`. */
  readOnly?: true;
}

/**
 * Why the server refused a request before any tool ran, kept apart in the
 * count so a planner that lost its link can be told from one that never had
 * one: an unknown token is a stale URL or a client that was never issued one,
 * a revoked token is a session that ended or a process that was respawned, and
 * a wrong path is a client pointed somewhere other than `/mcp`.
 */
export type McpRefusal = 'unknownToken' | 'revokedToken' | 'wrongPath';

/**
 * How many revoked tokens are remembered so one is told apart from a token
 * that never existed. A daemon runs for days and revokes one per attempt;
 * beyond this many, an old one is counted as unknown instead of holding every
 * token it ever issued.
 */
const REVOKED_TOKENS_KEPT = 1024;

/** What a refusal says in the log. Never the token. */
const REFUSAL_TEXT: Record<McpRefusal, string> = {
  unknownToken: 'unknown token',
  revokedToken: 'revoked token — its session ended or its process was respawned',
  wrongPath: `wrong path (the server serves ${ORDEWELL_MCP_PATH} only)`,
};

/**
 * A token's calls in flight, by request id. Stateless, a caller's
 * cancellation arrives as a request of its own, which finds the call it names
 * only here; a reused id cancels every call of the token that carries it.
 */
type InFlight = Map<string, Set<AbortController>>;

type Grant =
  | { role: 'task'; scope: TaskTokenScope; handler: TaskToolHandler; revoked: AbortController; calls: InFlight }
  | { role: 'planner'; scope: PlannerTokenScope; handler: PlannerToolHandler; revoked: AbortController; calls: InFlight };

export class OrdewellMcpServer {
  private readonly grants = new Map<string, Grant>();
  /** Recently revoked tokens, so a request carrying one is told from a token that never existed. */
  private readonly revokedTokens = new Set<string>();
  private readonly refused: Record<McpRefusal, number> = { unknownToken: 0, revokedToken: 0, wrongPath: 0 };
  private http: Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private boundHost: string | undefined;
  private readonly heartbeatMs: number;

  constructor(options: OrdewellMcpServerOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  /** The listener's URL, once the first token has started it. */
  get url(): string | undefined {
    return this.boundUrl;
  }

  /**
   * How many requests this server refused, by reason, since it started. What
   * makes a planner whose tools went dead visible after the fact; no token,
   * path or header is kept here.
   */
  refusals(): Readonly<Record<McpRefusal, number>> {
    return { ...this.refused };
  }

  async issueTaskToken(scope: TaskTokenScope, handler: TaskToolHandler = {}): Promise<McpCredential> {
    const credential = await this.issue({ role: 'task', scope: { ...scope }, handler, revoked: new AbortController(), calls: new Map() });
    return scope.readOnly ? { ...credential, readOnly: true } : credential;
  }

  async issuePlannerToken(scope: PlannerTokenScope, handler: PlannerToolHandler = {}): Promise<McpCredential> {
    const hidden = [...(scope.hidden ?? [])];
    const credential = await this.issue({ role: 'planner', scope: { ...scope, hidden }, handler, revoked: new AbortController(), calls: new Map() });
    return hidden.length > 0 ? { ...credential, hidden } : credential;
  }

  /** Every token still good here: secrets the outbound check keeps out of a URL (ADR-0027). */
  heldTokens(): string[] {
    return [...this.grants.keys()];
  }

  /** Refuse every later request carrying `token`, and abort the calls it has in flight. */
  revoke(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    this.revokedTokens.add(token);
    if (this.revokedTokens.size > REVOKED_TOKENS_KEPT) {
      const oldest = this.revokedTokens.values().next();
      if (!oldest.done) this.revokedTokens.delete(oldest.value);
    }
    grant.revoked.abort();
  }

  async dispose(): Promise<void> {
    for (const token of [...this.grants.keys()]) this.revoke(token);
    // Nothing can connect once the listener closes, so the diagnostic history
    // is not worth holding every token the server ever issued for.
    this.revokedTokens.clear();
    const http = this.http;
    this.http = undefined;
    this.listening = undefined;
    this.boundUrl = undefined;
    this.boundHost = undefined;
    if (!http) return;
    // A checkpoint call holds its response open for as long as a person takes
    // to answer; close() alone would wait on it.
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private async issue(grant: Grant): Promise<McpCredential> {
    const url = await this.start();
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, grant);
    return { url, token };
  }

  private start(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      const http = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) reply(res, 500, 'Internal error');
          else res.destroy();
        });
      });
      http.once('error', (err) => {
        this.listening = undefined;
        reject(err);
      });
      http.listen(0, '127.0.0.1', () => {
        const address = http.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Ordewell MCP server bound to no TCP port'));
          return;
        }
        this.boundHost = `127.0.0.1:${address.port}`;
        this.boundUrl = `http://${this.boundHost}${ORDEWELL_MCP_PATH}`;
        resolve(this.boundUrl);
      });
      // The listener serves the sessions in this process; it should never be
      // the reason the process stays alive after they are gone.
      http.unref();
      this.http = http;
    });
    return this.listening;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a web page can make the browser send to this port under a
    // hostname it controls, but it cannot forge Host or drop Origin (ADR-0022, T2).
    if (req.headers.host !== this.boundHost || req.headers.origin !== undefined) {
      reply(res, 403, 'Forbidden');
      return;
    }
    const token = extractPresentedToken({ authorization: req.headers.authorization });
    const grant = token === undefined ? undefined : this.grants.get(token);
    if (!grant) {
      this.refuse(res, token !== undefined && this.revokedTokens.has(token) ? 'revokedToken' : 'unknownToken', 401, 'Unauthorized');
      return;
    }
    if (new URL(req.url ?? '/', `http://${this.boundHost}`).pathname !== ORDEWELL_MCP_PATH) {
      this.refuse(res, 'wrongPath', 404, 'Not found');
      return;
    }

    // Stateless: a fresh server per request, built from the grant, so the tool
    // list and every call are fixed by the token on that very request.
    const mcp = new McpProtocolServer({ name: 'ordewell', version: '1' }, { capabilities: { tools: {} } });
    if (grant.role === 'task') serveTools(mcp, grant.scope.readOnly ? READ_ONLY_TASK_TOOLS : TASK_TOOLS, taskInventory(grant.scope.readOnly), grant.handler, grant, this.heartbeatMs);
    else serveTools(mcp, PLANNER_TOOLS.filter((tool) => !grant.scope.hidden?.includes(tool.name)), plannerInventory(grant.scope.hidden ?? []), grant.handler, grant, this.heartbeatMs);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  /** Count one refusal, and say the first of its kind once: a runner retrying a dead token must not flood the log. */
  private refuse(res: ServerResponse, reason: McpRefusal, status: number, message: string): void {
    this.refused[reason] += 1;
    if (this.refused[reason] === 1) console.warn(`[ordewell-mcp] refused a request: ${REFUSAL_TEXT[reason]}`);
    reply(res, status, message);
  }
}

/**
 * What one token serves and what it withholds, for the reply to a call that
 * names a tool the token cannot run: the enabled tools first, then every
 * disabled one with its reason, so the caller can mend the call in one try.
 */
interface ToolInventory {
  served: readonly string[];
  withheld: readonly { name: string; reason: string }[];
}

/** `ordewell_<tool>` and `mcp__ordewell__<tool>`: the prefixes runners put on the server's tools (agentTools.ts). */
const RUNNER_TOOL_PREFIX = /^(?:mcp__ordewell__|ordewell_)/;

const disabledLine = (withheld: readonly { name: string; reason: string }[]): string => {
  const byReason = new Map<string, string[]>();
  for (const { name, reason } of withheld) byReason.set(reason, [...(byReason.get(reason) ?? []), name]);
  return [...byReason].map(([reason, names]) => `${names.join(', ')} (${reason})`).join('; ');
};

/** The reply to a call for a tool this token does not serve, with the enabled and disabled lists at the top. */
function unknownToolMessage(called: string, inventory: ToolInventory): string {
  const withheld = inventory.withheld.find((w) => w.name === called);
  const lines = [
    withheld
      ? `Invocation error: '${called}' is disabled on this token: ${withheld.reason}.`
      : `Invocation error: unknown tool '${called}'.`,
    `Enabled: ${inventory.served.join(', ')}`,
    `Disabled: ${disabledLine(inventory.withheld)}`,
  ];
  const bare = called.replace(RUNNER_TOOL_PREFIX, '');
  if (bare !== called && inventory.served.includes(bare)) {
    lines.push(`This server names its tools without a runner's prefix: call '${bare}'.`);
  }
  return lines.filter((line) => line.length > 0).join('\n');
}

/** A task token's inventory: its own tools, and the planner tools it is refused. */
function taskInventory(readOnly?: boolean): ToolInventory {
  const served = (readOnly ? READ_ONLY_TASK_TOOLS : TASK_TOOLS).map((t) => t.name);
  const candidates = [...PLANNER_TOOLS, ...TASK_TOOLS, ...READ_ONLY_TASK_TOOLS];
  const withheld = [...new Set(candidates.map((t) => t.name))].filter((name) => !served.includes(name));
  return { served, withheld: withheld.map((name) => ({ name, reason: READ_ONLY_TASK_TOOLS.some((t) => t.name === name) ? 'read-only tasks only' : TASK_TOOLS.some((t) => t.name === name) ? 'change tasks only' : 'planner tokens only' })) };
}

function plannerInventory(hidden: readonly string[]): ToolInventory {
  const served = PLANNER_TOOLS.map((t) => t.name).filter((name) => !hidden.includes(name));
  const taskNames = [...new Set([...TASK_TOOLS, ...READ_ONLY_TASK_TOOLS].map((t) => t.name))];
  return {
    served,
    withheld: [
      ...taskNames.filter((name) => !PLANNER_TOOLS.some((t) => t.name === name)).map((name) => ({ name, reason: 'task tokens only' })),
      ...PLANNER_TOOLS.filter((t) => hidden.includes(t.name)).map((t) => ({ name: t.name, reason: 'your runner carries its own' })),
    ],
  };
}

function serveTools<H>(mcp: McpProtocolServer, tools: readonly McpTool<H>[], inventory: ToolInventory, handler: H, { revoked, calls }: Pick<Grant, 'revoked' | 'calls'>, heartbeatMs: number): void {
  mcp.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
    if (params.requestId === undefined) return;
    for (const call of calls.get(String(params.requestId)) ?? []) call.abort();
  });

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, unknownToolMessage(request.params.name, inventory));
    const progressToken = request.params._meta?.progressToken;
    const id = String(extra.requestId);
    const cancelled = new AbortController();
    const same = calls.get(id) ?? new Set();
    calls.set(id, same.add(cancelled));
    let beats = 0;
    const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
      beats += 1;
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: beats } }).catch(() => undefined);
    }, heartbeatMs);
    try {
      const result = await tool.call(handler, request.params.arguments, { signal: AbortSignal.any([revoked.signal, extra.signal, cancelled.signal]) });
      return { content: [{ type: 'text', text: result.text }], isError: result.isError ?? false };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    } finally {
      clearInterval(heartbeat);
      same.delete(cancelled);
      if (same.size === 0 && calls.get(id) === same) calls.delete(id);
    }
  });
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(message);
}

let shared: OrdewellMcpServer | undefined;

/** The process's one server, which the daemon and the extension host hand to every session they build. */
export function sharedMcpServer(): OrdewellMcpServer {
  shared ??= new OrdewellMcpServer();
  return shared;
}
