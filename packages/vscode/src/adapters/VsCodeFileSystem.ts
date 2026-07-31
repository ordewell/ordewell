import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promises as nodeFs } from 'fs';
import * as path from 'path';
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
  type GrepOptions,
  type ReadFileOpts,
  type ToolOutcome,
} from '@ordewell/core';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 20_000;
/** Generous, because an approved `bash` call may legitimately be a test suite. */
const BASH_TIMEOUT_MS = 120_000;

interface ExecResult { stdout: string; stderr: string; code: number | null }

function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeout: number; shell?: boolean | string; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Node hands only ENOENT/EAGAIN/EMFILE/ENFILE from spawn(2) to the
    // callback; every other errno — ENOTDIR for a `cwd` that is a file, EACCES
    // for one it cannot enter — is thrown synchronously, which would reject
    // this promise and abort the whole planner turn instead of the one tool
    // call. Kept in step with PoolFileSystem.run, which had the same defect.
    try {
      execFile(file, args, {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        shell: opts.shell,
        env: opts.env,
      }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      });
    } catch (err) {
      // `code: null` rather than 1: the search adapters read 0 and 1 as "ran,
      // possibly no matches", so a 1 would surface a confident "No matches
      // found." for a search that never executed.
      resolve({ stdout: '', stderr: (err as Error).message, code: null });
    }
  });
}

/**
 * The VS Code adapter keeps using workspace APIs where they are genuinely
 * better (`workspace.fs` respects remote/virtual filesystems, `findFiles`
 * respects the user's `files.exclude`), and shells out for content search
 * exactly like the web adapter — through the same core argument builders, so
 * the two surfaces cannot drift on exclusions, result caps, or ordering.
 *
 * All paths arriving at `*Impl` are absolute and already approved by
 * `BaseFileSystem`; the adapter never re-derives containment.
 */
export class VsCodeFileSystem extends BaseFileSystem {
  getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /**
   * PATH for the search subprocesses. `execFile` starts them with no shell, so
   * on a Windows box whose POSIX tools live in the Git tree (`grep.exe` beside
   * the research shell) they are only resolvable with that directory prepended.
   * Identity on POSIX, where `utilsDir` is null.
   */
  private searchEnv(): NodeJS.ProcessEnv | undefined {
    const resolved = researchToolsPath(this.researchShell, process.env.PATH);
    // `withPath`, not a `PATH:` spread: on Windows the spread of `process.env`
    // carries `Path`, so adding `PATH` hands the child two and lets the OS pick.
    return resolved === (process.env.PATH ?? '') ? undefined : withPath(process.env, resolved);
  }

  private rgAvailable: Promise<boolean> | null = null;
  private hasRg(): Promise<boolean> {
    this.rgAvailable ??= run('rg', ['--version'], { timeout: 5_000, env: this.searchEnv() })
      .then((r) => r.code === 0)
      .catch(() => false);
    return this.rgAvailable;
  }

  protected async readFileImpl(absPath: string, opts?: ReadFileOpts): Promise<ToolOutcome> {
    try {
      const uri = vscode.Uri.file(absPath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) {
        return { success: false, output: `Not a file: ${absPath}`, truncated: false };
      }

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

      const data = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(data).toString('utf-8');
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
      return { success: false, output: `Error reading ${absPath}: ${err}`, truncated: false };
    }
  }

  protected async globImpl(pattern: string, absRoot: string, headLimit: number): Promise<ToolOutcome> {
    // `findFiles` is only correct for the workspace itself; an approved
    // external root has to go through ripgrep like the web adapter does.
    if (absRoot !== this.getWorkspaceRoot()) {
      // ripgrep resolves a `--glob` pattern that contains a `/` against its own
      // cwd, not the `--` search path — without this, an anchored pattern
      // ("src/**/*") silently drops to a false "No files matched.".
      const anchor = await this.searchAnchor(absRoot);
      const result = await run('rg', buildGlobArgs(pattern, absRoot), { timeout: SEARCH_TIMEOUT_MS, cwd: anchor, env: this.searchEnv() });
      if (result.code !== 0 && result.code !== 1 && !result.stdout) {
        return { success: false, output: `Glob failed: ${result.stderr.trim() || 'ripgrep error'}`, truncated: false };
      }
      const capped = applyHeadLimit(result.stdout, headLimit);
      return {
        success: true,
        output: formatSearchOutput(capped, anchor, { emptyMessage: 'No files matched.' }),
        truncated: capped.truncated,
      };
    }

    try {
      const exclude = `**/{${SEARCH_EXCLUSIONS.join(',')}}/**`;
      const uris = await vscode.workspace.findFiles(pattern, exclude, headLimit);
      const paths = uris.map((u) => vscode.workspace.asRelativePath(u, false));
      return {
        success: true,
        output: paths.length > 0 ? paths.join('\n') : 'No files matched.',
        truncated: uris.length >= headLimit,
      };
    } catch (err) {
      return { success: false, output: `Glob error: ${err}`, truncated: false };
    }
  }

