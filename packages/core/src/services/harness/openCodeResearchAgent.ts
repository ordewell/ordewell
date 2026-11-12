import { randomBytes } from 'crypto';
import { promises as fsp, rmSync } from 'fs';
import { homedir as osHomedir, tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { CONFINED_RESEARCH_TOOLS, SUBAGENT_LIMITS, confinedRead, describeCall, partialDigest } from '../ResearchSubagents';
import { classifyOutcome } from '../researchStepSummary';
import { parseCliVersion } from '../RunnerInstallation';
import { addUsage, type UsageTotals } from '../../models/Usage';
import type { ResearchProgress, ResearchStep } from '../../models/Task';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { McpCredential, McpToolContext, McpToolReply, OrdewellMcpServer, SpawnResearchAgentArgs } from '../mcp';
import { onHostTeardown } from '../../utils/processTree';
import { openEventStream, usageRecord, withDeadline, REQUEST_TIMEOUT_MS, type EventStream, type OpenCodeTokens } from './openCodeTransport';
import { NO_TURN_OPEN, semaphore } from './harnessResearchAgent';
import { RunnerProcess } from './runnerProcess';
import type { AgentProcessDeps } from './AgentAdapter';
import { SERVER_USERNAME } from './OpenCodeAdapter';

/*
 * The research agent an OpenCode 2.x planner gets by default (ADR-0066): it
 * runs on the user's own OpenCode login and the planner's model, with no key,
 * bill or setting of its own. Each planner session gets one second
 * `opencode serve`, started on the first call and reused, that:
 *
 *  - shares only the user's data directory (where OpenCode keeps the login)
 *    and is never handed, nor reads, a credential itself;
 *  - has a throwaway config, home and state, with project config off, so no
 *    user or project MCP server, plugin, agent, skill or permission reaches it;
 *  - has one MCP server, `ordewell`, behind a research token that serves the
 *    six workspace reads and nothing else;
 *  - denies every tool by permission, then allows the six `ordewell_*` reads
 *    by exact name, in the config and again on each session (session rules
 *    are merged last and win: v2.2.7 session/context.ts), so OpenCode's tool
 *    snapshot drops every built-in, `execute` (code mode), `skill`,
 *    `subagent` and the `opencode_*` plugin tools before the model sees them.
 *
 * Before its first use the serve is checked through its own API: OpenCode
 * 2.x lists no session's tools, so it reads back what the serve loaded
 * (preUseCheck). A layer this host adds that Ordewell did not, such as an
 * administrator's managed config, makes the agent unavailable rather than
 * trusted. Fail closed on top: a tool call outside the six reads, or a child
 * session of the research session, interrupts it and fails the call; so does
 * an eleventh step.
 */

/** The server name the research token is exposed under; OpenCode names its tools `<server>_<tool>`. */
export const RESEARCH_MCP_SERVER = 'ordewell';

/** The only tool names the research session may be offered or may call. */
export function researchToolNames(): string[] {
  return [...CONFINED_RESEARCH_TOOLS].map((name) => `${RESEARCH_MCP_SERVER}_${name}`);
}

export interface PermissionRule { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

/** Deny everything, then allow the six reads by exact name: the last matching rule wins (v2.2.7 permission.ts). */
export function researchSessionRules(): PermissionRule[] {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...researchToolNames().map((action) => ({ action, resource: '*', effect: 'allow' as const })),
  ];
}

export interface ResearchMcp { url: string; token: string }

/** The research serve's whole configuration: nothing of the user's or the project's is layered under it. */
function researchServeConfig(mcp: ResearchMcp): Record<string, unknown> {
  return {
    mcp: { [RESEARCH_MCP_SERVER]: { type: 'remote', url: mcp.url, headers: { authorization: `Bearer ${mcp.token}` }, enabled: true } },
    permissions: researchSessionRules(),
    lsp: false,
    experimental: { location_idle_timeout: false },
  };
}

/**
 * What the research serve's environment sets over the user's. OpenCode finds
 * the login in its data directory (`$XDG_DATA_HOME/opencode`, `opencode.db`),
 * so that one root stays the user's; config, home and state are the scratch
 * directory's, so none of the user's global config, agents, skills or plugins
 * load. The cache stays the user's so model metadata is not fetched again.
 */
export function researchServeEnv(user: Record<string, string | undefined>, opts: { scratch: string; mcp: ResearchMcp; password: string }): Record<string, string> {
  const home = user.HOME || user.USERPROFILE || osHomedir();
  return {
    HOME: join(opts.scratch, 'home'),
    USERPROFILE: join(opts.scratch, 'home'),
    XDG_CONFIG_HOME: join(opts.scratch, 'config'),
    XDG_STATE_HOME: join(opts.scratch, 'state'),
    OPENCODE_CONFIG_DIR: join(opts.scratch, 'opencode-config'),
    XDG_DATA_HOME: user.XDG_DATA_HOME || join(home, '.local', 'share'),
    XDG_CACHE_HOME: user.XDG_CACHE_HOME || join(home, '.cache'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(researchServeConfig(opts.mcp)),
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: opts.password,
  };
}

/** Every user `OPENCODE_*` setting is one more config layer; `OPENCODE_DB` only says where the login is. */
const isUserOpenCodeSetting = (key: string) => {
  const name = key.toUpperCase();
  return name.startsWith('OPENCODE_') && name !== 'OPENCODE_DB';
};

export interface ResearchServe {
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  events(signal: AbortSignal): Promise<Response>;
  /** Settles when the process exits; a call still running fails with it. */
  readonly exited: Promise<string>;
  close(): Promise<void>;
}

export interface StartResearchServeOptions {
  /** The workspace: the serve starts there, under its variables (ADR-0016). */
  cwd: string;
  mcp: ResearchMcp;
  launch: AgentProcessDeps;
  /** `opencode` unless a test or the probe says otherwise. */
  command?: string;
  /** Put before `serve`, for a command that is an interpreter. */
  args?: string[];
  readyTimeoutMs?: number;
}

type Json = <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

/**
 * Start the locked-down serve, wait for its URL, check it is 2.x, expose the
 * research server outside code mode, and run the pre-use check. Any failure
 * stops the serve and throws why.
 */
export async function startResearchServe(opts: StartResearchServeOptions): Promise<ResearchServe> {
  const scratch = await fsp.mkdtemp(join(tmpdir(), 'ordewell-research-'));
  await Promise.all(['home', 'config', 'state', 'opencode-config'].map((dir) => fsp.mkdir(join(scratch, dir), { recursive: true })));
  const password = randomBytes(24).toString('base64url');
  const proc = new RunnerProcess(opts.launch);
  proc.withhold(password, opts.mcp.token);
  // The process group is already the host's to stop as it goes; the scratch
  // config holds the research token, so it goes too.
  const unhook = onHostTeardown(() => {
    proc.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });
  const close = async () => {
    unhook();
    proc.dispose();
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    let baseUrl = '';
    await proc.start(opts.cwd, (workspace) => ({
      command: opts.command ?? 'opencode',
      args: [...(opts.args ?? []), 'serve', '--hostname', '127.0.0.1', '--port', '0'],
      env: () => researchServeEnv({ ...process.env, ...workspace }, { scratch, mcp: opts.mcp, password }),
      envDrop: isUserOpenCodeSetting,
    }), () => new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('its OpenCode server did not start in time')), opts.readyTimeoutMs ?? 30_000);
      const stop = proc.readStdout((text) => {
        out += text;
        const found = /https?:\/\/[^\s]+/.exec(out);
        if (!found) return;
        clearTimeout(timer);
        stop();
        baseUrl = found[0].replace(/\/+$/, '');
        resolve();
      });
      void proc.ended.then(() => {
        clearTimeout(timer);
        reject(new Error(proc.withStderrTail(`its OpenCode server ${proc.describeExit()} before it was ready`)));
      });
    }));
    const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString('base64')}`;
    const json: Json = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
      const deadline = withDeadline(signal, REQUEST_TIMEOUT_MS);
      try {
        const res = await opts.launch.fetch(`${baseUrl}${path}`, {
          method,
          headers: { authorization, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(deadline.signal ? { signal: deadline.signal } : {}),
        });
        if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${proc.redact((await res.text()).slice(0, 300))}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      } finally { deadline.clear(); }
    };
    // A refusal (a 401 above all) must reach the planner's one-line reason with its status, not read as "no version".
    let info: { version?: unknown; data?: { version?: unknown } } | undefined;
    try { info = await json('GET', '/api/info'); } catch (err) { throw new Error(`its OpenCode server did not answer /api/info: ${errorLine(err)}`); }
    const version = info?.version ?? info?.data?.version;
    if (typeof version !== 'string' || !/^2\./.test(version)) throw new Error(`it needs OpenCode 2.x, and the serve reported ${typeof version === 'string' ? version : 'no version'}`);
    // As the planner's servers are: a config server is listed only inside code mode (OpenCodeV2.expose).
    await json('PUT', `/api/experimental/mcp/${RESEARCH_MCP_SERVER}`, { config: { type: 'remote', url: opts.mcp.url, headers: { authorization: `Bearer ${opts.mcp.token}` }, codemode: false } });
    await preUseCheck(json);
    return {
      json,
      events: (signal) => opts.launch.fetch(`${baseUrl}/api/event`, { signal, headers: { authorization } }),
      exited: proc.ended.then(() => proc.withStderrTail(`The research agent's OpenCode server ${proc.describeExit()}.`)),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

const errorLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const sameRules = (a: unknown[], b: PermissionRule[]) =>
  a.length === b.length && a.every((rule, i) => {
    const r = record(rule);
    return r?.action === b[i].action && r?.resource === b[i].resource && r?.effect === b[i].effect;
  });

/**
 * What the serve loaded, read back through its own API (ADR-0066). v2.2.7 has
 * no route listing a session's tools, so the check is the three things that
 * decide them: the permission rules of every config layer, in order, are
 * Ordewell's alone; Ordewell's is the only MCP server; and every plugin is one
 * of OpenCode's built-ins. Any other layer — an administrator's managed or
 * well-known config, an integration — fails it, without this host having to
 * know where such layers live. A read-back that cannot be read fails it too.
 */
async function preUseCheck(json: Json): Promise<void> {
  const read = (path: string) => json<unknown>('GET', path).catch((err: unknown) => { throw new Error(`its OpenCode server did not answer ${path}: ${errorLine(err)}`); });
  const entries = await read('/api/config');
  if (!Array.isArray(entries)) throw new Error('its OpenCode server\'s config could not be read back');
  const rules: unknown[] = [];
  for (const entry of entries) {
    const info = record(record(entry)?.info);
    if (!info) continue;
    if ('permission' in info) throw new Error('its OpenCode server loaded permission rules other than Ordewell\'s');
    if (info.permissions === undefined) continue;
    if (!Array.isArray(info.permissions)) throw new Error('its OpenCode server\'s permission rules could not be read back');
    rules.push(...info.permissions);
  }
  if (!sameRules(rules, researchSessionRules())) throw new Error('its OpenCode server loaded permission rules other than Ordewell\'s');

  const servers = record(await read('/api/mcp'))?.data;
  if (!Array.isArray(servers)) throw new Error('its OpenCode server\'s MCP servers could not be read back');
  const names = servers.map((server) => String(record(server)?.name ?? ''));
  const others = names.filter((name) => name !== RESEARCH_MCP_SERVER);
  if (others.length > 0) throw new Error(`its OpenCode server loaded MCP servers besides Ordewell's: ${others.join(', ')}`);
  if (!names.includes(RESEARCH_MCP_SERVER)) throw new Error('its OpenCode server did not load Ordewell\'s MCP server');

  const plugins = record(await read('/api/plugin'))?.data;
  if (!Array.isArray(plugins)) throw new Error('its OpenCode server\'s plugins could not be read back');
  const added = plugins.filter((plugin) => record(record(plugin)?.source)?.type !== 'builtin').map((plugin) => {
    const p = record(plugin);
    const source = record(p?.source);
    return String(p?.id ?? source?.target ?? source?.type ?? 'unnamed');
  });
  if (added.length > 0) throw new Error(`its OpenCode server loaded a plugin beyond OpenCode's built-ins: ${added.join(', ')}`);
}

