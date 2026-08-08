import {
  BaseFileSystem,
  buildGrepArgs,
  buildGlobArgs,
  buildFallbackGrepArgs,
  filterFallbackByAnchoredInclude,
  applyHeadLimit,
  formatSearchOutput,
  researchToolsPath,
  withPath,
  SEARCH_EXCLUSIONS,
  STOPPED_TOOL_RESULT,
  type GrepOptions,
  type ReadFileOpts,
  type ToolOutcome,
} from '@ordewell/core';
import { promises as fs } from 'fs';
import * as path from 'path';
import { run } from './run';

/**
 * Everything here is async. It used to be `execSync`/`readFileSync`, which on
 * the web server blocked the entire Node event loop: one session running
 * `tree -L 4` over a monorepo stalled every other session's WebSocket
 * streaming, HTTP API, and plan-token delivery. It also makes the parallel
 * tool-round pre-pass in BaseAiService pointless, since concurrent calls into
 * a synchronous adapter still serialize.
 */

const SEARCH_TIMEOUT_MS = 20_000;
/** Generous, because an approved `bash` call may legitimately be a test suite. */
const BASH_TIMEOUT_MS = 120_000;

export class PoolFileSystem extends BaseFileSystem {
  constructor(private workspaceRoot: string) { super(); }
  getWorkspaceRoot(): string { return this.workspaceRoot; }

  /**
   * PATH for the search subprocesses. `execFile` starts them with no shell, so
   * on a Windows box whose POSIX tools live in the Git tree (`grep.exe` beside
   * the research shell) they are only resolvable with that directory prepended.
   * Identity on POSIX, where `utilsDir` is null. Kept in step with
   * VsCodeFileSystem.searchEnv.
   */
  private searchEnv(): NodeJS.ProcessEnv | undefined {
    const resolved = researchToolsPath(this.researchShell, process.env.PATH);
    // `withPath`, not a `PATH:` spread: on Windows the spread of `process.env`
    // carries `Path`, so adding `PATH` hands the child two and lets the OS pick.
    return resolved === (process.env.PATH ?? '') ? undefined : withPath(process.env, resolved);
  }

  private rgAvailable: Promise<boolean> | null = null;
  private hasRg(): Promise<boolean> {
    this.rgAvailable ??= run('rg', ['--version'], { timeout: 5_000, env: this.searchEnv() }).then((r) => r.code === 0).catch(() => false);
    return this.rgAvailable;
  }

  protected async readFileImpl(absPath: string, opts?: ReadFileOpts): Promise<ToolOutcome> {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return { success: false, output: `Not a file: ${absPath}`, truncated: false };

      // Hard file-size cap — return an actionable error so the model switches to grep
      const maxBytes = opts?.maxBytes ?? 1024;
      if (stat.size > maxBytes * 1024) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return {
          success: true,
          output: `File too large (${sizeMB} MB). Maximum is ${maxBytes} KB. Use grep to search for specific patterns instead.`,
          truncated: false,
        };
      }

      const content = await fs.readFile(absPath, 'utf8');
      const allLines = content.split('\n');
      // Discard the empty element from a trailing newline
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
      const totalLines = allLines.length;

      const startLine = opts?.offset ?? 0;
      const maxLines = opts?.limit ?? 2000;

      if (startLine >= totalLines) return { success: true, output: '', truncated: false };

      const selectedLines = allLines.slice(startLine, startLine + maxLines);
      const truncated = (startLine + maxLines) < totalLines;

      // Right-align line numbers so columns stay aligned across calls
      const lineWidth = String(totalLines).length;
      let output = selectedLines.map((line, i) => {
        const lineNum = String(startLine + i + 1).padStart(lineWidth);
        return `${lineNum}|${line}`;
      }).join('\n');

      // Actionable hint so the model knows how to continue
      if (truncated) {
        const nextOffset = startLine + maxLines;
        output += `\n\n(File has more lines — use offset=${nextOffset} to read beyond line ${nextOffset})\n`;
      }

