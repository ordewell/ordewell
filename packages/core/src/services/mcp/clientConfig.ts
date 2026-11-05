import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bearerHeaderValue } from '../../utils/daemonToken';
import type { McpContact, McpCredential } from './OrdewellMcpServer';

/** The server's name in every runner's MCP configuration, and so in its tool names (`mcp__ordewell__*`). */
export const ORDEWELL_MCP_SERVER_NAME = 'ordewell';

export interface McpClientConfig {
  name: typeof ORDEWELL_MCP_SERVER_NAME;
  url: string;
  headers: Record<string, string>;
  /** Planner tools the token hides: a runner must neither pre-allow nor mention them. */
  hidden?: readonly string[];
  /** Tools served past a planner's: a subplanner's, to pre-allow with the rest (ADR-0055 D5). */
  extraTools?: readonly string[];
  /** A read-only task's token (ADR-0046): `run_command`, `fetch` and `web_search` are among its tools, for the runner to pre-allow and name. */
  readOnly?: true;
  /**
   * The server's record of this token's first use, for a runner whose
   * protocol reports no MCP status of its own (ACP): its only evidence of an
   * attach (ADR-0022, S4).
   */
  contact?: McpContact;
}

/**
 * The one shape every runner adapter renders its own MCP configuration from.
 * The token travels only in `headers`: the adapter writes it to an owner-only
 * file or an environment variable, or hands it over the runner's own stdin
 * protocol (ACP's `session/new`), never a prompt or a process argument
 * (ADR-0022, A4/A5).
 */
export function mcpClientConfig(credential: McpCredential): McpClientConfig {
  return {
    name: ORDEWELL_MCP_SERVER_NAME,
    url: credential.url,
    headers: { Authorization: bearerHeaderValue(credential.token) },
    ...(credential.hidden?.length ? { hidden: credential.hidden } : {}),
    ...(credential.extraTools?.length ? { extraTools: credential.extraTools } : {}),
    ...(credential.readOnly ? { readOnly: true } : {}),
    ...(credential.contact ? { contact: credential.contact } : {}),
  };
}

/** A runner's MCP configuration on disk, and the way to take it back off. */
export interface OwnerOnlyFile {
  path: string;
  /** Delete the file. Idempotent. */
  remove(): void;
}

/**
 * Write a configuration that carries a token where only the user can read it,
 * for a runner that takes its MCP servers from a file (ADR-0022, A5). The
 * directory is private too, so the name cannot be raced before the mode lands.
 */
export function ownerOnlyConfigFile(fileName: string, contents: string): OwnerOnlyFile {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-mcp-'));
  const path = join(dir, fileName);
  writeFileSync(path, contents, { mode: 0o600 });
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