/** One serve per planner session, started on the first call; a serve that died is started again on the next. */
export function lazyServe(start: () => Promise<ResearchServe>): { get(): Promise<ResearchServe>; close(): Promise<void> } {
  let current: Promise<ResearchServe> | undefined;
  let dead = false;
  return {
    get() {
      if (!current || dead) {
        dead = false;
        current = start();
        current.then((serve) => serve.exited.then(() => { dead = true; }), () => { current = undefined; });
      }
      return current;
    },
    async close() {
      const serve = await current?.catch(() => undefined);
      current = undefined;
      await serve?.close();
    },
  };
}

interface Frame {
  type?: string;
  data?: {
    sessionID?: string; parentID?: string; assistantMessageID?: string; id?: string; name?: string; text?: string;
    input?: Record<string, unknown>; content?: { type?: string; text?: string }[];
    error?: { type?: string; message?: string }; model?: { id?: string; providerID?: string };
    tokens?: OpenCodeTokens; cost?: number;
    /** On `session.usage.recorded`, the kind of call (a string); on a permission ask, the tool call (an object). */
    source?: unknown;
  };
}

export interface OpenCodeResearchAgentDeps {
  serve: () => Promise<ResearchServe>;
  /** The planner's model as `provider/model`; the agent runs on it. */
  model?: string;
  /** The OpenCode agent the session runs as; its rules come before the session's, which win. */
  agent?: string;
  instructions?: string;
  turnSink: () => ((progress: ResearchProgress) => void) | undefined;
  maxConcurrent?: number;
  maxSteps?: number;
  newId?: () => string;
  /** How long an interrupted session may take to say so before the call is given up. */
  interruptGraceMs?: number;
  /** Told when OpenCode cannot run the planner's model on this login at all, as opposed to failing one brief. */
  onUnusable?: (why: string) => void;
}

