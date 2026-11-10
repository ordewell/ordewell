import { ORDEWELL_MCP_SERVER_NAME, type McpClientConfig } from '../mcp';
import { ORDEWELL_TOOL_NAMES, prefixedToolNames, type OrdewellToolBinding, type OrdewellToolRole } from './ordewellBinding';
import type { TaskStartOptions } from './AgentAdapter';
import { realpathSync } from 'fs';

/**
 * OpenCode names an MCP tool `<server>_<tool>`, each part with anything but
 * letters, digits, `_` and `-` turned into `_`, and keys its permission rules
 * by that name (checked against 1.18.34; the character rule against 2.0.27).
 */
const NAMES = prefixedToolNames(`${ORDEWELL_MCP_SERVER_NAME}_`);

/** The rule an Ordewell before exact rules wrote, still stripped from an inherited configuration. */
const PATTERN_RULE = NAMES.toolName('*');

/**
 * Whether a server of this name could put a tool under one of Ordewell's
 * names: `ordewell_task` with a tool `complete` is `ordewell_task_complete`,
 * which Ordewell allows unasked, and `ordewell` is Ordewell's own server.
 */
export function shadowsOrdewell(server: string): boolean {
  const prefix = `${server.replace(/[^a-zA-Z0-9_-]/g, '_')}_`;
  return ORDEWELL_TOOL_NAMES.some((tool) => NAMES.toolName(tool).startsWith(prefix));
}

/** One allow per tool `role` is served, by its exact name: a pattern would cover another server's tools too. */
function allowRules(mcp: McpClientConfig, role: OrdewellToolRole): Record<string, 'allow'> {
  return Object.fromEntries(NAMES.toolNames(role, mcp.hidden, mcp.extraTools).map((name) => [name, 'allow']));
}

/**
 * A planner server's whole permission policy (ADR-0026), in order: OpenCode
 * applies the last rule that matches, so the catch-all comes first. Anything
 * not named asks, which reaches the planner's envelope: a user's MCP tool, a
 * search, a read outside the workspace. OpenCode's own read tools run, and
 * everything that writes or runs is denied — its shell too, since by default
 * the planner's commands go through Ordewell's `run_command`. 2.x renamed
 * `bash` to `shell` and `task` to `subagent`, and added a `browser` that
 * clicks through pages; both spellings are listed. Checked against 1.18.35 and
 * 2.0.26.
 *
 * Web reads (ADR-0027): `webfetch` follows redirects itself, so Ordewell would
 * vet only the first URL, and the planner fetches through Ordewell's `fetch`
 * instead. `websearch` (both versions) and `codesearch` (1.x) ask, so the
 * web-read policy decides each as a search.
 */
/**
 * The rules that turn a planner's own search off, after
 * {@link OPENCODE_PLANNER_PERMISSION}: for a 2.x session whose OpenCode has
 * no search provider chosen, where `websearch` would ask the user to pick one
 * through `question`, which the planner is denied.
 */
export const OPENCODE_SEARCH_OFF: Record<string, OpenCodeSessionRule['effect']> = { websearch: 'deny', codesearch: 'deny' };

export const OPENCODE_PLANNER_PERMISSION: Record<string, OpenCodeSessionRule['effect']> = {
  '*': 'ask',
  read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', lsp: 'allow',
  skill: 'allow', todoread: 'allow',
  websearch: 'ask', codesearch: 'ask', external_directory: 'ask',
  webfetch: 'deny',
  edit: 'deny', write: 'deny', patch: 'deny', apply_patch: 'deny', multiedit: 'deny',
  bash: 'deny', task: 'deny', question: 'deny', todowrite: 'deny',
  shell: 'deny', subagent: 'deny', browser: 'deny',
};

/**
 * A planner's policy with the native-shell opt-in on (ADR-0036 N1, N2): the
 * shell asks, and the harness's request becomes the `native-shell` kind the
 * adapter routes to the user's grant. Off, both spellings stay denied, so a
 * planner has `run_command` alone.
 */
export function plannerPermission(nativeShell: boolean): Record<string, OpenCodeSessionRule['effect']> {
  return nativeShell ? { ...OPENCODE_PLANNER_PERMISSION, bash: 'ask', shell: 'ask' } : OPENCODE_PLANNER_PERMISSION;
}

