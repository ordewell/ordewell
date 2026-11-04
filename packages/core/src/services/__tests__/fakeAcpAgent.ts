import type { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LineBuffer } from '../harness/AgentAdapter';
import {
  ACP_ERROR,
  cancelNotificationSchema,
  closeSessionRequestSchema,
  initializeRequestSchema,
  loadSessionRequestSchema,
  newSessionRequestSchema,
  parseAcp,
  promptRequestSchema,
  resumeSessionRequestSchema,
  setConfigOptionRequestSchema,
  setModeRequestSchema,
  type AcpRpcError,
} from '../harness/acpSchema';
import { fakeSpawn, type FakeAgentProcess, type FakeSpawnOptions, type FakeSpawnResult } from './harnessTestKit';

/**
 * A scripted ACP agent, for tests of what drives one. It sits behind a
 * {@link FakeAgentProcess}'s stdin and stdout and speaks JSON-RPC lines, the
 * way `fakeSpawn` stands in for the other runners' processes.
 *
 * The script is a list of steps, run in order:
 *  - `expect` waits for the client to send a method, then answers it at once
 *    (`reply` or `error`), or leaves it open for a later `answer` or `fail`,
 *    which is how updates are sent between a prompt and its response.
 *  - `notify` and `request` are the agent speaking first; a `request` holds
 *    the script until the client answers it.
 *  - `callMcp` is the agent calling a tool on the MCP server the client gave it
 *    in `session/new`, with the headers it was given there.
 *  - `together` writes its answers and notifications as one stdout chunk,
 *    the way an agent's reply and the update after it can share a read.
 *  - `run` is anything else a test needs to do at that point.
 *
 * A message that is not the expected one is recorded in `unexpected` and a
 * request among them is answered "method not found", so a client that goes off
 * script fails visibly instead of hanging. A request whose params do not fit
 * the schema is recorded in `invalid` and answered "invalid params".
 */

export type FakeAcpValue<T> = T | ((params: unknown, agent: FakeAcpAgent) => T);

export type FakeAcpStep =
  | { expect: string; reply?: FakeAcpValue<unknown>; error?: AcpRpcError }
  | { answer: FakeAcpValue<unknown>; to?: string }
  | { fail: AcpRpcError; to?: string }
  | { notify: string; params?: FakeAcpValue<unknown> }
  | { request: string; params?: FakeAcpValue<unknown> }
  | { together: ReadonlyArray<Extract<FakeAcpStep, { answer: unknown } | { fail: AcpRpcError } | { notify: string }>> }
  | { callMcp: { tool: string; args?: Record<string, unknown>; server?: string } }
  | { run: (agent: FakeAcpAgent) => void | Promise<void> };

/** A message the client sent: a request when it has an `id`, a notification when it has none. */
export interface FakeAcpReceived {
  method: string;
  params: unknown;
  id?: number | string;
}

/** What the client answered to a request the agent sent. */
export interface FakeAcpAnswer {
  method: string;
  result?: unknown;
  error?: AcpRpcError;
}

export interface FakeAcpMcpCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface FakeAcpMcpServer {
  type?: string;
  name: string;
  url: string;
  headers: Record<string, string>;
}

const REQUEST_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  initialize: initializeRequestSchema,
  'session/new': newSessionRequestSchema,
  'session/load': loadSessionRequestSchema,
  'session/resume': resumeSessionRequestSchema,
  'session/close': closeSessionRequestSchema,
  'session/prompt': promptRequestSchema,
  'session/cancel': cancelNotificationSchema,
  'session/set_mode': setModeRequestSchema,
  'session/set_config_option': setConfigOptionRequestSchema,
};

interface Inbound {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: AcpRpcError;
}

export class FakeAcpAgent {
  /** Everything the client sent that the script took, in order. */
  readonly received: FakeAcpReceived[] = [];
  /** What the client answered to each request the agent sent. */
  readonly answers: FakeAcpAnswer[] = [];
  /** Messages the script was not expecting. */
  readonly unexpected: FakeAcpReceived[] = [];
  /** Requests whose params did not fit the ACP schema, with why. */
  readonly invalid: Array<FakeAcpReceived & { error: string }> = [];
  readonly mcpCalls: FakeAcpMcpCall[] = [];
  /** Steps that could not run: an answer with nothing to answer, an MCP call that threw. */
  readonly problems: string[] = [];