export const RESEARCH_INSTRUCTIONS = [
  'You are a read-only research agent for a planner. You can read the workspace with the ordewell read tools and nothing else:',
  'no shell, no edits, no web, no other agents. Answer the brief with a concise digest of what you found, citing file paths and lines.',
  'If the brief asks for anything you cannot do with these reads, say so in the digest instead of trying.',
].join(' ');

/** Errors that say the login or model is unusable, not that this one brief failed (v2.2.7 session errors). */
const UNUSABLE_ERRORS = new Set(['provider.auth', 'provider.no-route']);

const TITLE_WORDS = 8;
const TITLE_CHARS = 60;

/** So a research session in OpenCode's own session list reads as Ordewell's, and as which brief. */
export function researchTitle(brief: string): string {
  const words = brief.split(/\s+/).filter(Boolean);
  let title = words.slice(0, TITLE_WORDS).join(' ');
  let cut = words.length > TITLE_WORDS;
  if (title.length > TITLE_CHARS) { title = title.slice(0, TITLE_CHARS).trimEnd(); cut = true; }
  return `Ordewell research: ${title}${cut ? '…' : ''}`;
}

const splitModel = (model?: string) => {
  const at = model?.indexOf('/') ?? -1;
  return model && at > 0 ? { providerID: model.slice(0, at), id: model.slice(at + 1) } : undefined;
};

/** `spawn_research_agent`, answered by a session on the research serve. */
export function openCodeResearchAgent(deps: OpenCodeResearchAgentDeps): (args: SpawnResearchAgentArgs, context: McpToolContext) => Promise<McpToolReply> {
  const slot = semaphore(deps.maxConcurrent ?? SUBAGENT_LIMITS.maxConcurrent);
  const newId = deps.newId ?? uuidv4;
  return async ({ prompt }, { signal }) => {
    if (!deps.turnSink()) return { text: NO_TURN_OPEN, isError: true };
    return slot(signal, async () => {
      if (!deps.turnSink()) return { text: NO_TURN_OPEN, isError: true };
      return runOne(deps, prompt.trim(), newId(), signal);
    }, () => ({ text: '[research agent stopped before it started]', isError: true }));
  };
}

