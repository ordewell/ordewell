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
import { IApproval, DENY_ALL, type ApprovalRequest, type StandingDecision } from '../interfaces/IApproval';
import { cdUnfollowed, classifyCommand, excludedBy, innerCommandScopes, pathRefs, type CommandPolicyOptions } from './commandPolicy';
import { resolveResearchShell, researchShellWarning, researchPolicyOptions, type ResearchShell, type ShellLaunch } from './researchShell';
import { PlannerShellSandbox, SEALED_FAILURE_NOTE, TASK_SEALED_FAILURE_NOTE, TASK_SEALED_LIMITS, sandboxedFailureNote, sealedMemoryLimitNote, sealedRunHeader, sealedTimeLimitNote, type SealedRunOptions, type SealedRunReason } from './sandbox/plannerSandbox';
import { parseAllowlist } from './plannerAllowlist';
import { resolveWithin, resolveRef, grantScopeFor, isInertDevice } from './pathScope';
import { definitionPattern, referencePattern, languageForId, includeGlobFor } from './symbolPatterns';
import { resolveAll, vetEgress, type ResolveAll } from './egressGuard';
import { carriesSecret, sensitiveEnvValues } from './outboundSecrets';
import { READ_REFUSAL_HINT, disableWebCommandStartup, pinWebCommandAddresses, wgetVersionCommands } from './webCommands';
import { NOT_APPROVED_HINT } from './effectRoute';
import { changedGitEntries, removeOutwardLinks, removePlantedGit, snapshotGitEntries, type GitBefore } from './outwardLinks';

export { AUTO_COMMANDS, GIT_READONLY_SUBCOMMANDS, REFUSED_COMMANDS, classifyCommand, pathLikeArgs } from './commandPolicy';

const SED_HINT = ` To read lines of a file, "head", "tail" and "sed -n '10,40p' FILE" run without approval.`;
const CD_HINT = ' A "cd" is followed only on a line joined by "&&" alone, so after ";", "||", "&" or a newline every path is judged from the workspace root. Join the commands with "&&", or give paths from the root.';

function refusal(output: string): ToolOutcome {
  return { success: false, output, truncated: false };
}

/**
 * Where one command runs and who answers for it: the planner's workspace, or
 * a read-only task's working directory, where nobody is asked (ADR-0046).
 */
