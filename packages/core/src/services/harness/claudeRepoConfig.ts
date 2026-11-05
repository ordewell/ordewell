import * as path from 'path';
import type { RunnerEnv } from '../../plugins/types';
import { expandRunnerHome } from '../../utils/runnerHome';
import {
  NO_SERVERS, isRecord, readText, takesOrdewellsName, withImports,
  type InstructionFile, type ProjectMcpServer, type ProjectServers, type RepoConfigReader,
} from './repoConfig';

/** The memory files Claude Code loads from a project's root, in its order. */
const MEMORY_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];

function server(name: string, entry: unknown, source: string): ProjectMcpServer | string {
  if (!isRecord(entry)) return 'not an object';
  const taken = takesOrdewellsName(name);
  if (taken) return taken;
  const remote = entry.type === 'http' || entry.type === 'sse' || (entry.type === undefined && typeof entry.url === 'string');
  if (remote) {
    if (typeof entry.url !== 'string') return 'no url';
    return { name, source, transport: 'remote', target: entry.url, names: isRecord(entry.headers) ? Object.keys(entry.headers) : [], definition: entry };
  }
  if (typeof entry.command !== 'string') return 'no command';
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return { name, source, transport: 'stdio', target: [entry.command, ...args].join(' '), names: isRecord(entry.env) ? Object.keys(entry.env) : [], definition: entry };
}

export const CLAUDE_REPO_CONFIG: RepoConfigReader = {
  instructions(workspace) {
    const files: InstructionFile[] = [];
    const seen = new Set<string>();
    for (const name of MEMORY_FILES) withImports(path.join(workspace, name), { workspace, within: workspace }, seen, files);
    return files;
  },

  projectServers(workspace) {
    const source = '.mcp.json';
    const text = readText(path.join(workspace, source));
    if (text === undefined) return NO_SERVERS;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (err) {
      return { servers: [], unreadable: [{ source, reason: err instanceof Error ? err.message : String(err) }] };
    }
    const entries = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    const found: ProjectServers = { servers: [], unreadable: [] };
    for (const [name, entry] of Object.entries(entries)) {
      const read = server(name, entry, source);
      if (typeof read === 'string') found.unreadable.push({ source: `${source} (${name})`, reason: read });
      else found.servers.push(read);
    }
    return found;
  },
};

/**
 * The user's local-scope servers for `workspace`: their own entries in
 * Claude Code's `.claude.json`, which user-only settings stop the CLI from
 * loading for a planner, though the repository has no say in them
 * (ADR-0028). `env` is the environment the planner runs with: its
 * `CLAUDE_CONFIG_DIR` holds the file, else its home does.
 */
export function claudeLocalServers(env: RunnerEnv, workspace: string): Record<string, unknown> {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const file = expandRunnerHome(configDir ? path.join(configDir, '.claude.json') : '~/.claude.json', env);
  const text = file === null ? undefined : readText(file);
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const project = isRecord(parsed) && isRecord(parsed.projects) ? parsed.projects[path.resolve(workspace)] : undefined;
    return isRecord(project) && isRecord(project.mcpServers) ? project.mcpServers : {};
  } catch {
    return {};
  }
}
