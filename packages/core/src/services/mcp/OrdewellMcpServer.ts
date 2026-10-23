import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
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
  /** A read-only task's attempt (ADR-0046): its token lists `run_command` too, and no other task's does. */
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
  /** The token serves a read-only task's tools ({@link TaskTokenScope.readOnly}), so the runner is told of and pre-allows `run_command`. */
  readOnly?: true;
}

type Grant =
  | { role: 'task'; scope: TaskTokenScope; handler: TaskToolHandler; revoked: AbortController }
  | { role: 'planner'; scope: PlannerTokenScope; handler: PlannerToolHandler; revoked: AbortController };

export class OrdewellMcpServer {
  private readonly grants = new Map<string, Grant>();
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

  async issueTaskToken(scope: TaskTokenScope, handler: TaskToolHandler = {}): Promise<McpCredential> {
    const credential = await this.issue({ role: 'task', scope: { ...scope }, handler, revoked: new AbortController() });
    return scope.readOnly ? { ...credential, readOnly: true } : credential;
  }

  async issuePlannerToken(scope: PlannerTokenScope, handler: PlannerToolHandler = {}): Promise<McpCredential> {
    const hidden = [...(scope.hidden ?? [])];
    const credential = await this.issue({ role: 'planner', scope: { ...scope, hidden }, handler, revoked: new AbortController() });
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
    grant.revoked.abort();
  }

  async dispose(): Promise<void> {
    for (const token of [...this.grants.keys()]) this.revoke(token);
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
      reply(res, 401, 'Unauthorized');
      return;
    }
    if (new URL(req.url ?? '/', `http://${this.boundHost}`).pathname !== ORDEWELL_MCP_PATH) {
      reply(res, 404, 'Not found');
      return;
    }

    // Stateless: a fresh server per request, built from the grant, so the tool
    // list and every call are fixed by the token on that very request.
    const mcp = new McpProtocolServer({ name: 'ordewell', version: '1' }, { capabilities: { tools: {} } });
    if (grant.role === 'task') serveTools(mcp, grant.scope.readOnly ? READ_ONLY_TASK_TOOLS : TASK_TOOLS, taskInventory(grant.scope.readOnly), grant.handler, grant.revoked.signal, this.heartbeatMs);
    else serveTools(mcp, PLANNER_TOOLS.filter((tool) => !grant.scope.hidden?.includes(tool.name)), plannerInventory(grant.scope.hidden ?? []), grant.handler, grant.revoked.signal, this.heartbeatMs);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
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
  if (bare !== called && (inventory.served.includes(bare) || inventory.withheld.some((w) => w.name === bare))) {
    lines.push(`This server names its tools without a runner's prefix: call '${bare}'.`);
  }
  return lines.filter((line) => line.length > 0).join('\n');
}

/** A task token's inventory: its own tools, and the planner tools it is refused. */
function taskInventory(readOnly?: boolean): ToolInventory {
  return {
    served: (readOnly ? READ_ONLY_TASK_TOOLS : TASK_TOOLS).map((t) => t.name),
    // run_command is the one tool a writing task is refused for a different reason than the rest (ADR-0046).
    withheld: PLANNER_TOOLS.map((t) => ({ name: t.name, reason: t.name === 'run_command' && !readOnly ? 'read-only tasks only' : 'planner tokens only' })),
  };
}

/** A planner token's inventory: its tools less the ones its runner carries natively (ADR-0027), and the task tools it is refused. */
function plannerInventory(hidden: readonly string[]): ToolInventory {
  return {
    served: PLANNER_TOOLS.map((t) => t.name).filter((name) => !hidden.includes(name)),
    withheld: [
      ...TASK_TOOLS.map((t) => ({ name: t.name, reason: 'task tokens only' })),
      ...hidden.map((name) => ({ name, reason: 'your runner carries its own' })),
    ],
  };
}

function serveTools<H>(mcp: McpProtocolServer, tools: readonly McpTool<H>[], inventory: ToolInventory, handler: H, revoked: AbortSignal, heartbeatMs: number): void {
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, unknownToolMessage(request.params.name, inventory));
    const progressToken = request.params._meta?.progressToken;
    let beats = 0;
    const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
      beats += 1;
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: beats } }).catch(() => undefined);
    }, heartbeatMs);
    try {
      const result = await tool.call(handler, request.params.arguments, { signal: AbortSignal.any([revoked, extra.signal]) });
      return { content: [{ type: 'text', text: result.text }], isError: result.isError ?? false };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    } finally {
      clearInterval(heartbeat);
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
