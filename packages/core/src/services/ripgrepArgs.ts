import path from 'node:path';
import { GrepOptions, SEARCH_EXCLUSIONS } from '../interfaces/IFileSystem';

/**
 * Argument construction for the search tools, shared by every filesystem
 * adapter. Two reasons this is core and not per-adapter:
 *
 *  1. The exclusion set and the result cap are policy. `glob` used to pass
 *     `--iglob '!node_modules'` and friends while `grep` passed nothing, so a
 *     repo that did not gitignore `dist/` spent its whole result budget on
 *     build output in one tool but not the other.
 *
 *  2. Arguments are returned as an array for `execFile`, never as a shell
 *     string. The previous string interpolation escaped only double quotes,
 *     which meant a pattern containing a backtick or `$(` was a command
 *     injection through the planner's own search box.
 */

/** Ordering is part of the result quality: with a hard cap, what you drop matters. */
const SORT_BY_RECENCY = ['--sortr', 'modified'];

function exclusionArgs(): string[] {
  return SEARCH_EXCLUSIONS.flatMap((dir) => ['--glob', `!**/${dir}/**`]);
}

export interface GrepInvocation {
  args: string[];
  /** Rows beyond this are dropped by the caller — see `applyHeadLimit`. */
  headLimit: number;
}

/**
 * Build the ripgrep invocation for one grep call.
 *
 * `--max-count` is deliberately absent. It caps matches *per file*, so the old
 * `--max-count 100` on a 300-file hit returned ~30 000 lines, blew the 1 MB
 * exec buffer, and surfaced as `{ success: false, output: '' }` — a silent
 * empty result on exactly the broad searches where the model most needed a
 * signal. The cap belongs at the row level, applied after the fact.
 */
export function buildGrepArgs(pattern: string, opts: GrepOptions, root: string): GrepInvocation {
  // ripgrep applies `--glob` in order with last-wins, so the include must come
  // before the exclusions — otherwise `--glob '*.ts'` would override the
  // `!**/node_modules/**` negations and search build output.
  const args = ['--no-heading', '--color', 'never', ...SORT_BY_RECENCY];
  if (opts.include) args.push('--glob', opts.include);
  args.push(...exclusionArgs());

  if (opts.literal) args.push('--fixed-strings');
  if (opts.caseInsensitive) args.push('--ignore-case');

  switch (opts.outputMode) {
    case 'files':
      args.push('--files-with-matches');
      break;
    case 'count':
      args.push('--count-matches');
      break;
    default:
      args.push('--line-number');
      if (opts.contextBefore) args.push('--before-context', String(opts.contextBefore));
      if (opts.contextAfter) args.push('--after-context', String(opts.contextAfter));
  }

  // `-e` and `--` keep a pattern or path that begins with `-` from being read as a flag.
  args.push('-e', pattern, '--', root);
  return { args, headLimit: opts.headLimit ?? 100 };
}

/** Build the ripgrep invocation that lists files matching a glob. */
export function buildGlobArgs(pattern: string, root: string): string[] {
  // Include before exclusions: ripgrep's `--glob` is last-wins, so the include
  // must precede the negations or it would override them.
  return ['--files', ...SORT_BY_RECENCY, '--glob', pattern, ...exclusionArgs(), '--', root];
}

/**
 * The POSIX-grep fallback for machines without ripgrep. Ordering and `--sort`
 * are unavailable.
 *
 * `-P` (PCRE) is required, not optional: patterns built in core — most
 * notably `find_symbol`'s `definitionPattern` — use non-capturing groups and
 * `\b`, which BRE has no syntax for and ERE (`-E`) still cannot express
 * ((?:...) is a PCRE construct). Without `-P`, GNU grep either errors
 * ("Unmatched \{") or, worse, silently treats `(`/`)`/`|` as literal
 * characters and reports a confident empty result. `-P` and `-F` are
 * mutually exclusive, so literal mode skips it.
 */