async function runOne(deps: OpenCodeResearchAgentDeps, brief: string, subagentId: string, signal: AbortSignal): Promise<McpToolReply> {
  const emit = (progress: ResearchProgress) => deps.turnSink()?.(progress);
  const allowed = new Set(researchToolNames());
  const maxSteps = deps.maxSteps ?? SUBAGENT_LIMITS.maxSteps;
  let usage: UsageTotals | undefined;
  const finish = (outcome: 'done' | 'stopped' | 'failed', digest: string): McpToolReply => {
    emit({ type: 'subagent_finished', subagentId, outcome, digest, usage });
    return outcome === 'done' ? { text: digest } : { text: digest, isError: true };
  };
  emit({ type: 'subagent_started', subagentId, brief, model: deps.model });

  let serve: ResearchServe;
  let sessionId: string;
  try {
    serve = await deps.serve();
    const model = splitModel(deps.model);
    const created = await serve.json<{ id?: string; data?: { id?: string } }>('POST', '/api/session', { title: researchTitle(brief), agent: deps.agent ?? 'plan', ...(model ? { model } : {}), permissions: researchSessionRules() }, signal);
    const id = created.data?.id ?? created.id;
    if (!id) throw new Error('OpenCode did not name the research session.');
    sessionId = id;
    await serve.json('PUT', `/api/experimental/session/${id}/instructions/entries/ordewell-research`, { value: deps.instructions ?? RESEARCH_INSTRUCTIONS }, signal);
  } catch (err) {
    return finish(signal.aborted ? 'stopped' : 'failed', `[research agent failed to start: ${err instanceof Error ? err.message : String(err)}]`);
  }

  let steps = 0;
  let lastText = '';
  let violation: string | undefined;
  let failure: string | undefined;
  let overran = false;
  const unread: string[] = [];
  let interrupted = false;
  const names = new Map<string, string>();
  const stepModels: string[] = [];
  let settle!: (how: 'succeeded' | 'failed' | 'interrupted') => void;
  const ended = new Promise<'succeeded' | 'failed' | 'interrupted'>((resolve) => { settle = resolve; });
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    serve.json('POST', `/api/session/${sessionId}/interrupt`).catch(() => undefined);
  };
  const trip = (why: string) => { violation ??= why; interrupt(); };
  const failed = (error: { type?: string; message?: string } | undefined) => {
    const why = error?.message ?? error?.type ?? 'OpenCode failed the research session';
    if (error?.type && UNUSABLE_ERRORS.has(error.type)) deps.onUnusable?.(`OpenCode could not run ${deps.model ?? 'the planner\'s model'} on this login (${error.type}: ${why})`);
    failure ??= why;
  };

  // A step reaches us as its end or its failure, never both, but a replayed stream repeats a frame.
  const counted = new Set<string>();
  const count = (data: NonNullable<Frame['data']>, call: { model?: string; purpose?: string }) => {
    if (data.assistantMessageID) {
      if (counted.has(data.assistantMessageID)) return;
      counted.add(data.assistantMessageID);
    }
    const record = usageRecord(data.tokens, { ...call, cost: data.cost, subagentId });
    if (!record) return;
    // A purpose takes the place of the subagent on a record, but the research call is whose spend it is.
    const attributed = { ...record, subagentId };
    usage = addUsage(usage ?? {}, attributed);
    emit({ type: 'usage', record: attributed });
  };

  const onFrame = (frame: Frame) => {
    const data = frame.data;
    if (!data || !frame.type) return;
    if (frame.type === 'session.created') {
      if (data.parentID === sessionId) trip(`it started a session of its own (${data.sessionID ?? 'unnamed'})`);
      return;
    }
    if (data.sessionID !== sessionId) return;
    switch (frame.type) {
      case 'session.step.started':
        steps += 1;
        if (data.model?.providerID && data.model.id) stepModels.push(`${data.model.providerID}/${data.model.id}`);
        if (steps > maxSteps) { overran = true; interrupt(); }
        return;
      case 'session.tool.input.started':
        if (data.id && data.name) names.set(data.id, data.name);
        if (data.name && !allowed.has(data.name)) trip(`it called ${data.name}, which is not one of its read tools`);
        return;
      case 'session.tool.called': {
        const name = (data.id && names.get(data.id)) ?? data.name ?? '';
        if (!allowed.has(name)) { trip(`it called ${name || 'an unnamed tool'}, which is not one of its read tools`); return; }
        if (overran) unread.push(describeCall(name.slice(RESEARCH_MCP_SERVER.length + 1), (data.input ?? {}) as Record<string, unknown>));
        emit({ type: 'tool_call', tool: name.slice(RESEARCH_MCP_SERVER.length + 1), toolArgs: JSON.stringify(data.input ?? {}), toolCallId: data.id, subagentId });
        return;
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const name = (data.id && names.get(data.id)) ?? '';
        const success = frame.type === 'session.tool.success';
        if (!allowed.has(name)) { if (success) trip(`${name || 'an unnamed tool'} ran`); return; }
        const output = success ? (data.content ?? []).map((part) => part.text ?? '').join('') : (data.error?.message ?? 'failed');
        const step: ResearchStep = {
          id: `subrs-${subagentId}-${Date.now()}-${steps}`,
          tool: name.slice(RESEARCH_MCP_SERVER.length + 1) as ResearchStep['tool'],
          args: '',
          result: output,
          success,
          outcome: classifyOutcome(success, output),
          subagentId,
          toolCallId: data.id,
          timestamp: new Date().toISOString(),
        };
        emit({ type: 'tool_result', toolResult: output, step, toolCallId: data.id, subagentId });
        return;
      }
      case 'session.text.ended':
        if (typeof data.text === 'string' && data.text.trim()) lastText = data.text;
        return;
      case 'session.step.ended':
        count(data, { model: stepModels.at(-1) ?? deps.model });
        return;
      // A call OpenCode bills outside any step, a compaction for one; `source` is a string only on this kind of frame.
      case 'session.usage.recorded':
        if (typeof data.source === 'string' && data.source) count(data, { purpose: data.source });
        return;
      case 'session.step.failed':
        // A finish that arrived together with the failure is a request the provider billed.
        count(data, { model: stepModels.at(-1) ?? deps.model });
        // OpenCode 2.x records an interrupt as the in-flight step failing ("Step interrupted",
        // MessageAbortedError). After Ordewell's own interrupt (budget, violation, cancel) that is
        // its echo, not a failure: counting it would turn every overrun's partial digest into one.
        if (interrupted) return;
        failed(data.error);
        return;
      case 'session.execution.succeeded': settle('succeeded'); return;
      case 'session.execution.failed': failed(data.error); settle('failed'); return;
      case 'session.execution.interrupted': settle('interrupted'); return;
    }
  };

  let stream: EventStream;
  try {
    stream = await openEventStream<Frame>((s) => serve.events(s), onFrame);
  } catch (err) {
    return finish('failed', `[research agent failed: its event stream did not open: ${err instanceof Error ? err.message : String(err)}]`);
  }
  const onAbort = () => interrupt();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    serve.json('POST', `/api/session/${sessionId}/prompt`, { text: brief }).catch((err: unknown) => {
      failure ??= `the brief was not accepted: ${err instanceof Error ? err.message : String(err)}`;
      settle('failed');
    });
    if (signal.aborted) interrupt();
    const grace = new Promise<'gone'>((resolve) => {
      const arm = () => { const t = setTimeout(() => resolve('gone'), deps.interruptGraceMs ?? 5_000); t.unref?.(); };
      if (signal.aborted) arm(); else signal.addEventListener('abort', arm, { once: true });
    });
    const how = await Promise.race([ended, stream.failed.then(() => 'lost' as const, () => 'lost' as const), serve.exited.then(() => 'lost' as const), grace]);
    if (violation) return finish('failed', `[research agent stopped: ${violation}. Nothing it found is used.]`);
    if (overran && !signal.aborted && !failure) {
      const found = (lastText || await readBack(serve, sessionId).catch(() => '')).trim();
      return finish('done', partialDigest(found, unread, maxSteps));
    }
    if (signal.aborted || (how === 'interrupted' && !failure)) return finish('stopped', '[research agent stopped]');
    if (how === 'lost') return finish('failed', '[research agent failed: its OpenCode server or event stream was lost]');
    if (failure) return finish('failed', `[research agent failed: ${failure}]`);
    const digest = (lastText || await readBack(serve, sessionId)).trim();
    if (!digest) return finish('failed', '[research agent returned no digest]');
    const max = SUBAGENT_LIMITS.digestMaxChars;
    return finish('done', digest.length > max ? `${digest.slice(0, max)}\n[digest truncated to ${max} chars]` : digest);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await stream.close().catch(() => undefined);
  }
}

