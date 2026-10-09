import { ORDEWELL_MCP_SERVER_NAME, type McpClientConfig } from '../mcp';
import { prefixedToolNames, type OrdewellToolBinding } from './ordewellBinding';

/**
 * OpenCode names an MCP tool `<server>_<tool>`, and keys its permission rules
 * by that name (checked against 1.18.34).
 */
const NAMES = prefixedToolNames(`${ORDEWELL_MCP_SERVER_NAME}_`);

/** The permission rule that covers every tool of the server. */
const RULE = NAMES.toolName('*');

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

/**
 * The `OPENCODE_CONFIG_CONTENT` for a process given the Ordewell server: the
 * remote server entry with its token header, and an allow rule so a call never
 * waits on a person (ADR-0022, S3). Deep-merged over `existing`, which a
 * runner manifest or a workspace variable may already have set. Null when
 * `existing` is not a JSON object — it cannot be merged, and replacing it would
 * silently drop whatever it carried, so the caller runs without the server.
 */
function mergeOrdewellConfig(existing: string | undefined, mcp: McpClientConfig): string | null {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { return null; }
    if (!isRecord(parsed)) return null;
    base = parsed;
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