  /**
   * A directory to anchor a search in. `cwd` exists only so anchored
   * `--glob`/`--include` patterns resolve against the search root, and spawn(2)
   * rejects a `cwd` that is a file with ENOTDIR. The tool description invites
   * a file here — it tells the model to survey with output_mode="files" then
   * re-run on "a narrower path" — and rg/grep search a single file fine, so
   * anchor at the parent instead of failing the search. Node `stat` rather than
   * `workspace.fs`: this path already shells out to a local process.
   */
  private async searchAnchor(absRoot: string): Promise<string> {
    try {
      return (await nodeFs.stat(absRoot)).isDirectory() ? absRoot : path.dirname(absRoot);
    } catch {
      return absRoot;
    }
  }

  protected async grepImpl(pattern: string, absRoot: string, opts: GrepOptions): Promise<ToolOutcome> {
    const headLimit = opts.headLimit ?? 100;
    const useRg = await this.hasRg();
    // Same anchored-glob-vs-cwd hazard as globImpl: an `include` filter with a
    // `/` in it would otherwise resolve against the extension host's cwd, not absRoot.
    const anchor = await this.searchAnchor(absRoot);
    // GNU grep's `--include` only matches a basename, so an anchored pattern
    // like `subdir/*.txt` never matches there — strip it from the grep call
    // and filter matches by relative path afterward instead.
    const anchoredInclude = !useRg && opts.include?.includes('/') ? opts.include : undefined;
    const result = useRg
      ? await run('rg', buildGrepArgs(pattern, opts, absRoot).args, { timeout: SEARCH_TIMEOUT_MS, cwd: anchor, env: this.searchEnv() })
      : await run('grep', buildFallbackGrepArgs(pattern, anchoredInclude ? { ...opts, include: undefined } : opts, absRoot), { timeout: SEARCH_TIMEOUT_MS, cwd: anchor, env: this.searchEnv() });

    // Exit 1 means "no matches" for both tools — an empty success, not an error.
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
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absPath));
      const lines = entries.slice(0, 200).map(([name, type]) =>
        `${type === vscode.FileType.Directory ? 'D' : 'F'} ${name}`
      );
      return { success: true, output: lines.join('\n') || '(empty directory)', truncated: entries.length > 200 };
    } catch (err) {
      return { success: false, output: `List error: ${err}`, truncated: false };
    }
  }

  protected async execBashImpl(command: string): Promise<ToolOutcome> {
    // `file: null` means "host default", i.e. the `shell: true` this always
    // did — unchanged on POSIX. A resolved file is the POSIX shell found on a
    // Windows box, invoked explicitly so the command runs in the dialect
    // `BaseFileSystem` classified it under.
    const { file, args } = this.researchShell;
    const result = file === null
      ? await run(command, [], { cwd: this.getWorkspaceRoot(), timeout: BASH_TIMEOUT_MS, shell: true })
      : await run(file, [...args, command], { cwd: this.getWorkspaceRoot(), timeout: BASH_TIMEOUT_MS });
    const out = (result.stdout || '').trim();
    const err = (result.stderr || '').trim();

    if (result.code !== 0) {
      const detail = err || out || `exited with code ${result.code}`;
      // A failing command is still research — the failure output is usually
      // the answer the model was diagnosing toward.
      return { success: false, output: `Command exited ${result.code}:\n${detail.slice(0, 20_000)}`, truncated: detail.length > 20_000 };
    }

    const combined = err ? `${out}\n[stderr]\n${err}` : out;
    return { success: true, output: combined || '(no output)', truncated: combined.length > 20_000 };
  }
}
