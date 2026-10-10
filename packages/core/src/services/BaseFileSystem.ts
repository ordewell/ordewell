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
import { classifyCommand, pathRefs, type CommandPolicyOptions } from './commandPolicy';
import { resolveResearchShell, researchShellWarning, researchPolicyOptions, type ResearchShell } from './researchShell';
import { resolveWithin, resolveRef, grantScopeFor, isInertDevice } from './pathScope';
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
   * closes for `readFile`/`glob`/`grep`. Each escaping path is scoped to its
   * containing directory, one entry per distinct scope.
   */
  private outsidePaths(command: string): Array<{ abs: string; scope: string }> {
    const root = this.getWorkspaceRoot();
    const found = new Map<string, string>();
    for (const ref of pathRefs(command, this.policyOptions())) {
      const { abs, inside } = resolveRef(root, ref);
      if (inside || isInertDevice(abs)) continue;
      const scope = grantScopeFor(abs, 'file');
      if (!found.has(scope)) found.set(scope, abs);
    }
    return [...found].map(([scope, abs]) => ({ abs, scope }));
  }

  private policyOptions(): CommandPolicyOptions {
    return researchPolicyOptions(this.researchShell);
  }

  /**
   * Three tiers (see `commandPolicy.ts`): read-only inspection runs silently,
   * anything else asks once and is remembered, and writes are refused outright
   * because a planner that mutates the workspace has stopped being a planner.
   *
   * Everything a command needs — its own approval and every outside directory
   * it touches — is one request, so one command is one prompt. Each scope is
   * still granted separately: approving the pair does not approve another
   * directory the next command names.
   */
  async bash(command: string, signal?: AbortSignal): Promise<ToolOutcome> {
    const allow = this.approval.allowlist?.();
    const { tier, scope, reason, allowedBy } = classifyCommand(command, { ...this.policyOptions(), ...(allow ? { allow } : {}) });

    if (tier === 'refuse') {
      return { success: false, output: `Command refused: ${reason}`, truncated: false };
    }

    const outside = this.outsidePaths(command);
    const asks = tier === 'ask';
    if (asks || outside.length > 0) {
      const root = this.getWorkspaceRoot();
      const scopes = [...(asks ? [scope] : []), ...outside.map((o) => o.scope)];
      const touched = outside.map((o) => o.abs).join(', ');
      const granted = await this.approval.request({
        kind: asks ? 'shell_command' : 'external_path',
        subject: asks ? command : outside[0].abs,
        scope: scopes[0],
        ...(scopes.length > 1 ? { scopes } : {}),
        ...(asks && allowedBy ? { allowedBy } : {}),
        detail: outside.length > 0
          ? `Planner research wants to run "${command}", which touches ${touched}, outside the workspace (${root}).`
          : `Planner research wants to run: ${command}`,
      });
      if (!granted) {
        return {
          success: false,
          output: outside.length > 0
            ? `Access denied: "${command}" touches ${touched}, outside the workspace root (${root}), and was not approved. Keep research inside the workspace, or ask the user to approve this location.`
            : `Command not approved: ${command}\nIt is outside the auto-allowed read-only set and the planner allowlist (${scope}). Continue without it. If it would change something outside the repository, add it to the plan as an ops task; if it only reads, ask the user to approve it or add it to the planner allowlist.`,
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
