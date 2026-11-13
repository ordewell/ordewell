import {
  IFileSystem,
  BashOptions,
  ReadFileOpts,
  GrepOptions,
  GlobOptions,
  FindSymbolOptions,
  ToolOutcome,
  GREP_DEFAULT_HEAD_LIMIT,
  type TaskShell,
  type TaskShellSite,
} from '../interfaces/IFileSystem';
import { IApproval, DENY_ALL } from '../interfaces/IApproval';
import { decide, type GateSite, type GateWho } from './commandGate';
import { ParsedLine } from './parsedLine';
import { resolveResearchShell, researchShellWarning, researchLineShell, type ResearchShell, type ShellLaunch } from './researchShell';
import { PlannerShellSandbox, SEALED_FAILURE_NOTE, TASK_SEALED_FAILURE_NOTE, TASK_SEALED_LIMITS, sandboxedFailureNote, sealedMemoryLimitNote, sealedRunHeader, sealedTimeLimitNote, type SealedRunOptions, type SealedRunReason } from './sandbox/plannerSandbox';
import { resolveWithin, grantScopeFor } from './pathScope';
import { definitionPattern, referencePattern, languageForId, includeGlobFor } from './symbolPatterns';
import { resolveAll, vetEgress, type ResolveAll } from './egressGuard';
import { sensitiveEnvValues } from './outboundSecrets';
import { changedGitEntries, removeOutwardLinks, removePlantedGit, snapshotGitEntries, type GitBefore } from './outwardLinks';

export { AUTO_COMMANDS, GIT_READONLY_SUBCOMMANDS, REFUSED_COMMANDS, classifyCommand, pathLikeArgs } from './commandPolicy';

function refusal(output: string): ToolOutcome {
  return { success: false, output, truncated: false, refused: true };
}

/**
 * Where one command runs and who answers for it: the planner's workspace, or
 * a read-only task's working directory, where nobody is asked (ADR-0046).
 */
interface ShellSite {
  /** Which of the session's answers count, and whether anyone is asked (`commandGate`). */
  who: GateWho;
  /** Paths are confined to it, and commands start in it. */
  root: string;
  /** The session's approvals as they stand at each command, which the gate reads as {@link who} may. */
  approval(): IApproval;
  sandbox: PlannerShellSandbox;
  /** What a sealed run reads, and the one directory beyond scratch it may write. */
  sealed: SealedRunOptions;
  /**
   * A read-only task's: what its results say is said to its runner, not the
   * planner. `sealed` once a sealed run has started in the attempt's shell.
   */
  task?: {
    worktree: boolean;
    sealed: boolean;
    /** The `.git` entries the writable directory held before the first sealed run (ADR-0046). */
    gitBefore?: GitBefore;
    /** Why every later command is refused: a repository a sealed run planted could not be removed (ADR-0046). */
    stopped?: string;
  };
}