  private pc = 0;
  private proc: FakeAgentProcess | undefined;
  private readonly lines = new LineBuffer();
  private readonly inbox: Inbound[] = [];
  private readonly open: Array<{ id: number | string; method: string }> = [];
  private readonly sentRequests = new Map<number, string>();
  private readonly asked = new Map<number, (answer: FakeAcpAnswer) => void>();
  private nextId = 1;
  private awaiting: number | undefined;
  private pumping = false;
  private repump = false;
  private last: unknown;
  /** The lines a `together` step is collecting into its one chunk. */
  private chunk: string[] | undefined;
  private client: Client | undefined;
  private finish!: () => void;
  /** Resolves when the script has run to its end. */
  readonly finished: Promise<void> = new Promise((resolve) => { this.finish = resolve; });

  constructor(private readonly steps: readonly FakeAcpStep[]) {
    if (steps.length === 0) this.finish();
  }

  /** Start answering on `proc`: its stdin is read here and its stdout is written. */
  attach(proc: FakeAgentProcess): void {
    this.proc = proc;
    proc.on('__written', (chunk: string) => {
      this.lines.push(chunk, (line) => this.receive(line));
    });
    // A script may begin with the agent speaking first.
    queueMicrotask(() => this.pump());
  }

  /** Whether every step has run. */
  get done(): boolean {
    return this.pc >= this.steps.length && this.awaiting === undefined;
  }

  /** The params of the last request or notification the script took, for a step that echoes them. */
  get lastParams(): unknown {
    return this.last;
  }

