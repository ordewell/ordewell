import {
  IFileSystem,
  ReadFileOpts,
  GrepOptions,
  GlobOptions,
  FindSymbolOptions,
  ToolOutcome,
  GREP_DEFAULT_HEAD_LIMIT,
} from '../interfaces/IFileSystem';
import { IApproval, DENY_ALL } from '../interfaces/IApproval';
import { classifyCommand, pathLikeArgs } from './commandPolicy';
import { resolveResearchShell, researchShellWarning, type ResearchShell } from './researchShell';
import { resolveWithin, grantScopeFor } from './pathScope';
import { definitionPattern, referencePattern, languageForId, includeGlobFor } from './symbolPatterns';

export { AUTO_COMMANDS, GIT_READONLY_SUBCOMMANDS, REFUSED_COMMANDS, classifyCommand, pathLikeArgs } from './commandPolicy';

/**
 * The policy half of the planner's filesystem: path confinement, the tiered
 * `bash` gate, and the definition-first symbol lookup. Adapters supply only the
 * mechanics (`*Impl`), so the rules live in one place across the web server and
 * the VS Code extension rather than being re-derived per surface.
 *
 * Every public method resolves and authorizes before delegating, and every
 * `*Impl` therefore receives an absolute, already-approved path. Previously
 * each adapter did its own resolution, and `path.isAbsolute(p) ? p : …` meant
 * an absolute path walked straight out of the workspace with no prompt and no
 * record.
 */
export abstract class BaseFileSystem implements IFileSystem {
  private approval: IApproval = DENY_ALL;

  /**
   * The interpreter `execBashImpl` will hand the command to. Owned here rather
   * than per-adapter because {@link classifyCommand} has to be told the same
   * answer: a command lexed under POSIX rules and then run by cmd.exe is a
   * command this class did not actually classify.
   */
  protected readonly researchShell: ResearchShell = resolveResearchShell();

  /** Surfaces inject the human channel here; without it, external access is denied. */
  setApproval(approval: IApproval): void {
    this.approval = approval;
  }

  abstract getWorkspaceRoot(): string;

  protected abstract readFileImpl(absPath: string, opts?: ReadFileOpts): Promise<ToolOutcome>;
  protected abstract globImpl(pattern: string, absRoot: string, headLimit: number): Promise<ToolOutcome>;
  protected abstract grepImpl(pattern: string, absRoot: string, opts: GrepOptions): Promise<ToolOutcome>;
  protected abstract listDirImpl(absPath: string, depth: number): Promise<ToolOutcome>;
  protected abstract execBashImpl(command: string, signal?: AbortSignal): Promise<ToolOutcome>;

  /**
   * Resolve `p` and confirm the planner may touch it. In-workspace paths pass
   * silently; anything else needs one approval, remembered per containing
   * directory so a second file in the same place does not prompt again.
   */
  protected async authorizePath(
    p: string,
    kind: 'file' | 'directory' = 'file',
  ): Promise<{ ok: true; abs: string } | { ok: false; outcome: ToolOutcome }> {
    const root = this.getWorkspaceRoot();
    const { abs, inside } = resolveWithin(root, p);
    if (inside) return { ok: true, abs };

    const granted = await this.approval.request({
      kind: 'external_path',
      subject: abs,
      scope: grantScopeFor(abs, kind),
      detail: `Planner research wants to read ${abs}, outside the workspace (${root}).`,
    });
    if (granted) return { ok: true, abs };

    return {
      ok: false,
      outcome: {
        success: false,
        output: `Access denied: "${abs}" is outside the workspace root (${root}) and was not approved. Keep research inside the workspace, or ask the user to approve this location.`,
        truncated: false,
      },
    };
  }

  async readFile(p: string, opts?: ReadFileOpts): Promise<ToolOutcome> {
    const auth = await this.authorizePath(p, 'file');
    return auth.ok ? this.readFileImpl(auth.abs, opts) : auth.outcome;
  }

  async readFiles(paths: string[]): Promise<ToolOutcome> {
    const results: string[] = [];
    let truncated = false;
    for (const p of paths) {
      const r = await this.readFile(p);
      // Denials are reported inline: silently dropping them would let the model
      // believe a file was empty rather than out of bounds.
      if (r.success) {
        results.push(`--- ${p} ---\n${r.output}`);
        if (r.truncated) truncated = true;
      } else if (r.output) {
        results.push(`--- ${p} ---\n[not read] ${r.output}`);
      }
    }
    if (results.length === 0) return { success: false, output: 'No files read.', truncated: false };
    return { success: true, output: results.join('\n\n'), truncated };
  }

  async glob(pattern: string, opts?: GlobOptions): Promise<ToolOutcome> {
    const auth = await this.authorizePath(opts?.path ?? '.', 'directory');
    if (!auth.ok) return auth.outcome;
    return this.globImpl(pattern, auth.abs, opts?.headLimit ?? 200);
  }

  async grep(pattern: string, opts?: GrepOptions): Promise<ToolOutcome> {
    const auth = await this.authorizePath(opts?.path ?? '.', 'directory');
    if (!auth.ok) return auth.outcome;
    return this.grepImpl(pattern, auth.abs, {
      ...opts,
      headLimit: opts?.headLimit ?? GREP_DEFAULT_HEAD_LIMIT,
      outputMode: opts?.outputMode ?? 'content',
    });
  }