/** Why Ordewell's own script did not run in a read-only task's worktree (ADR-0050). */
const OWN_UNSEALED = "this machine has no sandbox to seal it in, and Ordewell runs nothing in a read-only task's worktree outside one.";
const OUTWARD_LINKS_REMOVED = 'Removed, since a read-only task may leave no link leading out of its worktree and the workspace:';
const PLANTED_GIT_REMOVED = 'Removed, since a read-only task may leave no .git for git outside the sandbox to load:';
const PLANTED_GIT_STUCK = "Could not remove a .git this command planted, so this task's shell is stopped, and every later command is refused:";
const GIT_CHANGED = "A .git entry this task's checkout brought changed during a sealed run, though the sandbox forbids it, so this task's shell is stopped, and every later command is refused:";

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
  private outboundSecrets: () => Iterable<string> = () => [];

  constructor(
    private readonly resolveWebHost: ResolveAll = resolveAll,
    private readonly sandbox: PlannerShellSandbox = new PlannerShellSandbox(),
  ) {}

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

  setOutboundSecrets(secrets: () => Iterable<string>): void {
    this.outboundSecrets = secrets;
  }

  setNotice(notice: (message: string) => void): void {
    this.sandbox.setNotice(notice);
  }

  endSession(): void {
    this.sandbox.end();
  }

  canSeal(): Promise<boolean> {
    return this.sandbox.canSeal();
  }

  abstract getWorkspaceRoot(): string;

  protected abstract readFileImpl(absPath: string, opts?: ReadFileOpts): Promise<ToolOutcome>;
  protected abstract globImpl(pattern: string, absRoot: string, headLimit: number): Promise<ToolOutcome>;
  protected abstract grepImpl(pattern: string, absRoot: string, opts: GrepOptions): Promise<ToolOutcome>;
  protected abstract listDirImpl(absPath: string, depth: number): Promise<ToolOutcome>;
  /**
   * Run `command` through `shell` from `cwd`, appending it after
   * `shell.args`; `shell.file: null` is `shell: true`. `cwd` is the workspace
   * root, or a read-only task's working directory (ADR-0046).
   */
  protected abstract execBashImpl(command: string, shell: ShellLaunch, signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome>;

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
        refused: true,
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
    let allRefused = paths.length > 0;
    for (const p of paths) {
      const r = await this.readFile(p);
      if (!r.refused) allRefused = false;
      // Denials are reported inline: silently dropping them would let the model
      // believe a file was empty rather than out of bounds.
      if (r.success) {
        results.push(`--- ${p} ---\n${r.output}`);
        if (r.truncated) truncated = true;
      } else if (r.output) {
        results.push(`--- ${p} ---\n[not read] ${r.output}`);
      }
    }
    // Checked first: each denial pushed a line above, so `results` is only empty for no paths.
    // The inline denials stay the output, and `refused` lets the read limit refund the call (ADR-0068 R1).
    if (allRefused) return { success: false, output: results.join('\n\n'), truncated: false, refused: true };
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

  /** A command line read under the research shell: every check of one command reads this one value. */
  private parse(command: string): ParsedLine {
    return ParsedLine.parse(command, researchLineShell(this.researchShell));
  }

  private plannerSite(): ShellSite {
    const root = this.getWorkspaceRoot();
    const { approval } = this;
    return { who: 'planner', root, approval: () => approval, sandbox: this.sandbox, sealed: { workspace: root } };
  }

  /**
   * Three tiers (see `commandPolicy.ts`): read-only inspection runs silently,
   * anything else asks once and is remembered, and writes are refused outright
   * because a planner that mutates the workspace has stopped being a planner.
   * Where the sandbox can seal a command, what the envelope would refuse
   * without asking anyone runs sealed instead (ADR-0036 S2): the classifier's
   * refusal, and the approval mode's. A person's denial still refuses.
   *
   * Everything a command needs — its own approval and every outside directory
   * it touches — is one request, so one command is one prompt. Each scope is
   * still granted separately: approving the pair does not approve another
   * directory the next command names.
   */
  async bash(command: string, signal?: AbortSignal, opts: BashOptions = {}): Promise<ToolOutcome> {
    return this.runIn(this.plannerSite(), command, signal, opts);
  }

  /**
   * A read-only task's `run_command` (ADR-0046): the planner's classifier,
   * path confinement, allowlist and exclusions, at the task's working
   * directory, asking nobody. What would ask or be refused runs sealed, the
   * workspace readable and the task's worktree writable, or is refused where
   * no sandbox can seal it. What the allowlist or the read-only tier runs
   * runs as the planner's command would, until the shell's first sealed run;
   * from then on every command runs sealed. Its scratch directory is its own.
   */
  taskShell({ cwd, writable, worktrees }: TaskShellSite): TaskShell {
    const sandbox = this.sandbox.withOwnScratch();
    const task: NonNullable<ShellSite['task']> = { worktree: writable !== undefined, sealed: false };
    const site: ShellSite = {
      who: 'task',
      root: cwd,
      approval: () => this.approval,
      sandbox,
      sealed: { workspace: this.getWorkspaceRoot(), ...(writable ? { writable } : {}), ...(worktrees?.length ? { worktrees } : {}), limits: TASK_SEALED_LIMITS },
      task,
    };
    // One command at a time: an unsealed one must never read the worktree
    // while a sealed one is still writing it, before its links are checked.
    let last: Promise<unknown> = Promise.resolve();
    const queued = <T>(next: () => Promise<T>): Promise<T> => {
      const settled = last.then(next);
      last = settled.catch(() => undefined);
      return settled;
    };
    const roots = worktrees?.length ? [...worktrees] : writable ? [writable] : [];
    return {
      run: (command, signal) => queued(() => this.runIn(site, command, signal)),
      hold: (work, signal) => queued(() => work({
        worktrees: roots,
        touched: task.sealed,
        get scratch() { return sandbox.scratchPath(); },
        run: (script, at) => this.runOwn(site, roots, script, at, signal),
      })),
      end: () => sandbox.end(),
    };
  }

  /**
   * Ordewell's own script in a read-only task's shell (ADR-0050), sealed from
   * one of its worktree roots. No command rule judges it, since the task did
   * not write it; it runs under the task's sealed profile and is checked
   * after as the task's own sealed runs are, so git that reads a worktree a
   * sealed run wrote runs only inside the seal (ADR-0046).
   */
  private async runOwn(site: ShellSite, roots: readonly string[], script: string, cwd: string, signal?: AbortSignal): Promise<ToolOutcome> {
    if (site.task?.stopped) return refusal(`Not run: ${site.task.stopped}.`);
    if (!roots.includes(cwd)) return refusal(`Not run: ${cwd} is not a worktree of this task.`);
    if (!(await site.sandbox.canSeal())) return refusal(`Not run: ${OWN_UNSEALED}`);
    const sealed = await this.sealedRun(site, script, cwd, signal);
    if ('refused' in sealed) return sealed.refused;
    if (site.task?.stopped) return { ...sealed.outcome, success: false, output: `${sealed.outcome.output}${sealed.swept}` };
    return sealed.outcome;
  }

  /** Carries out what the command gate decided for `command` at `site`: the gate decides, this only runs it. */
  private async runIn(site: ShellSite, command: string, signal?: AbortSignal, opts: BashOptions = {}): Promise<ToolOutcome> {
    let verdict = await decide(this.parse(command), this.gateSite(site, signal, opts));
    if (verdict.kind === 'ask') {
      const approval = site.approval();
      verdict = await verdict.answer(await (signal ? approval.request(verdict.request, { signal }) : approval.request(verdict.request)));
    }
    switch (verdict.kind) {
      case 'refuse': return refusal(verdict.reason);
      case 'sealed': return this.runSealed(site, verdict.command, verdict.why, signal);
      case 'native': return this.runShell(site, verdict.command, verdict.network, signal);
    }
  }

  /** What the gate reads at `site` that only this filesystem knows. */
  private gateSite(site: ShellSite, signal: AbortSignal | undefined, opts: BashOptions): GateSite {
    return {
      who: site.who,
      root: site.root,
      ...(this.researchShell.hostPath ? { hostPath: this.researchShell.hostPath } : {}),
      approval: site.approval(),
      canSeal: () => site.sandbox.canSeal(),
      ...(opts.sealed ? { sealed: true } : {}),
      ...(site.task?.sealed ? { after: true } : {}),
      ...(site.task?.stopped ? { stopped: site.task.stopped } : {}),
      outboundSecrets: () => [...this.outboundSecrets(), ...sensitiveEnvValues(process.env)],
      vetEgress: (host, port) => vetEgress(host, port, this.resolveWebHost),
      probe: (probe) => this.runShell(site, probe, false, signal),
    };
  }

  /** One sealed run (ADR-0036 S1): no network, no home, nothing it writes reaching the workspace, and nobody asked. */
  private async runSealed(site: ShellSite, command: string, why: SealedRunReason, signal?: AbortSignal): Promise<ToolOutcome> {
    const sealed = await this.sealedRun(site, command, site.root, signal);
    if ('refused' in sealed) return sealed.refused;
    const { outcome, shell, first, swept } = sealed;
    if (signal?.aborted) return { ...outcome, output: `${outcome.output}${swept}` };
    const failed = outcome.timedOut && shell.wallTimeMs !== undefined
      ? sealedTimeLimitNote(shell.wallTimeMs, site.task !== undefined)
      : sealedMemoryLimitNote(outcome, shell.memoryBytes, site.task !== undefined) ?? (site.task ? TASK_SEALED_FAILURE_NOTE : SEALED_FAILURE_NOTE);
    const output = `${sealedRunHeader(why, site.task && { worktree: site.task.worktree, first })}\n${outcome.output}${outcome.success ? '' : `\n\n[${failed}]`}${swept}`;
    return { ...outcome, output };
  }

  /**
   * One sealed run from `cwd`, and what follows every one in a read-only
   * task's shell (ADR-0046): the `.git` record checked, a planted `.git` and
   * every link out of the worktree removed, and the shell stopped where that
   * could not hold. `swept` says what was removed, for the result.
   */
  private async sealedRun(site: ShellSite, command: string, cwd: string, signal?: AbortSignal): Promise<{ outcome: ToolOutcome; shell: ShellLaunch; first: boolean; swept: string } | { refused: ToolOutcome }> {
    // What the writable directory held before the first sealed run, so the
    // sweep can tell a repository the checkout brought from one a run planted
    // (ADR-0046). Taken lazily, here, before the first run can write.
    const { writable, workspace, worktrees } = site.sealed;
    if (site.task && writable && !site.task.gitBefore) {
      site.task.gitBefore = { ...(await snapshotGitEntries(writable)), worktrees: worktrees ?? [writable] };
    }

    let shell: ShellLaunch;
    try {
      // The entries and the worktree roots are held still by the profile; the
      // check after the run catches a backend that failed to (ADR-0046).
      const sealed = site.task?.gitBefore
        ? { ...site.sealed, gitEntries: site.task.gitBefore.entries.map(({ path, directory }) => ({ path, directory })) }
        : site.sealed;
      shell = await site.sandbox.launchSealed(this.researchShell, sealed);
    } catch (err) {
      return { refused: refusal(`Command not run: its sealed sandbox could not be prepared (${err instanceof Error ? err.message : String(err)}).`) };
    }
    // As the run starts, not once it succeeds: one that fails, times out or is
    // aborted may still have written.
    const first = site.task !== undefined && !site.task.sealed;
    if (site.task) site.task.sealed = true;
    const outcome = await this.execBashImpl(command, shell, signal, cwd);
    let removedLinks: string[] = [];
    let removedGit: string[] = [];
    let stuckGit: string[] = [];
    let changedGit: string[] = [];
    if (site.task && writable) {
      const before = site.task.gitBefore;
      // The identity check first, before the sweep can change anything itself.
      changedGit = before ? await changedGitEntries(before.entries, writable) : [];
      // The workspace root goes first, where a group's runner starts its own
      // git; the walk below then covers every subdirectory.
      const planted = await removePlantedGit(writable, worktrees ?? [writable], before?.keep);
      const sweep = await removeOutwardLinks(writable, [writable, workspace], before ?? { keep: new Set(), entries: [], worktrees: worktrees ?? [writable] });
      removedLinks = sweep.removedLinks;
      removedGit = [...(planted ? ['.git'] : []), ...sweep.removedGit];
      stuckGit = sweep.stuckGit;
      // A `.git` still where git would find it is what the sweep's removal
      // could not take; one of the checkout's entries that changed is a sandbox
      // that did not hold. Either stops the shell rather than run beside a
      // repository the run planted or armed (ADR-0046).
      if (stuckGit.length > 0) {
        site.task.stopped = `a repository a sealed run planted could not be removed (${stuckGit.join(', ')}), so this task's shell is stopped`;
      } else if (changedGit.length > 0) {
        site.task.stopped = `a .git entry the checkout brought changed during a sealed run (${changedGit.join(', ')}), so this task's shell is stopped`;
      }
    }
    const swept = `${removedLinks.length > 0 ? `\n\n[${OUTWARD_LINKS_REMOVED} ${removedLinks.join(', ')}]` : ''}`
      + `${removedGit.length > 0 ? `\n\n[${PLANTED_GIT_REMOVED} ${removedGit.join(', ')}]` : ''}`
      + `${stuckGit.length > 0 ? `\n\n[${PLANTED_GIT_STUCK} ${stuckGit.join(', ')}]` : ''}`
      + `${changedGit.length > 0 ? `\n\n[${GIT_CHANGED} ${changedGit.join(', ')}]` : ''}`;
    return { outcome, shell, first, swept };
  }

  /** Every command the planner's shell starts goes through here, inside the sandbox where this host has one (ADR-0011 B1, B6). */
  private async runShell(site: ShellSite, command: string, network: boolean, signal?: AbortSignal): Promise<ToolOutcome> {
    let shell: ShellLaunch;
    let sandboxed: boolean;
    try {
      ({ launch: shell, sandboxed } = await site.sandbox.launch(this.researchShell, { network }));
    } catch (err) {
      // The sandbox runs on this host, so running the command outside it is not a fallback.
      return { success: false, output: `Command not run: the planner's sandbox could not be prepared (${err instanceof Error ? err.message : String(err)}).`, truncated: false };
    }
    const outcome = await this.execBashImpl(command, shell, signal, site.root);
    if (outcome.success) return outcome;

    // A command that failed under cmd.exe most likely failed because the tool
    // does not exist there, and one that failed in the sandbox on a denied
    // write or a missing network because of the sandbox. Saying so turns
    // "exited 1" into something the model can act on — and, per the
    // fail-visibly contract, keeps a limit of the shell from reading as a
    // repository that simply had no answer.
    const warning = sandboxed ? sandboxedFailureNote(outcome.output, network, site.task !== undefined) : researchShellWarning(this.researchShell);
    return warning ? { ...outcome, output: `${outcome.output}\n\n[${warning}]` } : outcome;
  }
}
