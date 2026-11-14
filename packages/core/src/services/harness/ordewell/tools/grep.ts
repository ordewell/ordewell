import path from 'node:path';
import { buildFallbackGrepArgs, buildGrepArgs, filterFallbackByAnchoredInclude, GREP_PCRE_PROBE_ARGS, grepRegexFromProbe, applyHeadLimit } from '../../../ripgrepArgs';
import { resolveResearchShell } from '../../../researchShell';
import { display, PathRefusal, resolveReadable } from './paths';
import { hasRipgrep, runSearch, searchTarget } from './search';
import { buildToolEnv } from './shellEnv';
import type { OrdewellTool, ToolContext } from './types';

const MAX_ROWS = 200;

/** `path:line:text` rows from rg or grep, as `relative/path:line: text`. */
function formatRows(rows: string[], context: ToolContext): string[] {
  return rows.map((row) => {
    const match = row.match(/^(.*?):(\d+):(.*)$/);
    if (!match) return row;
    // Both programs were given an absolute root; the model sees paths it can hand back to read.
    const file = path.isAbsolute(match[1]) ? display(context, match[1]) : match[1];
    return `${file.split(path.sep).join('/')}:${match[2]}: ${match[3]}`;
  });
}

export const grepTool: OrdewellTool = {
  name: 'grep',
  description: `Search file contents with a regular expression (ripgrep). Returns "path:line: text" rows, most recently modified files first, at most ${MAX_ROWS}. Honours .gitignore and skips dependency and build folders. Narrow with path and glob.`,
  effect: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or folder to search, relative to the worktree. Default: the worktree.' },
      glob: { type: 'string', description: 'Only search files matching this glob, such as "*.ts" or "src/**/*.tsx".' },
      ignoreCase: { type: 'boolean', description: 'Match case-insensitively. Default false.' },
      literal: { type: 'boolean', description: 'Treat pattern as plain text, not a regular expression. Default false.' },
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
    const options = {
      include: typeof args.glob === 'string' && args.glob !== '' ? args.glob : undefined,
      caseInsensitive: args.ignoreCase === true,
      literal: args.literal === true,
    };
    const env = buildToolEnv(context.env, resolveResearchShell());
    const run = { cwd: target.anchor, env, signal: context.signal };

    const useRg = await hasRipgrep(env, target.anchor);
    let stdout: string;
    let engine: string;
    if (useRg) {
      engine = 'ripgrep';
      // --with-filename: rg leaves the name off when it is given exactly one file. --hidden/--no-require-git: dotfiles are code, and .gitignore means something outside a git checkout too.
      const built = buildGrepArgs(pattern, { ...options, outputMode: 'content' }, target.root);
      const result = await runSearch('rg', ['--with-filename', '--hidden', '--no-require-git', ...built.args], run);
      // 1 is "no match" for rg and grep alike.
      if (result.code !== 0 && result.code !== 1 && !result.stdout) return { text: `Search failed: ${result.stderr.trim() || 'ripgrep error'}`, isError: true };
      stdout = result.stdout;
    } else {
      engine = 'grep (ripgrep is not installed)';
      const probe = await runSearch('grep', GREP_PCRE_PROBE_ARGS, run);
      // GNU grep's --include matches a basename only, so an anchored glob is filtered afterwards.
      const anchored = options.include?.includes('/') ? options.include : undefined;
      const fallback = buildFallbackGrepArgs(pattern, anchored ? { ...options, include: undefined } : options, target.root, grepRegexFromProbe(probe.code));
      const result = await runSearch('grep', ['-H', ...fallback], run);
      if (result.code === null) return { text: 'Neither ripgrep (rg) nor grep could be started, so the search cannot run. Use the shell tool or read the files directly.', isError: true };
      if (result.code !== 0 && result.code !== 1 && !result.stdout) return { text: `Search failed: ${result.stderr.trim() || 'grep error'}`, isError: true };
      stdout = anchored ? filterFallbackByAnchoredInclude(result.stdout, anchored, target.anchor) : result.stdout;
    }

    const capped = applyHeadLimit(stdout, MAX_ROWS);
    if (capped.rows.length === 0) return { text: 'No matches found.', isError: false, details: { matches: 0, engine } };
    const rows = formatRows(capped.rows, context);
    const note = capped.truncated ? `\n(Showing the first ${MAX_ROWS} of ${capped.total} matches. Narrow with path or glob.)` : '';
    return { text: rows.join('\n') + note, isError: false, details: { matches: capped.total, engine } };
  },
};