  async listDir(p: string, depth?: number): Promise<ToolOutcome> {
    const auth = await this.authorizePath(p, 'directory');
    return auth.ok ? this.listDirImpl(auth.abs, depth ?? 1) : auth.outcome;
  }

  /**
   * Definitions first, then a reference tally. Two bounded searches beat one
   * unbounded `grep` because the 100-row budget gets spent on the rows that
   * answer the question.
   */
  async findSymbol(symbol: string, opts?: FindSymbolOptions): Promise<ToolOutcome> {
    const name = symbol.trim();
    if (!name) {
      return { success: false, output: 'find_symbol requires a non-empty "symbol".', truncated: false };
    }

    const auth = await this.authorizePath(opts?.path ?? '.', 'directory');
    if (!auth.ok) return auth.outcome;

    const language = opts?.language ? languageForId(opts.language) : undefined;
    if (opts?.language && !language) {
      return {
        success: false,
        output: `Unknown language "${opts.language}". Omit it to search every language, or pass a file extension such as ".go".`,
        truncated: false,
      };
    }
    const include = language ? includeGlobFor(language) : undefined;

    const [defs, refs] = await Promise.all([
      this.grepImpl(definitionPattern(name, language), auth.abs, { include, outputMode: 'content', headLimit: 40 }),
      this.grepImpl(referencePattern(name), auth.abs, { include, outputMode: 'count', headLimit: 40 }),
    ]);

    const sections: string[] = [];
    const foundDefs = defs.success && defs.output.trim() && !/^No matches/i.test(defs.output.trim());
    sections.push(foundDefs
      ? `=== Definitions of "${name}" ===\n${defs.output.trim()}`
      : `=== Definitions of "${name}" ===\nNone matched the definition patterns. The symbol may be generated, re-exported, or defined in a language find_symbol does not cover — fall back to grep.`);

    if (refs.success && refs.output.trim() && !/^No matches/i.test(refs.output.trim())) {
      sections.push(`=== References by file (match count) ===\n${refs.output.trim()}`);
    }

    return {
      success: true,
      output: sections.join('\n\n'),
      truncated: defs.truncated || refs.truncated,
    };
  }

  /**
   * Path confinement for `bash`: an `auto`-tier binary (`cat`, `find`, `rg`, …)
   * is only auto because *reading* is read-only — its arguments can still
   * name a path outside the workspace, which is the exact escape confinement
   * closes for `readFile`/`glob`/`grep`. Each escaping path needs its own
   * approval (scoped to its containing directory); approving one does not
   * approve another, so a single command touching two external dirs prompts
   * once per distinct scope rather than carrying the first grant to the rest.
   */
  private async authorizeCommandPaths(command: string): Promise<ToolOutcome | null> {
    const root = this.getWorkspaceRoot();
    const escaping = pathLikeArgs(command, { dialect: this.researchShell.dialect })
      .filter((p) => !resolveWithin(root, p).inside);
    if (escaping.length === 0) return null;

    for (const p of escaping) {
      const abs = resolveWithin(root, p).abs;
      const granted = await this.approval.request({
        kind: 'external_path',
        subject: abs,
        scope: grantScopeFor(abs, 'file'),
        detail: `Planner research wants to run "${command}", which touches ${abs}, outside the workspace (${root}).`,
      });
      if (!granted) {
        return {
          success: false,
          output: `Access denied: "${command}" touches ${abs}, outside the workspace root (${root}), and was not approved. Keep research inside the workspace, or ask the user to approve this location.`,
          truncated: false,
        };
      }
    }
    return null;
  }

  /**
   * Three tiers (see `commandPolicy.ts`): read-only inspection runs silently,
   * anything else asks once and is remembered, and writes are refused outright
   * because a planner that mutates the workspace has stopped being a planner.
   */
  async bash(command: string, signal?: AbortSignal): Promise<ToolOutcome> {
    const { tier, scope, reason } = classifyCommand(command, { dialect: this.researchShell.dialect });

    if (tier === 'refuse') {
      return { success: false, output: `Command refused: ${reason}`, truncated: false };
    }

    const pathDenial = await this.authorizeCommandPaths(command);
    if (pathDenial) return pathDenial;

    if (tier === 'ask') {
      const granted = await this.approval.request({
        kind: 'shell_command',
        subject: command,
        scope,
        detail: `Planner research wants to run: ${command}`,
      });
      if (!granted) {
        return {
          success: false,
          output: `Command not approved: ${command}\nIt is outside the auto-allowed read-only set (${scope}). Continue with the read-only research tools, or ask the user to approve it.`,
          truncated: false,
        };
      }
    }

    const outcome = await this.execBashImpl(command, signal);
    if (outcome.success) return outcome;

    // A command that failed under cmd.exe most likely failed because the tool
    // does not exist there. Saying so turns "exited 1" into something the model
    // can act on — and, per the fail-visibly contract, keeps a degraded research
    // surface from reading as a repository that simply had no answer.
    const warning = researchShellWarning(this.researchShell);
    return warning ? { ...outcome, output: `${outcome.output}\n\n[${warning}]` } : outcome;
  }
}