/**
 * The one OpenCode agent a 2.x planner may delegate to: Ordewell's scout, a
 * read-only subagent for breadth (ADR-0026, ADR-0009 T8). It is written in
 * 1.x's `agent` + `permission` shape, the one both versions load: 1.18.35
 * refuses a config carrying V2 `permissions` outright, and 2.x migrates this
 * map into the agent's rules, after the global ones. A child session carries
 * no session rules of its own, so these are its whole policy. The catch-all
 * denies, so a tool OpenCode adds later is denied too; every known write, run,
 * web, delegation and ask action is also named, because a user's own
 * `agent.ordewell-scout.permission` merged in before this layer would
 * otherwise keep the position of its own `*` rule. A user-global entry can
 * still add rules this layer cannot remove, so a 2.x planner reads the agent
 * back as the server resolved it ({@link scoutRulesMismatch}).
 */
export const OPENCODE_SCOUT_AGENT = 'ordewell-scout';

export const OPENCODE_SCOUT_PERMISSION: Record<string, OpenCodeSessionRule['effect']> = {
  '*': 'deny',
  edit: 'deny', write: 'deny', patch: 'deny', apply_patch: 'deny', multiedit: 'deny',
  bash: 'deny', shell: 'deny', execute: 'deny', browser: 'deny',
  webfetch: 'deny', websearch: 'deny', codesearch: 'deny', external_directory: 'deny',
  task: 'deny', subagent: 'deny', question: 'deny', todowrite: 'deny', todoread: 'deny',
  skill: 'deny', lsp: 'deny',
  read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
};

const SCOUT_PROMPT = [
  'You are Ordewell\'s scout: a read-only researcher for a planner.',
  'Read the workspace with read, glob, grep and list only. Every other tool is denied, and nobody can approve one.',
  'Answer the brief you were given with a short digest: the files and lines that matter, what they show, and what you could not settle.',
].join(' ');

/** The scout's whole entry: no model, so it runs on the planner's; no `steps`, so 2.x's default bound holds. */
export function scoutAgentConfig(): Record<string, unknown> {
  return {
    mode: 'subagent',
    description: 'Read-only workspace research for the Ordewell planner. Give it one question; it returns a digest.',
    prompt: SCOUT_PROMPT,
    permission: { ...OPENCODE_SCOUT_PERMISSION },
  };
}

/** Until its live probe passes, only this variable set to exactly `1` offers the scout (ADR-0026). */
export const OPENCODE_SCOUT_ENV = 'ORDEWELL_OPENCODE_SCOUT';

/** Whether this start asks for the scout: a planner that may have agents at all, with the gate open. */
export function scoutRequested(opts: { kind: 'planner' | 'task'; noSubagents?: true }, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.kind === 'planner' && !opts.noSubagents && env[OPENCODE_SCOUT_ENV] === '1';
}

const SCOUT_READS = Object.entries(OPENCODE_SCOUT_PERMISSION).filter(([, effect]) => effect === 'allow').map(([tool]) => tool);

/**
 * Why the scout's rules as the 2.x server resolved them (`GET /api/agent`'s
 * `permissions`, evaluated last match first) are not Ordewell's, or null when
 * they are. Everything before the last deny-all is shadowed by it. After it,
 * OpenCode may migrate a name (bash to `shell`, write to `edit`) and append
 * denies of its own, so a deny passes whatever it names; an allow passes only
 * for one of the scout's read tools on every path, and those must all be
 * there. Anything else came from a config outside Ordewell's layer.
 */
export function scoutRulesMismatch(agents: unknown): string | null {
  const listed = isRecord(agents) && Array.isArray(agents.data) ? agents.data.find((a) => isRecord(a) && a.id === OPENCODE_SCOUT_AGENT) : undefined;
  if (!isRecord(listed)) return `OpenCode does not list ${OPENCODE_SCOUT_AGENT} among its agents.`;
  const rules = listed.permissions;
  if (!Array.isArray(rules) || rules.length === 0) return `OpenCode lists ${OPENCODE_SCOUT_AGENT} with no rules.`;
  const changed = (detail: string) => `OpenCode's resolved ${OPENCODE_SCOUT_AGENT} ${detail}: a config outside Ordewell's (an \`agent\` or \`agents\` entry of that name in OpenCode's managed config, or one this release merges after Ordewell's) changed it.`;
  const rule = (r: unknown) => isRecord(r) ? { action: String(r.action), resource: String(r.resource), effect: String(r.effect) } : { action: '?', resource: '?', effect: '?' };
  const last = rules.map(rule).reduce((at, r, i) => r.action === '*' && r.resource === '*' && r.effect === 'deny' ? i : at, -1);
  if (last < 0) return changed('has no deny-all rule');
  const allowed = new Set<string>();
  for (const r of rules.slice(last + 1).map(rule)) {
    if (r.effect === 'deny') continue;
    if (r.effect !== 'allow' || r.resource !== '*' || !SCOUT_READS.includes(r.action)) return changed(`${r.effect === 'allow' ? 'allows' : r.effect === 'ask' ? 'asks' : r.effect} ${r.action} on ${r.resource} after its deny-all`);
    allowed.add(r.action);
  }
  const missing = SCOUT_READS.find((tool) => !allowed.has(tool));
  return missing ? changed(`does not allow ${missing}`) : null;
}