/** The newest assistant message's text, when the stream missed it. */
async function readBack(serve: ResearchServe, sessionId: string): Promise<string> {
  const messages = await serve.json<{ data?: { type?: string; role?: string; content?: { type?: string; text?: string }[] }[] }>('GET', `/api/session/${sessionId}/message`).catch(() => null);
  const reply = messages?.data?.find((m) => (m.type ?? m.role) === 'assistant');
  return (reply?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
}

/**
 * The version `opencode --version` prints, under the workspace's variables,
 * or null when it cannot be run or says nothing a version can be read from.
 */
export async function openCodeVersion(opts: { cwd: string; launch: AgentProcessDeps; command?: string; args?: string[]; timeoutMs?: number }): Promise<string | null> {
  const proc = new RunnerProcess(opts.launch);
  let out = '';
  try {
    await proc.start(opts.cwd, () => ({ command: opts.command ?? 'opencode', args: [...(opts.args ?? []), '--version'] }), async () => {
      proc.readStdout((text) => { out += text; });
    });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), opts.timeoutMs ?? 8_000); });
  const how = await Promise.race([proc.ended.then(() => 'ended' as const), gaveUp]);
  clearTimeout(timer);
  proc.dispose();
  return how === 'ended' && proc.exitCode === 0 ? parseCliVersion(out) ?? null : null;
}

