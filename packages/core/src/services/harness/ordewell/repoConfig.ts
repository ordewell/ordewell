import * as path from 'path';
import { NO_SERVERS, readInstruction, repoLevels, repoRoot, type InstructionFile, type RepoConfigReader } from '../repoConfig';

/** AGENTS.md first, CLAUDE.md only where no level has one: the first name found wins (ADR-0070). */
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * What the built-in runner reads of a repository: its instruction files, from
 * the repository root down to the workspace. It has no MCP servers of its
 * own, since its tools are Ordewell's, so a repository declares none for it.
 */
export const ORDEWELL_REPO_CONFIG: RepoConfigReader = {
  instructions(workspace) {
    const levels = repoLevels(workspace);
    const at = { workspace, within: repoRoot(workspace) };
    for (const name of INSTRUCTION_NAMES) {
      const files: InstructionFile[] = [];
      for (const dir of levels) readInstruction(path.join(dir, name), at, files);
      if (files.length > 0) return files;
    }
    return [];
  },
  projectServers: () => NO_SERVERS,
};