      return { success: true, output, truncated };
    } catch (err) {
      return { success: false, output: `Error reading ${absPath}: ${(err as Error).message}`, truncated: false };
    }
  }

  protected async globImpl(pattern: string, absRoot: string, headLimit: number): Promise<ToolOutcome> {
    if (await this.hasRg()) {
      // ripgrep resolves a `--glob` pattern that contains a `/` against its own
      // cwd, not the `--` search path — without this, a daemon started outside
      // the workspace silently drops every anchored pattern ("src/**/*") to a
      // false "No files matched.".
      const anchor = await this.searchAnchor(absRoot);
      const result = await run('rg', buildGlobArgs(pattern, absRoot), { timeout: SEARCH_TIMEOUT_MS, cwd: anchor, env: this.searchEnv() });
      // rg exits 1 for "no files matched", which is a valid empty answer.
      if (result.code !== 0 && result.code !== 1 && !result.stdout) {
        return { success: false, output: `Glob failed: ${result.stderr.trim() || 'ripgrep error'}`, truncated: false };
      }
      const capped = applyHeadLimit(result.stdout, headLimit);
      return {
        success: true,
        output: formatSearchOutput(capped, anchor, { emptyMessage: 'No files matched.', hint: 'Narrow the pattern.' }),
        truncated: capped.truncated,
      };
    }

    // `find -path` treats `*` as crossing `/`, so `**` is not recursive there.
    // Translating to `-name` on the basename keeps the common cases honest
    // rather than silently returning a different result set than ripgrep would.
    const basename = pattern.split('/').pop() || pattern;
    const excludeArgs = SEARCH_EXCLUSIONS.flatMap((dir) => ['-not', '-path', `*/${dir}/*`]);
    const result = await run('find', [absRoot, '-type', 'f', '-name', basename, ...excludeArgs], { timeout: SEARCH_TIMEOUT_MS, env: this.searchEnv() });
    if (result.code !== 0 && !result.stdout) {
      return { success: false, output: `Glob failed: ${result.stderr.trim() || 'find error'}`, truncated: false };
    }
    const capped = applyHeadLimit(result.stdout, headLimit);
    return {
      success: true,
      output: formatSearchOutput(capped, absRoot, { emptyMessage: 'No files matched.' }),
      truncated: capped.truncated,
    };
  }

  /**
   * A directory to anchor a search in. `cwd` exists only so anchored
   * `--glob`/`--include` patterns resolve against the search root (see
   * globImpl), and spawn(2) rejects a `cwd` that is a file with ENOTDIR.
   *
   * `grep`'s `path` is documented as a directory, but the tool description
   * tells the model to survey with output_mode="files" and then re-run "on a
   * narrower path" — and what that survey hands back are files. rg and grep
   * both search a single file happily, so anchor at the parent rather than
   * failing a legitimately file-scoped search.
   */
  private async searchAnchor(absRoot: string): Promise<string> {
    try {
      return (await fs.stat(absRoot)).isDirectory() ? absRoot : path.dirname(absRoot);
    } catch {
      return absRoot;
    }
  }

  protected async grepImpl(pattern: string, absRoot: string, opts: GrepOptions): Promise<ToolOutcome> {
    const headLimit = opts.headLimit ?? 100;
    const useRg = await this.hasRg();
    // Same anchored-glob-vs-cwd hazard as globImpl: an `include` filter with a
    // `/` in it would otherwise resolve against the daemon's cwd, not absRoot.
    const anchor = await this.searchAnchor(absRoot);
    // GNU grep's `--include` only matches a basename, so an anchored pattern
    // like `subdir/*.txt` never matches there — strip it from the grep call
    // and filter matches by relative path afterward instead.
    const anchoredInclude = !useRg && opts.include?.includes('/') ? opts.include : undefined;
    const result = useRg
      ? await run('rg', buildGrepArgs(pattern, opts, absRoot).args, { timeout: SEARCH_TIMEOUT_MS, cwd: anchor, env: this.searchEnv() })
      : await run('grep', buildFallbackGrepArgs(pattern, anchoredInclude ? { ...opts, include: undefined } : opts, absRoot), { timeout: SEARCH_TIMEOUT_MS, cwd: anchor, env: this.searchEnv() });

    // Exit 1 is "no matches" for both tools — a successful search with an empty
    // result, not a failure. Anything else with no stdout is a real error.
    if (result.code !== 0 && result.code !== 1 && !result.stdout) {
      return { success: false, output: `Search failed: ${result.stderr.trim() || 'search error'}`, truncated: false };
    }

    const filteredStdout = anchoredInclude
      ? filterFallbackByAnchoredInclude(result.stdout, anchoredInclude, anchor, opts.outputMode)
      : result.stdout;
    const capped = applyHeadLimit(filteredStdout, headLimit);
    const hint = opts.outputMode === 'content'
      ? 'Re-run with output_mode="files" to see the full breadth, or narrow with include/path.'
      : 'Narrow with include/path.';
    return {
      success: true,
      output: formatSearchOutput(capped, anchor, { emptyMessage: 'No matches found.', hint }),
      truncated: capped.truncated,
    };
  }

  protected async listDirImpl(absPath: string, depth: number): Promise<ToolOutcome> {
    if (depth > 1) {
      const result = await run('tree', ['-L', String(depth), '-I', 'node_modules|.git|dist|build', absPath], { timeout: 10_000, env: this.searchEnv() });
      if (result.code === 0 && result.stdout.trim()) {
        const lines = result.stdout.trim().split('\n');
        return { success: true, output: lines.slice(0, 300).join('\n'), truncated: lines.length > 300 };
      }
      // `tree` is not installed everywhere; fall through to a flat listing.
    }
    try {
      const entries = await fs.readdir(absPath, { withFileTypes: true });
      const lines = entries.slice(0, 200).map((e) => `${e.isDirectory() ? 'D' : 'F'} ${e.name}`);
      return { success: true, output: lines.join('\n') || '(empty directory)', truncated: entries.length > 200 };
    } catch (err) {
      return { success: false, output: `Error listing ${absPath}: ${(err as Error).message}`, truncated: false };
    }
  }

  protected async execBashImpl(command: string, signal?: AbortSignal): Promise<ToolOutcome> {
    // `shell: true` is required now that approved commands may legitimately
    // contain pipes; the tier classifier in core (not string filtering here)
    // is what decides whether this command was allowed to reach the shell.
    //
    // `file: null` is that host default, unchanged on POSIX. A resolved file is
    // the POSIX shell found on a Windows box, invoked explicitly so the command
    // runs in the dialect `BaseFileSystem` classified it under.
    const { file, args } = this.researchShell;
    const result = file === null
      ? await run(command, [], { cwd: this.workspaceRoot, timeout: BASH_TIMEOUT_MS, shell: true, signal })
      : await run(file, [...args, command], { cwd: this.workspaceRoot, timeout: BASH_TIMEOUT_MS, signal });
    const out = (result.stdout || '').trim();
    const err = (result.stderr || '').trim();

    // A stopped turn reports as a stop, not as a mysterious non-zero exit: the
    // child was killed on purpose and there is nothing here to diagnose.
    if (signal?.aborted) return { success: false, output: STOPPED_TOOL_RESULT, truncated: false };

    if (result.code !== 0) {
      const detail = err || out || `exited with code ${result.code}`;
      // A failing command is still research: the model asked to diagnose, and
      // the failure output is usually the answer. Report it, do not swallow it.
      return { success: false, output: `Command exited ${result.code}:\n${detail.slice(0, 20_000)}`, truncated: detail.length > 20_000 };
    }

    const combined = err ? `${out}\n[stderr]\n${err}` : out;
    return { success: true, output: combined || '(no output)', truncated: combined.length > 20_000 };
  }
}
