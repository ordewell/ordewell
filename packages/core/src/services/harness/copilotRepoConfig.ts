import { readdirSync } from 'fs';
import * as path from 'path';
import {
  NO_SERVERS, insideOnDisk, readText, repoLevels, repoRoot, withImports,
  type InstructionFile, type RepoConfigReader,
} from './repoConfig';

/**
 * The instruction files Copilot CLI reads in each directory from the
 * repository root down to where it works, in its docs' order (checked
 * against "Adding custom instructions for GitHub Copilot CLI", 2026-11).
 * Those listed with `imports` have their `@path` references expanded.
 */
const LEVEL_FILES: { name: string; imports: boolean }[] = [
  { name: path.join('.github', 'copilot-instructions.md'), imports: true },
  { name: 'AGENTS.md', imports: true },
  { name: 'CLAUDE.md', imports: true },
  { name: path.join('.claude', 'CLAUDE.md'), imports: true },
  { name: 'GEMINI.md', imports: false },
];

/** Copilot's modular instructions, read at the root and where it works but not between. */
const MODULAR_DIR = path.join('.github', 'instructions');
const MODULAR_SUFFIX = '.instructions.md';

/** Every `*.instructions.md` under `dir`, sorted by path, directory links not followed. */
function modularFiles(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return modularFiles(file);
      return entry.name.endsWith(MODULAR_SUFFIX) && (entry.isFile() || entry.isSymbolicLink()) ? [file] : [];
    });
}

/**
 * GitHub Copilot CLI's instruction files, and nothing else it would load from
 * a repository: its hooks, settings and MCP servers are configuration it
 * would run (ADR-0028). A path-specific file is given whole, its `applyTo`
 * included, since a planner cannot know which files a task will touch.
 */
export const COPILOT_REPO_CONFIG: RepoConfigReader = {
  instructions(workspace) {
    const root = repoRoot(workspace);
    const files: InstructionFile[] = [];
    const seen = new Set<string>();
    const at = { workspace, within: root };
    const plain = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readText(file);
      if (text !== undefined) files.push({ path: path.relative(workspace, file), text });
    };
    for (const dir of repoLevels(workspace)) {
      for (const { name, imports } of LEVEL_FILES) {
        if (imports) withImports(path.join(dir, name), at, seen, files);
        else plain(path.join(dir, name));
      }
      if (dir !== root && dir !== path.resolve(workspace)) continue;
      // A link out of the repository would hand the planner a file of the user's.
      for (const file of modularFiles(path.join(dir, MODULAR_DIR))) if (insideOnDisk(root, file)) plain(file);
    }
    return files;
  },

  // Instruction files only: a repository's MCP servers reach a planner only
  // once approved (ADR-0028), and this reader offers none for approval.
  projectServers: () => NO_SERVERS,
};