  /** The MCP servers the client gave in `session/new` (or `load`, or `resume`), the last time it did. */
  get mcpServers(): FakeAcpMcpServer[] {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const entry = this.received[i];
      if (!['session/new', 'session/load', 'session/resume'].includes(entry.method)) continue;
      const servers = (entry.params as { mcpServers?: Array<{ type?: string; name: string; url?: string; headers?: Array<{ name: string; value: string }> }> }).mcpServers ?? [];
      return servers.flatMap((s) =>
        s.url === undefined ? [] : [{ ...(s.type ? { type: s.type } : {}), name: s.name, url: s.url, headers: Object.fromEntries((s.headers ?? []).map((h) => [h.name, h.value])) }]);
    }
    return [];
  }

  /** The requests received under `method`, in order. */
  requests(method: string): FakeAcpReceived[] {
    return this.received.filter((m) => m.method === method);
  }

  /** The agent sends a notification now, outside the script. */
  send(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** The agent sends a request now, outside the script; resolves with what the client answered. */
  ask(method: string, params?: unknown): Promise<FakeAcpAnswer> {
    const id = this.nextId++;
    this.sentRequests.set(id, method);
    const answer = new Promise<FakeAcpAnswer>((resolve) => this.asked.set(id, resolve));
    this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return answer;
  }

  /** Connect to the MCP server given in `session/new` and list its tools, the way an agent that attaches eagerly does. */
  async listMcpTools(server = 'ordewell'): Promise<string[]> {
    const client = await this.mcpClient(server);
    return (await client.listTools()).tools.map((tool) => tool.name);
  }

  /** Call a tool on the MCP server given in `session/new`, sending the headers it was given there. */
  async callMcp(tool: string, args: Record<string, unknown> = {}, server = 'ordewell'): Promise<unknown> {
    const result = await (await this.mcpClient(server)).callTool({ name: tool, arguments: args });
    this.mcpCalls.push({ tool, args, result });
    return result;
  }

  private async mcpClient(server: string): Promise<Client> {
    const config = this.mcpServers.find((s) => s.name === server && s.type === 'http');
    if (!config) throw new Error(`session/new gave no http MCP server named "${server}"`);
    this.client ??= await connect(config);
    return this.client;
  }

  /** Release the MCP connection and end the process, as the agent exiting does. */
  async close(code = 0): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.proc?.exit(code);
  }

  private receive(line: string): void {
    let message: Inbound;
    try { message = JSON.parse(line) as Inbound; } catch { return; }
    if (message.method === undefined && message.id !== undefined) {
      const method = this.sentRequests.get(Number(message.id));
      if (method === undefined) return;
      this.sentRequests.delete(Number(message.id));
      const answer: FakeAcpAnswer = { method, ...(message.error ? { error: message.error } : { result: message.result }) };
      this.answers.push(answer);
      this.asked.get(Number(message.id))?.(answer);
      this.asked.delete(Number(message.id));
      if (this.awaiting === Number(message.id)) {
        this.awaiting = undefined;
        this.pc++;
      }
    } else {
      this.inbox.push(message);
    }
    this.pump();
  }

  private pump(): void {
    // A step can write, and the write can bring the next message: run again
    // after the current pass rather than inside it.
    if (this.pumping) { this.repump = true; return; }
    this.pumping = true;
    void this.run().finally(() => {
      this.pumping = false;
      if (this.repump) { this.repump = false; this.pump(); }
    });
  }

  private async run(): Promise<void> {
    while (this.pc < this.steps.length) {
      const step = this.steps[this.pc];
      if ('expect' in step) {
        if (!this.takeExpected(step)) return;
      } else if ('answer' in step || 'fail' in step) {
        this.answerOpen(step);
      } else if ('notify' in step) {
        this.send(step.notify, this.value(step.params));
      } else if ('together' in step) {
        this.chunk = [];
        for (const part of step.together) {
          if ('notify' in part) this.send(part.notify, this.value(part.params));
          else this.answerOpen(part);
        }
        const lines = this.chunk.join('');
        this.chunk = undefined;
        this.proc?.emitStdout(lines);
      } else if ('request' in step) {
        if (this.awaiting !== undefined) return;
        const id = this.nextId++;
        this.sentRequests.set(id, step.request);
        this.awaiting = id;
        this.write({ jsonrpc: '2.0', id, method: step.request, ...(step.params !== undefined ? { params: this.value(step.params) } : {}) });
        return;
      } else if ('callMcp' in step) {
        try { await this.callMcp(step.callMcp.tool, step.callMcp.args, step.callMcp.server); } catch (error) { this.problems.push(`callMcp ${step.callMcp.tool}: ${error instanceof Error ? error.message : String(error)}`); }
      } else {
        try { await step.run(this); } catch (error) { this.problems.push(`run: ${error instanceof Error ? error.message : String(error)}`); }
      }
      this.pc++;
    }
    if (this.awaiting === undefined) this.finish();
  }

  /** Take the message the step waits for; false when it has not come, and the script waits. */
  private takeExpected(step: Extract<FakeAcpStep, { expect: string }>): boolean {
    for (;;) {
      const message = this.inbox.shift();
      if (!message) return false;
      const received: FakeAcpReceived = { method: message.method ?? '', params: message.params, ...(message.id !== undefined ? { id: message.id } : {}) };
      if (message.method !== step.expect) {
        this.unexpected.push(received);
        if (message.id !== undefined) this.respond(message.id, undefined, { code: ACP_ERROR.methodNotFound, message: `Method not found: ${received.method}` });
        continue;
      }
      const schema = REQUEST_SCHEMAS[step.expect];
      const checked = schema ? parseAcp(schema, message.params) : undefined;
      if (checked && !checked.ok) {
        this.invalid.push({ ...received, error: checked.error });
        if (message.id !== undefined) this.respond(message.id, undefined, { code: ACP_ERROR.invalidParams, message: `Invalid params: ${checked.error}` });
        continue;
      }
      this.received.push(received);
      this.last = message.params;
      if (message.id === undefined) return true;
      if (step.error) this.respond(message.id, undefined, step.error);
      else if (step.reply !== undefined) this.respond(message.id, this.value(step.reply));
      else this.open.push({ id: message.id, method: step.expect });
      return true;
    }
  }

  private answerOpen(step: Extract<FakeAcpStep, { answer: unknown } | { fail: AcpRpcError }>): void {
    const index = this.open.findIndex((r) => step.to === undefined || r.method === step.to);
    if (index < 0) {
      this.problems.push(`no open request${step.to ? ` for ${step.to}` : ''} to answer`);
      return;
    }
    const [{ id }] = this.open.splice(index, 1);
    if ('fail' in step) this.respond(id, undefined, step.fail);
    else this.respond(id, this.value(step.answer));
  }

  private value<T>(v: FakeAcpValue<T> | undefined): T {
    return (typeof v === 'function' ? (v as (p: unknown, a: FakeAcpAgent) => T)(this.last, this) : v) as T;
  }

  private respond(id: number | string, result: unknown, error?: AcpRpcError): void {
    this.write({ jsonrpc: '2.0', id, ...(error ? { error } : { result: result ?? null }) });
  }

  private write(message: object): void {
    const line = `${JSON.stringify(message)}\n`;
    if (this.chunk) this.chunk.push(line);
    else this.proc?.emitStdout(line);
  }
}

async function connect(config: FakeAcpMcpServer): Promise<Client> {
  const client = new Client({ name: 'fake-acp-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  return client;
}

/**
 * A spawn the scripted agent answers behind: pass `spawn` to the code under
 * test, and read what it sent from `agent`. Each process spawned is attached to
 * the one agent, so a script covers a single launch.
 */
export function fakeAcpSpawn(steps: readonly FakeAcpStep[], options: FakeSpawnOptions = {}): FakeSpawnResult & { agent: FakeAcpAgent } {
  const agent = new FakeAcpAgent(steps);
  const kit = fakeSpawn([], options);
  const spawn: FakeSpawnResult['spawn'] = (...args) => {
    const proc = kit.spawn(...args);
    agent.attach(proc as unknown as FakeAgentProcess);
    return proc;
  };
  return { ...kit, spawn, agent };
}