interface ShellSite {
  /** Paths are confined to it, and commands start in it. */
  root: string;
  approval: IApproval;
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

/** Why a read-only task's command did not run where the planner's would have asked or run sealed (ADR-0046). */
const TASK_UNSEALED = 'A read-only task asks nobody, so this command could only run sealed, and this machine has no sandbox to seal it in.';
/** Why Ordewell's own script did not run in a read-only task's worktree (ADR-0050). */
const OWN_UNSEALED = "this machine has no sandbox to seal it in, and Ordewell runs nothing in a read-only task's worktree outside one.";
const TASK_CONTINUE = 'Continue without it, and say in your report if what it would have shown matters.';
const OUTWARD_LINKS_REMOVED = 'Removed, since a read-only task may leave no link leading out of its worktree and the workspace:';
const PLANTED_GIT_REMOVED = 'Removed, since a read-only task may leave no .git for git outside the sandbox to load:';
const PLANTED_GIT_STUCK = "Could not remove a .git this command planted, so this task's shell is stopped, and every later command is refused:";
const GIT_CHANGED = "A .git entry this task's checkout brought changed during a sealed run, though the sandbox forbids it, so this task's shell is stopped, and every later command is refused:";

/** Why a read-only task's command was not run, from the decision that stood. */
function taskRefusal(standing: StandingDecision | undefined): string {
  if (standing?.decision === 'deny' && standing.source === 'excluded') return 'The allowlist excludes it.';
  if (standing?.decision === 'deny' && standing.source === 'remembered') return 'The user denied it this session.';
  return TASK_UNSEALED;
}

/**
 * The session's approvals as a read-only task's shell sees them (ADR-0046):
 * nobody is asked. The allowlist's standing approvals stand, and so do an
 * `!` exclusion and a denial the user gave on the card (ADR-0036 S3).
 * Anything else is the approval mode refusing without asking, which a
 * sandbox turns into a sealed run. A grant the user gave on the card was
 * given to the planner's command, and stays the planner's.
 */
function allowlistOnly(session: () => IApproval): IApproval {
  const peek = (req: ApprovalRequest): StandingDecision => {
    const standing = session().peek?.(req);
    if (standing?.decision === 'deny' && standing.source !== 'mode') return standing;
    if (standing?.decision === 'allow' && standing.source === 'pre-approved') return standing;
    return { decision: 'deny', source: 'mode' };
  };
  return {
    request: async (req) => peek(req).decision === 'allow',
    allowlist: () => session().allowlist?.() ?? parseAllowlist([]),
    commandPolicy: () => ({ ...session().commandPolicy?.(), approvalMode: 'deny' }),
    peek,
  };
}

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
  private outsidePaths(command: string, root: string): Array<{ abs: string; scope: string }> {
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

  private plannerSite(): ShellSite {
    const root = this.getWorkspaceRoot();
    return { root, approval: this.approval, sandbox: this.sandbox, sealed: { workspace: root } };
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
      root: cwd,
      approval: allowlistOnly(() => this.approval),
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

  private async runIn(site: ShellSite, command: string, signal?: AbortSignal, opts: BashOptions = {}): Promise<ToolOutcome> {
    if (site.task?.stopped) return refusal(`Command not run: ${site.task.stopped}.\n${TASK_CONTINUE}`);
    command = disableWebCommandStartup(command, this.researchShell.dialect);
    const { approval, root } = site;
    const allow = approval.allowlist?.();
    const { tier, scope, reason, allowedBy, perInvocation, scopes: commandScopes, webUrls, outboundTexts } = classifyCommand(command, {
      ...this.policyOptions(), ...approval.commandPolicy?.(), ...(allow ? { allow } : {}),
    });

    const outside = this.outsidePaths(command, root);
    const asks = tier === 'ask';
    const scopes = [...(asks ? commandScopes ?? [scope] : []), ...outside.map((o) => o.scope)];
    const touched = outside.map((o) => o.abs).join(', ');
    const request: ApprovalRequest | undefined = scopes.length === 0 ? undefined : {
      kind: asks ? 'shell_command' : 'external_path',
      ...(perInvocation ? { perInvocation } : {}),
      subject: asks ? command : outside[0].abs,
      scope: scopes[0],
      ...(scopes.length > 1 ? { scopes } : {}),
      ...(asks && allowedBy ? { allowedBy } : {}),
      detail: outside.length > 0
        ? `Planner research wants to run "${command}", which touches ${touched}, outside the workspace (${root}).`
        : `Planner research wants to run: ${command}`,
    };

    if (opts.sealed) {
      if (!(await site.sandbox.canSeal())) return refusal(`Command refused: this machine has no sandbox to run a command sealed in. Run it without "sealed", and Ordewell's command rules judge it as they do every command.`);
      return this.runSealed(site, command, request, 'asked', signal);
    }

    // A sealed run may have written what a later command reads: a script the
    // allowlisted `npm test` runs, a tool's config, a cache in scratch. Run
    // outside the sealed profile, that command would read the whole host, and
    // an allowlisted one would have the network, so once a sealed run has
    // started every later command of the attempt runs sealed (ADR-0046).
    if (site.task?.sealed) return this.runSealed(site, command, request, 'after', signal);

    if (tier === 'refuse') return this.sealedInstead(site, command, request, refusal(`Command refused: ${reason}${site.task ? `\n${TASK_UNSEALED} ${TASK_CONTINUE}` : ''}`), signal);

    const outbound = [...(outboundTexts ?? []), ...(webUrls ?? []).map((url) => url.href)];
    if (outbound.length && carriesSecret(outbound, [...this.outboundSecrets(), ...sensitiveEnvValues(process.env)])) {
      return refusal(webUrls?.length
        ? 'Command refused: a web command contains what looks like a secret. Fetch the page with your web fetch tool, without credentials.'
        : 'Command refused: what this command sends over the network contains what looks like a secret. Run it without the value.');
    }

    const vettedAddresses = new Map<string, string>();
    for (const url of webUrls ?? []) {
      const check = await vetEgress(url.hostname, url.port, this.resolveWebHost);
      if (!check.ok) return refusal(`Command refused: Blocked host: ${check.reason}. ${READ_REFUSAL_HINT}`);
      vettedAddresses.set(url.origin, check.addresses[0]);
    }

    if (request) {
      // The approval mode refuses without asking anyone, so where a sealed run
      // can start that is what runs (S2). Elsewhere the request goes in, and
      // the mode's refusal is recorded as it always was. A read-only task's
      // mode refuses whatever would ask (ADR-0046).
      const standing = approval.peek?.(request);
      if (standing?.decision === 'deny' && standing.source === 'mode' && await site.sandbox.canSeal()) return this.runSealed(site, command, request, 'refused', signal);
      if (!(await approval.request(request))) {
        if (site.task) return refusal(`Command not run: ${command}\n${taskRefusal(standing)} ${TASK_CONTINUE}`);
        return refusal(outside.length > 0
          ? `Access denied: "${command}" touches ${touched}, outside the workspace root (${root}), and was not approved. Keep research inside the workspace, or ask the user to approve this location.${cdUnfollowed(command, this.policyOptions()) ? CD_HINT : ''}`
          : `Command not approved: ${command}\nIt is outside the auto-allowed read-only set and the planner allowlist (${scope}). ${NOT_APPROVED_HINT}${/(^| )g?sed( |$)/.test(scope) ? SED_HINT : ''}`);
      }
    }

    if (webUrls?.length) {
      const latest = classifyCommand(command, { ...this.policyOptions(), ...approval.commandPolicy?.(), allow: approval.allowlist?.() });
      if (latest.tier === 'refuse') return refusal(`Command refused: ${latest.reason}`);
    }

    for (const probe of wgetVersionCommands(command, this.researchShell.dialect)) {
      if (!probe) return refusal(`Command refused: the wget executable cannot be checked in an uncertain working directory. ${READ_REFUSAL_HINT}`);
      const version = await this.runShell(site, probe, false, signal);
      if (!version.success || !/^GNU Wget 1\./.test(version.output)) {
        return refusal(`Command refused: only GNU Wget 1.x is supported; wget2 can write persistent databases. ${READ_REFUSAL_HINT}`);
      }
    }

    const pinned = pinWebCommandAddresses(command, vettedAddresses, this.researchShell.dialect);
    command = pinned.command;
    if (webUrls?.length) {
      const latest = classifyCommand(command, { ...this.policyOptions(), ...approval.commandPolicy?.(), allow: approval.allowlist?.(), trustedWebResolves: pinned.resolves });
      if (latest.tier === 'refuse') return refusal(`Command refused: ${latest.reason}`);
    }
    // The network follows the tier (ADR-0011 B3): an `ask` command got here
    // approved, by the user, a standing grant, the allowlist or the mode, and
    // keeps it. An `auto` one, including one approved only for the paths it
    // names, has none.
    return this.runShell(site, command, tier === 'ask', signal);
  }

  /**
   * A scope inside `command` the user denied on the card this session, or
   * undefined (ADR-0036 S3). The whole command's request is peeked by the
   * caller; this reaches the commands a refused wrapper hides, each remembered
   * under its own scope, so wrapping a denied command never routes around the
   * denial.
   */
  private deniedInnerScope(approval: IApproval, command: string): string | undefined {
    const peek = approval.peek;
    if (!peek) return undefined;
    for (const scope of innerCommandScopes(command, this.policyOptions())) {
      const standing = peek.call(approval, { kind: 'shell_command', subject: command, scope });
      if (standing.decision === 'deny' && standing.source === 'remembered') return scope;
    }
    return undefined;
  }

  /** A refusal the envelope reached without asking anyone, run sealed where this host can (ADR-0036 S2), or `refused` as it was (S6). */
  private async sealedInstead(site: ShellSite, command: string, request: ApprovalRequest | undefined, refused: ToolOutcome, signal?: AbortSignal): Promise<ToolOutcome> {
    return (await site.sandbox.canSeal()) ? this.runSealed(site, command, request, 'refused', signal) : refused;
  }

  /**
   * One sealed run (S1): no network, no home, nothing it writes reaching the
   * workspace, and nobody asked. What the user said no to stays refused (S3):
   * a `!` exclusion naming the command or a path it touches, and a denial
   * given on the card this session.
   */
  private async runSealed(site: ShellSite, command: string, request: ApprovalRequest | undefined, why: SealedRunReason, signal?: AbortSignal): Promise<ToolOutcome> {
    const { approval } = site;
    const allow = approval.allowlist?.();
    const rule = allow ? excludedBy(command, allow, this.policyOptions()) : undefined;
    if (rule) return refusal(`Command refused: the planner allowlist excludes it ("${rule}"), and an exclusion holds for a sealed run too.`);
    const standing = request ? approval.peek?.(request) : undefined;
    if (request && standing?.decision === 'deny' && standing.source === 'excluded') {
      return refusal(`Command refused: the planner allowlist excludes ${request.subject === command ? 'it' : `"${request.subject}"`}, and an exclusion holds for a sealed run too.`);
    }
    if (standing?.decision === 'deny' && standing.source === 'remembered') {
      return refusal(`Command not approved: ${command}\nThe user denied it this session, and a denial holds for a sealed run too. Continue without it.`);
    }
    // A denial is keyed on each command's own scope, so a refused wrapper — a
    // loop, a pipe — whose own request peek() never matched still refuses when
    // it carries a command the user said no to (S3). Only the person's denial
    // ('remembered'); a scope the approval mode alone would refuse is what a
    // sealed run is for (S2).
    const denied = this.deniedInnerScope(approval, command);
    if (denied) return refusal(`Command not approved: ${command}\nThe user denied "${denied}" this session, and a denial holds for a sealed run too. Continue without it.`);

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