/** The 2.x session rule that lets a planner start the scout and no other agent, after its `subagent` deny. */
export const OPENCODE_SCOUT_SESSION_RULE: OpenCodeSessionRule = { action: 'subagent', resource: OPENCODE_SCOUT_AGENT, effect: 'allow' };

/** ADR-0046: nobody can approve native tools; only reads and the task token's tools run. */
export const OPENCODE_READ_ONLY_PERMISSION: Record<string, OpenCodeSessionRule['effect']> = {
  ...OPENCODE_PLANNER_PERMISSION,
  '*': 'deny',
  external_directory: 'deny', websearch: 'deny', codesearch: 'deny', execute: 'deny', lsp: 'deny',
  bash: 'deny', shell: 'deny',
};

export function readOnlySessionRules(site: Pick<TaskStartOptions, 'cwd' | 'workspaceRoot'>): OpenCodeSessionRule[] {
  const rules = Object.entries(OPENCODE_READ_ONLY_PERMISSION).map(([action, effect]) => ({ action, resource: '*', effect }));
  // OpenCode asks external_directory for the original workspace when cwd is a task worktree.
  for (const root of new Set([site.cwd, site.workspaceRoot].filter((r): r is string => r !== undefined))) {
    let real = root;
    try { real = realpathSync.native(root); } catch { /* A missing root grants no additional real path. */ }
    for (const path of new Set([root, real])) rules.push({ action: 'external_directory', resource: `${path.replace(/[\\/]$/, '')}/*`, effect: 'allow' });
  }
  return rules;
}

/** The variable OpenCode reads inline configuration from, over its config files. */
export const OPENCODE_CONFIG_VARIABLE = 'OPENCODE_CONFIG_CONTENT';

/**
 * What a planner's server runs under so the repository's config never loads
 * (ADR-0028): neither `opencode.json[c]` nor any `.opencode` directory — the
 * plugins, tools, commands and agents in it — nor the instruction files,
 * which Ordewell gives the planner as text. Checked against 1.18.35 (by
 * source) and 2.0.26.
 */
export const OPENCODE_PLANNER_ENV = { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } as const;

/** A 2.x session's permission rule. */
export interface OpenCodeSessionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/**
 * Who receives an OpenCode search. 1.x sends `websearch` and `codesearch` to
 * Exa's hosted MCP server; 2.x sends `websearch` to the search provider chosen
 * in OpenCode, Exa unless another was picked (checked against 1.18.35 and
 * 2.0.26). Either way the query leaves for a third party, which the approval
 * names.
 */
export const OPENCODE_SEARCH_PROVIDER = { provider: 'opencode', providerLabel: 'OpenCode\'s web search (Exa, unless another search provider is chosen in OpenCode)' } as const;

