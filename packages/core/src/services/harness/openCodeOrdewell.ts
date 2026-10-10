import { ORDEWELL_MCP_SERVER_NAME, type McpClientConfig } from '../mcp';
import { prefixedToolNames, type OrdewellToolBinding } from './ordewellBinding';

/**
 * OpenCode names an MCP tool `<server>_<tool>`, and keys its permission rules
 * by that name (checked against 1.18.34).
 */
const NAMES = prefixedToolNames(`${ORDEWELL_MCP_SERVER_NAME}_`);

/** The permission rule that covers every tool of the server. */
const RULE = NAMES.toolName('*');

/** The variable OpenCode reads inline configuration from, over its config files. */
export const OPENCODE_CONFIG_VARIABLE = 'OPENCODE_CONFIG_CONTENT';

/** A 2.x session's permission rule. */
export interface OpenCodeSessionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

export interface OpenCodeOrdewellBinding extends OrdewellToolBinding<string> {
  /** The 1.x server's `OPENCODE_CONFIG_CONTENT` with the server added — see {@link mergeOrdewellConfig}. */
  configContent(existing: string | undefined, mcp: McpClientConfig): string | null;
  /** The rules a 2.x session is created with so the server's tools never wait on a person (ADR-0022, S3). */
  sessionRules(): OpenCodeSessionRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/** `config` without a field's `key`, and without the field once that was all it held. */
function dropEntry(config: Record<string, unknown>, field: string, key: string): void {
  const entries = config[field];
  if (!isRecord(entries) || !Object.hasOwn(entries, key)) return;
  const rest = { ...entries };
  delete rest[key];
  if (Object.keys(rest).length > 0) config[field] = rest;
  else delete config[field];
}

/** `config` without what an Ordewell merge puts there: the reserved server entry and the rule allowing its tools. */
function withoutOrdewell(config: Record<string, unknown>): Record<string, unknown> {
  const kept = { ...config };
  dropEntry(kept, 'mcp', ORDEWELL_MCP_SERVER_NAME);
  dropEntry(kept, 'permission', RULE);
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
 */
function mergeOrdewellConfig(existing: string | undefined, mcp: McpClientConfig): string | null {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { return null; }
    if (!isRecord(parsed)) return null;
    base = withoutOrdewell(parsed);
  }
  // A bare `"permission": "allow"` is the whole policy; the rule needs an object to join.
  const policy = typeof base.permission === 'string' ? { '*': base.permission } : base.permission;
  const ours = {
    mcp: { [mcp.name]: { type: 'remote', url: mcp.url, headers: mcp.headers, enabled: true } },
    permission: { [RULE]: 'allow' },
  };
  return JSON.stringify(deepMerge({ ...base, ...(policy === undefined ? {} : { permission: policy }) }, ours));
}

export const OPENCODE_ORDEWELL: OpenCodeOrdewellBinding = {
  toolName: NAMES.toolName,
  toolNames: NAMES.toolNames,
  /** A permission request's `permission`, which for a tool is its name. */
  isOrdewellAsk: (permission) => NAMES.hasPrefix(permission),
  /** `/mcp` lists a server only once it has started connecting, as `pending` until it settles. */
  attachState: (status) => (status === 'connected' ? 'connected' : status === undefined || status === null || status === 'pending' ? 'pending' : 'failed'),
  configContent: mergeOrdewellConfig,
  sessionRules: () => [{ action: RULE, resource: '*', effect: 'allow' }],
};
