import * as path from 'path';
import { parseToml } from './toml';
import {
  isRecord, readInstruction, readText, repoLevels, repoRoot, takesOrdewellsName,
  type InstructionFile, type ProjectMcpServer, type ProjectServers, type RepoConfigReader,
} from './repoConfig';

const CONFIG_FILE = path.join('.codex', 'config.toml');

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/** One `mcp_servers` entry, by Codex's own keys (codex-cli 0.162.0); a disabled one is not offered. */
function server(name: string, entry: unknown, source: string): ProjectMcpServer | string | null {
  if (!isRecord(entry)) return 'not a table';
  if (entry.enabled === false) return null;
  const taken = takesOrdewellsName(name);
  if (taken) return taken;
  if (typeof entry.url === 'string') {
    const names = [...keysOf(entry.http_headers), ...keysOf(entry.env_http_headers), ...(typeof entry.bearer_token_env_var === 'string' ? ['Authorization'] : [])];
    return { name, source, transport: 'remote', target: entry.url, names, definition: entry };
  }
  if (typeof entry.command !== 'string') return 'no command or url';
  const names = [...keysOf(entry.env), ...stringsOf(entry.env_vars)];
  return { name, source, transport: 'stdio', target: [entry.command, ...stringsOf(entry.args)].join(' '), names, definition: entry };
}

export const CODEX_REPO_CONFIG: RepoConfigReader = {
  /** Codex reads one file per directory from the repository root down, an override in place of the plain one. */
  instructions(workspace) {
    const files: InstructionFile[] = [];
    const at = { workspace, within: repoRoot(workspace) };
    for (const dir of repoLevels(workspace)) {
      for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
        if (readInstruction(path.join(dir, name), at, files) !== undefined) break;
      }
    }
    return files;
  },

  /** Each level's `.codex/config.toml`, the one nearer the workspace winning for a server both name. */
  projectServers(workspace) {
    const byName = new Map<string, ProjectMcpServer>();
    const unreadable: ProjectServers['unreadable'] = [];
    for (const dir of repoLevels(workspace)) {
      const file = path.join(dir, CONFIG_FILE);
      const text = readText(file);
      if (text === undefined) continue;
      const source = path.relative(workspace, file);
      let parsed: Record<string, unknown>;
      try { parsed = parseToml(text); } catch (err) {
        unreadable.push({ source, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      for (const [name, entry] of Object.entries(isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {})) {
        const read = server(name, entry, source);
        if (typeof read === 'string') unreadable.push({ source: `${source} (${name})`, reason: read });
        else if (read) byName.set(name, read);
        else byName.delete(name);
      }
    }
    return { servers: [...byName.values()], unreadable };
  },
};

/**
 * The thread config that keeps Codex from loading the repository's own
 * config for a planner (ADR-0028). Codex keys trust on the project root it
 * settles on, not the working directory, so the workspace and every
 * directory above it are marked: whichever is the root, it is untrusted.
 */
export function untrustedProjects(workspace: string): Record<string, { trust_level: 'untrusted' }> {
  const projects: Record<string, { trust_level: 'untrusted' }> = {};
  for (let dir = path.resolve(workspace); ; dir = path.dirname(dir)) {
    projects[dir] = { trust_level: 'untrusted' };
    if (path.dirname(dir) === dir) return projects;
  }
}
