import * as path from 'path';
import { NO_SERVERS, readInstruction, repoLevels, repoRoot, type InstructionFile, type RepoConfigReader } from './repoConfig';

/** The names Pi takes a directory's context file under, the first found winning (checked against 1.5.2's resource loader). */
const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

/**
 * Pi's context files, and nothing else it would load from a repository: its
 * `.pi` settings, extensions, skills and MCP servers are configuration it
 * would run (ADR-0028), which a planner and a read-only task start without
 * (`--no-approve`; the adapter names the session directory itself, the one
 * setting Pi takes from the repository even so), and this reader offers none
 * of its servers for approval. Pi reads one context file at every level from
 * the working directory up; a planner and a read-only task, which start with
 * `--no-context-files`, are given the repository's, root first, as Pi orders them.
 */
export const PI_REPO_CONFIG: RepoConfigReader = {
  instructions(workspace) {
    const at = { workspace, within: repoRoot(workspace) };
    const files: InstructionFile[] = [];
    for (const dir of repoLevels(workspace)) {
      for (const name of CONTEXT_FILES) {
        if (readInstruction(path.join(dir, name), at, files) !== undefined) break;
      }
    }
    return files;
  },
  projectServers: () => NO_SERVERS,
};
