import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { SEARCH_EXCLUSIONS } from '../../../../interfaces/IFileSystem';
import { applyHeadLimit, buildGlobArgs } from '../../../ripgrepArgs';
import { resolveResearchShell } from '../../../researchShell';
import { display, PathRefusal, resolveReadable } from './paths';
import { hasRipgrep, runSearch, searchTarget } from './search';
import { buildToolEnv } from './shellEnv';
import type { OrdewellTool } from './types';

const MAX_FILES = 500;

/** `**`, `*`, `?` and `{a,b}` against a `/`-separated path relative to the search root; a pattern with no `/` matches at any depth, as rg's does. */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.includes('/') ? pattern.replace(/^\.?\//, '') : `**/${pattern}`;
  let out = '';
  let braces = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '*' && source[i + 1] === '*') {
      const slash = source[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') { braces++; out += '(?:'; }
    else if (c === '}' && braces > 0) { braces--; out += ')'; }
    else if (c === ',' && braces > 0) out += '|';
    else out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Tracked and untracked-but-not-ignored files, which is what honouring .gitignore means without rg; null outside a git checkout. */
function gitFiles(cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string[] | null> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, env, signal, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
        resolve(err ? null : stdout.split('\0').filter(Boolean));
      });
    } catch {
      resolve(null);
    }
  });
}

async function walk(dir: string, rel = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      if (!SEARCH_EXCLUSIONS.includes(entry.name)) found.push(...await walk(dir, rel ? `${rel}/${entry.name}` : entry.name));
    } else if (entry.isFile()) found.push(rel ? `${rel}/${entry.name}` : entry.name);
  }
  return found;
}

async function byNewest(root: string, files: string[]): Promise<string[]> {
  const stats = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(path.join(root, file)).catch(() => null))?.mtimeMs })));
  // git still lists a tracked file that was deleted from the working tree.
  const dated = stats.filter((s): s is { file: string; mtime: number } => s.mtime !== undefined);
  return dated.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)).map((d) => d.file);
}

export const globTool: OrdewellTool = {
  name: 'glob',
  description: `Find files by name pattern, such as "**/*.ts" or "src/**/test_*.py". Returns paths relative to the worktree, most recently modified first, at most ${MAX_FILES}. Honours .gitignore and skips dependency and build folders.`,
  effect: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths against.' },
      path: { type: 'string', description: 'Folder to search, relative to the worktree. Default: the worktree.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const pattern = String(args.pattern);
    if (pattern === '') return { text: 'pattern is empty.', isError: true };
    let target: { root: string; anchor: string };
    try {
      target = await searchTarget(resolveReadable(context, typeof args.path === 'string' ? args.path : '.'));
    } catch (err) {
      if (err instanceof PathRefusal) return { text: err.message, isError: true };
      return { text: `${String(args.path ?? '.')} does not exist.`, isError: true };
    }
    const env = buildToolEnv(context.env, resolveResearchShell());

    let files: string[];
    let engine = 'ripgrep';
    if (await hasRipgrep(env, target.anchor)) {
      // --hidden/--no-require-git for the reasons grep gives; rg already sorts newest first.
      const result = await runSearch('rg', ['--hidden', '--no-require-git', ...buildGlobArgs(pattern, target.root)], { cwd: target.anchor, env, signal: context.signal });
      if (result.code !== 0 && result.code !== 1 && !result.stdout) return { text: `Glob failed: ${result.stderr.trim() || 'ripgrep error'}`, isError: true };
      files = result.stdout.split('\n').filter(Boolean).map((p) => path.relative(target.root, p));
    } else {
      engine = 'git ls-files, or a directory walk (ripgrep is not installed)';
      const listed = await gitFiles(target.root, env, context.signal);
      const candidates = (listed ?? await walk(target.root)).map((p) => p.split(path.sep).join('/'));
      const wanted = globToRegExp(pattern);
      files = await byNewest(target.root, candidates.filter((p) => wanted.test(p) && !p.split('/').some((seg) => SEARCH_EXCLUSIONS.includes(seg))));
    }

    const capped = applyHeadLimit(files.join('\n'), MAX_FILES);
    if (capped.rows.length === 0) return { text: 'No files matched.', isError: false, details: { files: 0, engine } };
    // Relative to the worktree, not to the folder searched, so the path can go straight back to read.
    const shown = capped.rows.map((p) => display(context, path.join(target.root, p)).split(path.sep).join('/'));
    const note = capped.truncated ? `\n(Showing the first ${MAX_FILES} of ${capped.total} files. Narrow the pattern or path.)` : '';
    return { text: shown.join('\n') + note, isError: false, details: { files: capped.total, engine } };
  },
};