export function buildFallbackGrepArgs(pattern: string, opts: GrepOptions, root: string): string[] {
  const args = ['-r', '-n'];
  if (opts.literal) args.push('-F');
  else args.push('-P');
  if (opts.caseInsensitive) args.push('-i');
  if (opts.outputMode === 'files') args.push('-l');
  if (opts.outputMode === 'count') args.push('-c');
  if (opts.outputMode !== 'files' && opts.outputMode !== 'count') {
    if (opts.contextBefore) args.push('-B', String(opts.contextBefore));
    if (opts.contextAfter) args.push('-A', String(opts.contextAfter));
  }
  if (opts.include) args.push(`--include=${opts.include}`);
  for (const dir of SEARCH_EXCLUSIONS) args.push(`--exclude-dir=${dir}`);
  args.push('-e', pattern, root);
  return args;
}

function globSegmentToRegex(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
}

/** `subdir/*.txt`-style glob match against a path relative to the search root. */
function matchesAnchoredGlob(relPath: string, pattern: string): boolean {
  const regex = pattern.split('/').map((seg) => (seg === '**' ? '.*' : globSegmentToRegex(seg))).join('/');
  return new RegExp(`^${regex}$`).test(relPath);
}

function extractFallbackGrepPath(line: string, outputMode?: GrepOptions['outputMode']): string {
  if (outputMode === 'files') return line;
  if (outputMode === 'count') return line.slice(0, line.lastIndexOf(':'));
  // content mode: "path:lineNumber:content" — cut before the line-number marker.
  const match = line.match(/^(.*?):\d+:/);
  return match ? match[1] : line;
}

/**
 * GNU grep's own `--include` glob only ever matches a basename, so it silently
 * matches nothing against an anchored pattern like `subdir/*.txt` (there is no
 * `/` in a basename to match against). The fallback path drops such patterns
 * from the grep invocation and filters matches by relative path here instead.
 */
export function filterFallbackByAnchoredInclude(stdout: string, include: string, anchor: string, outputMode?: GrepOptions['outputMode']): string {
  return stdout
    .split('\n')
    .filter((line) => {
      if (!line) return false;
      const reportedPath = extractFallbackGrepPath(line, outputMode);
      const relPath = path.isAbsolute(reportedPath) ? path.relative(anchor, reportedPath) : reportedPath;
      return matchesAnchoredGlob(relPath, include);
    })
    .join('\n');
}

export interface CappedRows {
  rows: string[];
  truncated: boolean;
  total: number;
}

/** Apply the global row cap and report honestly whether anything was dropped. */
export function applyHeadLimit(stdout: string, headLimit: number): CappedRows {
  const all = stdout.split('\n').filter((line) => line.length > 0);
  return { rows: all.slice(0, headLimit), truncated: all.length > headLimit, total: all.length };
}

/**
 * Render capped rows for the model, with paths made workspace-relative and an
 * explicit note when rows were dropped — a silently truncated list reads as a
 * complete answer and the model plans against it.
 */
export function formatSearchOutput(
  capped: CappedRows,
  root: string,
  opts: { emptyMessage: string; hint?: string; sep?: string },
): string {
  if (capped.rows.length === 0) return opts.emptyMessage;

  // Only strip the workspace prefix; the filesystem root (`/`) has no useful
  // prefix to strip and dropping a leading slash would keep the model from
  // passing the path back to read_file.
  //
  // The separator is the host's, not `/`. ripgrep on Windows emits
  // `C:\repo\src\a.ts:12:…` against a root of `C:\repo`, so a hardcoded `/`
  // built the prefix `C:\repo/`, matched nothing, and left every row absolute —
  // paying full path length for every result on every search.
  const sep = opts.sep ?? path.sep;
  const prefix = root === sep || root.endsWith(sep) ? root : `${root}${sep}`;
  const body = prefix === sep ? capped.rows.join('\n') : capped.rows.map((row) => (row.startsWith(prefix) ? row.slice(prefix.length) : row)).join('\n');
  if (!capped.truncated) return body;

  const hint = opts.hint ? ` ${opts.hint}` : '';
  return `${body}\n\n[showing ${capped.rows.length} of ${capped.total} results.${hint}]`;
}