export interface OpenCodeOrdewellBinding extends OrdewellToolBinding<string> {
  /**
   * The 1.x server's `OPENCODE_CONFIG_CONTENT` with the server added — see
   * {@link mergeOrdewellConfig}. `nativeShell`, when given, is the launcher
   * every command must run in (ADR-0036 N2). `gateway`, when given, is what a
   * lease holds in place of an Anthropic key (ADR-0059 L7): the provider points
   * at the lease's own address with the stand-in, so OpenCode's model traffic
   * never needs the key or the network.
   */
  configContent(existing: string | undefined, mcp: McpClientConfig | null, role: OrdewellToolRole, projectServers?: Record<string, unknown>, site?: Pick<TaskStartOptions, 'cwd' | 'workspaceRoot'>, nativeShell?: string, gateway?: LeaseGateway, scout?: boolean): string | null;
  /** The rules a 2.x session is created with so the server's tools never wait on a person (ADR-0022, S3). */
  sessionRules(mcp: McpClientConfig, role: OrdewellToolRole): OpenCodeSessionRule[];
  /**
   * What a planner's instructions add about web reads (ADR-0027). `ownSearch`
   * false: its `websearch` is off for the session, and Ordewell's is the search.
   */
  plannerInstructions(ownSearch?: boolean): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a container lease holds for a runner in place of an Anthropic key
 * (ADR-0059 L7): the address its gateway answers on from inside the container,
 * and the stand-in token that is all the runner ever reads.
 */
export interface LeaseGateway {
  baseURL: string;
  apiKey: string;
}

/** The lease's gateway, from what its placement hands a runner: absent outside a container, or with no key gated. */
export function leaseGateway(env: Readonly<Record<string, string>> | undefined): LeaseGateway | null {
  const baseURL = env?.ANTHROPIC_BASE_URL;
  const apiKey = env?.ANTHROPIC_API_KEY;
  return baseURL && apiKey ? { baseURL, apiKey } : null;
}

/**
 * Where OpenCode's Anthropic provider sends its model calls. Both its 1.x and
 * 2.x providers append `/messages` to this, as the AI SDK's Anthropic provider
 * does to its own `https://api.anthropic.com/v1` default (checked against
 * 2.2.5 on 2026-11-02), so a lease's gateway is named with the `/v1` it does
 * not itself carry.
 */
function versioned(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/** `config` without a field's keys that `drop` names, and without the field once that was all it held. */
function dropEntries(config: Record<string, unknown>, field: string, drop: (key: string) => boolean): void {
  const entries = config[field];
  if (!isRecord(entries) || !Object.keys(entries).some(drop)) return;
  const rest = Object.fromEntries(Object.entries(entries).filter(([key]) => !drop(key)));
  if (Object.keys(rest).length > 0) config[field] = rest;
  else delete config[field];
}

/** `config` without what an Ordewell merge puts there: the reserved server entry and the rules allowing its tools. */
function withoutOrdewell(config: Record<string, unknown>): Record<string, unknown> {
  const kept = { ...config };
  dropEntries(kept, 'mcp', (key) => key === ORDEWELL_MCP_SERVER_NAME);
  dropEntries(kept, 'permission', (key) => key === PATTERN_RULE || NAMES.isToolName(key));
  return kept;
}

/**
 * An inherited `OPENCODE_CONFIG_CONTENT` with a parent Ordewell's server
 * removed. A host that is itself an Ordewell runner's child carries its
 * parent's entry — URL and bearer — and a child given no server, or running
 * another harness that hands the variable on, must not keep it (ADR-0022, A5).
 * Everything else the configuration carries stays, byte for byte when there
 * was nothing to remove. Emptied, it is still `{}`: a workspace's setting
 * replaces the host's whole, and dropping it would bring the host's back.
 *
 * Content that is not a JSON object passes unchanged: Ordewell only ever
 * writes the entry by serializing an object, and refuses to merge into
 * anything else, so such content cannot hold one of its entries.
 */
export function withoutParentOrdewell(content: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  if (!isRecord(parsed)) return content;
  const kept = withoutOrdewell(parsed);
  return JSON.stringify(kept) === JSON.stringify(parsed) ? content : JSON.stringify(kept);
}

/**
 * The `OPENCODE_CONFIG_CONTENT` for a process given the Ordewell server: the
 * remote server entry with its token header, and an allow rule so a call never
 * waits on a person (ADR-0022, S3). Deep-merged over `existing`, which a
 * runner manifest or a workspace variable may already have set — except for
 * the reserved entry, which is replaced whole so no header or option of an
 * inherited one outlives the fresh credential. Null when
 * `existing` is not a JSON object — it cannot be merged, and replacing it would
 * silently drop whatever it carried, so the caller runs without the server.
 *
 * With `nativeShell`, the config names the launcher as `shell`, the last
 * config layer OpenCode reads for it (ADR-0036 N2). It is set here, in the one
 * layer that also decides the policy, so a user's own config cannot choose a
 * different shell for the planner.
 */
function mergeOrdewellConfig(existing: string | undefined, mcp: McpClientConfig | null, role: OrdewellToolRole, projectServers: Record<string, unknown> = {}, site?: Pick<TaskStartOptions, 'cwd' | 'workspaceRoot'>, nativeShell?: string, gateway?: LeaseGateway, scout = false): string | null {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { return null; }
    if (!isRecord(parsed)) return null;
    base = withoutOrdewell(parsed);
  }
  // A planner's policy is Ordewell's alone: a permission the workspace grants its own sessions is not one it grants the planner.
  const restricted = role !== 'task';
  if (restricted) { delete base.permission; delete base.permissions; }
  // The scout is Ordewell's alone too: an inherited entry of the same name must not lend it a model or a rule.
  if (scout) for (const key of ['agent', 'agents', 'mode']) dropEntries(base, key, (name) => name === OPENCODE_SCOUT_AGENT);
  // A bare `"permission": "allow"` is the whole policy; the rule needs an object to join.
  const policy = typeof base.permission === 'string' ? { '*': base.permission } : base.permission;
  const servers = {
    ...(role === 'planner' ? projectServers : {}),
    ...(mcp ? { [mcp.name]: { type: 'remote', url: mcp.url, headers: mcp.headers, enabled: true } } : {}),
  };
  const ours = {
    ...(Object.keys(servers).length > 0 ? { mcp: servers } : {}),
    // A language server opened on a file the planner reads can run the
    // repository's toolchain; 1.x's `read` opens every file it reads (ADR-0028).
    ...(restricted ? { lsp: false } : {}),
    // N2: a `shell` in this layer beats one in the user's global config, and
    // beats `SHELL`; the launch environment names the same launcher as a
    // fallback for OpenCode built without this layer.
    ...(nativeShell ? { shell: nativeShell } : {}),
    // 2.x evicts a location left idle past this (an hour unless set) and
    // rebuilds it from this configuration, without the replacement that lists
    // Ordewell's tools outside code mode: a planner idle that long lost them
    // for good (ADR-0022 S4; checked against 2.1.4). 1.x has no such
    // eviction, and ignores the key (checked against 1.18.35's config parser).
    // The scout's nesting is pinned here, over a user's global config: 2.x
    // counts depth from the root session, so 1 lets the planner start the
    // scout and the scout start nothing (1.x lowers it to its own key).
    ...(mcp || scout ? { experimental: { ...(mcp ? { location_idle_timeout: false } : {}), ...(scout ? { subagent_depth: 1 } : {}) } } : {}),
    ...(scout ? { agent: { [OPENCODE_SCOUT_AGENT]: scoutAgentConfig() } } : {}),
    // L7: a lease's key stops at its gateway, and OpenCode is pointed there with
    // the stand-in. Its own provider block would otherwise send the token to
    // Anthropic, where it means nothing, and the task's model call would fail.
    ...(gateway ? { provider: { anthropic: { options: { baseURL: versioned(gateway.baseURL), apiKey: gateway.apiKey } } } } : {}),
    permission: {
      ...(role === 'planner' ? plannerPermission(nativeShell !== undefined) : role === 'readOnlyTask' ? OPENCODE_READ_ONLY_PERMISSION : {}),
      ...(role === 'readOnlyTask' && site ? { external_directory: Object.fromEntries(readOnlySessionRules(site).filter((r) => r.action === 'external_directory').map((r) => [r.resource, r.effect])) } : {}),
      ...(mcp ? allowRules(mcp, role) : {}),
    },
  };
  return JSON.stringify(deepMerge({ ...base, ...(policy === undefined ? {} : { permission: policy }) }, ours));
}

export const OPENCODE_ORDEWELL: OpenCodeOrdewellBinding = {
  toolName: NAMES.toolName,
  toolNames: NAMES.toolNames,
  plannerHidden: () => [],
  /** A permission request's `permission`, which for a tool is its name. */
  isOrdewellAsk: (permission) => NAMES.isToolName(permission),
  /** `/mcp` lists a server only once it has started connecting, as `pending` until it settles. */
  attachState: (status) => (status === 'connected' ? 'connected' : status === undefined || status === null || status === 'pending' ? 'pending' : 'failed'),
  configContent: mergeOrdewellConfig,
  sessionRules: (mcp, role) => Object.keys(allowRules(mcp, role)).map((action) => ({ action, resource: '*', effect: 'allow' })),
  plannerInstructions: (ownSearch = true) => [
    `Read web pages with \`${NAMES.toolName('fetch')}\`. Your own \`webfetch\` is off while planning: it follows redirects Ordewell cannot check.`,
    ownSearch
      // A failed or cancelled search reads to a model as a refusal, so it is told the fallback is open.
      ? `Search the web with your own \`websearch\` first. If \`websearch\` fails, is cancelled or is unavailable for your provider, search with \`${NAMES.toolName('web_search')}\` instead.`
      : `Your own \`websearch\` is off for this session: no search provider is chosen in OpenCode. Search the web with \`${NAMES.toolName('web_search')}\`.`,
  ].join(' '),
};