export interface LoginResearchAgentDeps {
  /** The planner's workspace; the serve starts there and reads nothing else. */
  cwd: string;
  /** The planner session the research token is scoped to. */
  sessionId: string;
  /** The planner's model as `provider/model`. */
  model?: string;
  fs: IFileSystem;
  turnSink: () => ((progress: ResearchProgress) => void) | undefined;
  mcpServer: Pick<OrdewellMcpServer, 'issueResearchToken' | 'revoke'>;
  launch: AgentProcessDeps;
  command?: string;
  args?: string[];
  /** One line, once, when the agent becomes unavailable. */
  log: (line: string) => void;
  readyTimeoutMs?: number;
  interruptGraceMs?: number;
  maxSteps?: number;
  newId?: () => string;
}

export interface LoginResearchAgent {
  handler: (args: SpawnResearchAgentArgs, context: McpToolContext) => Promise<McpToolReply>;
  /** Stop the serve and revoke the token, for a planner session discarded. */
  close(): Promise<void>;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * `spawn_research_agent` for one planner session on the user's OpenCode
 * login (ADR-0066). The serve starts on the first call, and a serve that fails
 * to start or its pre-use check, or a call that fails on the login, makes the
 * agent unavailable for the rest of the session: every later call is told to
 * delegate with a research task instead, and nothing is started again.
 */
export function loginResearchAgent(deps: LoginResearchAgentDeps): LoginResearchAgent {
  let credential: Promise<McpCredential> | undefined;
  let unavailable: string | undefined;
  let closed = false;
  const issue = () => deps.mcpServer.issueResearchToken({ sessionId: deps.sessionId }, {
    read: async (name, args, { signal }) => {
      const out = await confinedRead(name, args, deps.fs, signal);
      return { text: out.output, isError: !out.success };
    },
  });
  const serves = lazyServe(async () => {
    credential ??= issue();
    const { url, token } = await credential;
    return startResearchServe({ cwd: deps.cwd, mcp: { url, token }, launch: deps.launch, command: deps.command, args: deps.args, readyTimeoutMs: deps.readyTimeoutMs });
  });
  const giveUp = (why: string) => {
    if (unavailable !== undefined || closed) return;
    unavailable = oneLine(why);
    deps.log(`The login research agent is unavailable for this planner session, which delegates with research tasks instead: ${unavailable}`);
  };
  const run = openCodeResearchAgent({
    serve: () => serves.get(),
    model: deps.model,
    turnSink: deps.turnSink,
    maxSteps: deps.maxSteps,
    newId: deps.newId,
    interruptGraceMs: deps.interruptGraceMs,
    onUnusable: giveUp,
  });
  const refusal = async (): Promise<McpToolReply> => {
    await serves.close();
    const why = (unavailable ?? '').slice(0, 300);
    return { text: `[research agent unavailable: ${why}. Delegate this research with a research task instead.]`, isError: true };
  };
  return {
    handler: async (args, context) => {
      if (closed) return { text: '[research agent closed with its planner session]', isError: true };
      if (!deps.turnSink()) return { text: NO_TURN_OPEN, isError: true };
      if (unavailable !== undefined) return refusal();
      try {
        await untilAborted(serves.get(), context.signal);
      } catch (err) {
        if (context.signal.aborted) return { text: '[research agent stopped before it started]', isError: true };
        giveUp(err instanceof Error ? err.message : String(err));
        return refusal();
      }
      const reply = await run(args, context);
      return unavailable !== undefined ? refusal() : reply;
    },
    async close() {
      closed = true;
      await serves.close();
      const issued = await credential?.catch(() => undefined);
      if (issued) deps.mcpServer.revoke(issued.token);
    },
  };
}

/** `pending`, or a rejection as soon as `signal` aborts: a stopped call stops waiting for the serve, which keeps starting for the next. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('stopped'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
