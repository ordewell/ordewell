import type { ApprovalRequest, IApproval, StandingDecision } from '../interfaces/IApproval';
import type { ToolOutcome } from '../interfaces/IFileSystem';
import { cdUnfollowed, classifyCommand, excludedBy, innerCommandScopes, pathRefs, type PolicyInputs } from './commandPolicy';
import type { EgressCheck } from './egressGuard';
import { NOT_APPROVED_HINT } from './effectRoute';
import { carriesSecret } from './outboundSecrets';
import type { ParsedLine } from './parsedLine';
import { grantScopeFor, resolveRef, type HostPath } from './pathScope';
import { parseAllowlist, type PlannerAllowlist } from './plannerAllowlist';
import type { SealedRunReason } from './sandbox/plannerSandbox';
import { READ_REFUSAL_HINT, disableWebCommandStartup, pinWebCommandAddresses, wgetVersionCommands } from './webCommands';

/**
 * May this command run, and how: the one place the shell's boundary is decided
 * (ADR-0008, ADR-0036, ADR-0046). Every rule a command line meets — the
 * classifier's tier, path confinement, the allowlist and its exclusions, the
 * card's denials, the outbound secret check, the egress check, the wget probe
 * and the network a run keeps — is read here, and the caller only carries the
 * verdict out. What it cannot know itself (the session's standing approvals,
 * whether this host can seal, DNS, the probe's output) comes in on the
 * {@link GateSite}, so a table of cases can drive it with no filesystem.
 */

/**
 * Who stands behind a command, which settles who may be asked and which
 * standing answers count:
 * - `planner`: asks the person, and every standing answer counts.
 * - `task`: a read-only task's `run_command` (ADR-0046). Asks nobody; the
 *   allowlist's standing approvals and the person's refusals stand, and the
 *   approval mode refuses the rest. A grant given on the card was given to the
 *   planner's command, and stays the planner's.
 * - `subagent`: a research subagent (ADR-0008 T6). Asks nobody and keeps no
 *   grant: only what the read-only tier runs runs unsealed, with no network
 *   (ADR-0011 B3); what would ask runs sealed (ADR-0036 S5) or is refused, and
 *   the person's refusals still stand (S3).
 */
export type GateWho = 'planner' | 'task' | 'subagent';

/** Where one command is decided: who answers for it, where it runs, and the checks the gate cannot make on its own. */
export interface GateSite {
  who: GateWho;
  /** Paths are confined to it, and the command starts in it. */
  root: string;
  /** How the shell reads a path it is given (`ResearchShell.hostPath`). */
  hostPath?: HostPath;
  /** The session's approvals; {@link who} decides which of their answers count, and whether `request` is ever reached. */
  approval: IApproval;
  canSeal(): Promise<boolean>;
  /** The caller asked for a sealed run (`run_command` with `sealed: true`, ADR-0036 S2). */
  sealed?: boolean;
  /** A sealed run has started in this read-only task's shell, so every later command runs sealed (ADR-0046). */
  after?: boolean;
  /** Why every command of this read-only task's shell is refused (ADR-0046). */
  stopped?: string;
  /** Values a command must not send over the network (ADR-0027): the session's held secrets and the environment's sensitive ones. */
  outboundSecrets(): Iterable<string>;
  /** The DNS check for a web command's origin (egressGuard's `vetEgress`). */
  vetEgress(host: string, port: string): Promise<EgressCheck>;
  /** Runs a `wget --version` probe where the command would run, without the network. */
  probe(command: string): Promise<ToolOutcome>;
}

/**
 * What to do with a command. `reason` is the whole text the caller reports.
 * `command` is what runs: the line with web startup files disabled and, for a
 * native run, its curl addresses pinned to the vetted answers. `ask` goes to
 * the person, and `answer` decides what follows from what they said.
 */
export type GateVerdict = Settled | { kind: 'ask'; request: ApprovalRequest; answer(granted: boolean): Promise<Settled> };

/** A verdict nobody need be asked about: what the command meets is settled. */
export type Settled =
  | { kind: 'refuse'; reason: string }
  | { kind: 'sealed'; why: SealedRunReason; command: string }
  | { kind: 'native'; network: boolean; command: string };

const SED_HINT = ` To read lines of a file, "head", "tail" and "sed -n '10,40p' FILE" run without approval.`;
const CD_HINT = ' A "cd" is followed only on a line joined by "&&" alone, so after ";", "||", "&" or a newline every path is judged from the workspace root. Join the commands with "&&", or give paths from the root.';
/** Why a read-only task's command did not run where the planner's would have asked or run sealed (ADR-0046). */
const TASK_UNSEALED = 'A read-only task asks nobody, so this command could only run sealed, and this machine has no sandbox to seal it in.';
const TASK_CONTINUE = 'Continue without it, and say in your report if what it would have shown matters.';
const NO_SANDBOX = `Command refused: this machine has no sandbox to run a command sealed in. Run it without "sealed", and Ordewell's command rules judge it as they do every command.`;

/** Why a command naming a path the research shell reads by rules confinement cannot follow is refused (ADR-0010). */
function unfollowableReason(spelled: string): string {
  return `Git Bash reads "${spelled}" by rules this check cannot follow, so it cannot tell which folder the command would reach: a ".." past one of its mounts, or its own /proc or /dev. `
    + 'Name the path from its drive (/c/Users/...) or as a Windows path (C:\\Users\\...), with no "..".';
}

/** Why a read-only task's command was not run, from the decision that stood. */
function taskRefusal(standing: StandingDecision | undefined): string {
  if (standing?.decision === 'deny' && standing.source === 'excluded') return 'The allowlist excludes it.';
  if (standing?.decision === 'deny' && standing.source === 'remembered') return 'The user denied it this session.';
  return TASK_UNSEALED;
}

function subagentOutside(abs: string): string {
  return `Path "${abs}" is outside the workspace. Research agents are confined to the workspace root — note the gap in your digest and let the planner request it directly.`;
}

function subagentUnapproved(command: string): string {
  return `"${command}" needs user approval, and research agents run in the background where nothing can be approved. Use the read-only research tools, and note in your digest that this command would answer the question.`;
}

const refuse = (reason: string): Settled => ({ kind: 'refuse', reason });
const BY_MODE: StandingDecision = { decision: 'deny', source: 'mode' };

/** The session's approvals as one site sees them. */
interface SitePolicy {
  /** Whether a request may reach a person; a site that may not reads its standing answer instead. */
  asks: boolean;
  /** Whether an approved command keeps its network (ADR-0011 B3); a `native` verdict without it never has any. */
  network: boolean;
  allowlist(): PlannerAllowlist | undefined;
  commandPolicy(): Pick<PolicyInputs, 'autonomous' | 'approvalMode'>;
  peek?(req: ApprovalRequest): StandingDecision;
}

/** The person's refusals, which stand at every site (ADR-0036 S3). */
function refusalStands(standing: StandingDecision): boolean {
  return standing.decision === 'deny' && standing.source !== 'mode';
}

function policyFor(who: GateWho, approval: IApproval): SitePolicy {
  const peek = approval.peek;
  switch (who) {
    case 'planner':
      return {
        asks: true,
        network: true,
        allowlist: () => approval.allowlist?.(),
        commandPolicy: () => approval.commandPolicy?.() ?? {},
        ...(peek ? { peek: (req: ApprovalRequest) => peek.call(approval, req) } : {}),
      };
    case 'task':
      return {
        asks: false,
        network: true,
        allowlist: () => approval.allowlist?.() ?? parseAllowlist([]),
        commandPolicy: () => ({ ...approval.commandPolicy?.(), approvalMode: 'deny' }),
        peek: (req) => {
          const standing = peek?.call(approval, req);
          if (standing && refusalStands(standing)) return standing;
          if (standing?.decision === 'allow' && standing.source === 'pre-approved') return standing;
          return BY_MODE;
        },
      };
    case 'subagent':
      return {
        asks: false,
        network: false,
        allowlist: () => approval.allowlist?.(),
        commandPolicy: () => approval.commandPolicy?.() ?? {},
        peek: (req) => {
          const standing = peek?.call(approval, req);
          return standing && refusalStands(standing) ? standing : BY_MODE;
        },
      };
  }
}

/**
 * Decide one command line, as the model wrote it, at one site. Every check
 * reads `line` or a rewrite of it under the same shell (ADR-0008's single
 * lexer).
 */
export async function decide(line: ParsedLine, site: GateSite): Promise<GateVerdict> {
  return site.who === 'subagent' ? subagentGate(line, site) : envelope(line, site, policyFor(site.who, site.approval));
}

/**
 * A research subagent's command (ADR-0008 T6): nobody watches it, so nothing
 * it runs may reach a prompt. Only the read-only tier, naming nothing outside
 * the workspace, runs unsealed; what would ask or be refused runs sealed where
 * the host can seal it (ADR-0036 S5), and elsewhere is refused with what to
 * report instead. Either run then meets the planner's rules as a site that
 * asks nobody, so an exclusion or a denial still refuses it there (S3).
 */
async function subagentGate(line: ParsedLine, site: GateSite): Promise<GateVerdict> {
  const policy = policyFor('subagent', site.approval);
  const { tier, reason } = classifyCommand(line);
  // An `auto` binary is only auto because reading is read-only: its arguments
  // can still name a path outside the workspace, and nothing can approve one.
  // Named as resolved: after a `cd`, the path as written says nothing about
  // where it points. A device or an unfollowable path counts as outside here.
  const escaping = pathRefs(line).map((ref) => resolveRef(site.root, ref, site.hostPath)).find((r) => !r.inside);
  if (tier === 'auto' && !escaping && !site.sealed) return envelope(line, site, policy);
  if (site.sealed || await site.canSeal()) return envelope(line, { ...site, sealed: true }, policy);
  if (tier === 'refuse') return refuse(`Command refused: ${reason}`);
  if (tier === 'auto' && escaping) return refuse(subagentOutside(escaping.abs));
  return refuse(subagentUnapproved(line.raw));
}

/**
 * Path confinement for a command: an `auto` binary's arguments can still name
 * a path outside the root, which is the escape confinement closes for the
 * read tools. Each escaping path is scoped to its containing directory, one
 * entry per distinct scope.
 */
function outsidePaths(line: ParsedLine, root: string, hostPath: HostPath | undefined): { outside: Array<{ abs: string; scope: string }>; unfollowable?: string } {
  const found = new Map<string, string>();
  for (const ref of pathRefs(line)) {
    const { abs, inside, device, unfollowable } = resolveRef(root, ref, hostPath);
    if (unfollowable) return { outside: [], unfollowable: ref.path };
    if (inside || device) continue;
    const scope = grantScopeFor(abs, 'file');
    if (!found.has(scope)) found.set(scope, abs);
  }
  return { outside: [...found].map(([scope, abs]) => ({ abs, scope })) };
}

/**
 * The planner's envelope (ADR-0008), at a site. Three tiers: read-only
 * inspection runs, anything else is asked about once and remembered, and
 * writes are refused. Where the host can seal, what the envelope would refuse
 * without asking anyone runs sealed instead (ADR-0036 S2): the classifier's
 * refusal, and the approval mode's. A person's denial still refuses.
 *
 * Everything a command needs — its own approval and every outside directory
 * it touches — is one request, so one command is one prompt. Each scope is
 * still granted separately.
 */
async function envelope(original: ParsedLine, site: GateSite, policy: SitePolicy): Promise<GateVerdict> {
  const task = site.who === 'task';
  if (site.stopped) return refuse(`Command not run: ${site.stopped}.\n${TASK_CONTINUE}`);
  const line = original.reparse(disableWebCommandStartup(original));
  const command = line.raw;
  const { root } = site;
  const allow = policy.allowlist();
  const { tier, scope, reason, allowedBy, perInvocation, scopes: commandScopes, webUrls, outboundTexts } = classifyCommand(line, {
    ...policy.commandPolicy(), ...(allow ? { allow } : {}),
  });

  const { outside, unfollowable } = outsidePaths(line, root, site.hostPath);
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

  if (site.sealed) {
    if (!(await site.canSeal())) return refuse(NO_SANDBOX);
    return sealedUnlessDenied(policy, line, request, 'asked');
  }

  // A sealed run may have written what a later command reads: a script the
  // allowlisted `npm test` runs, a tool's config, a file in scratch. Run
  // outside the sealed profile, that command would read the whole host, and
  // an allowlisted one would have the network, so once a sealed run has
  // started every later command of the attempt runs sealed (ADR-0046).
  if (site.after) return sealedUnlessDenied(policy, line, request, 'after');

  // A refusal the envelope reached without asking anyone runs sealed where the
  // host can seal it (S2), and is the refusal it was elsewhere (S6).
  const sealedInstead = async (refused: string): Promise<Settled> =>
    (await site.canSeal()) ? sealedUnlessDenied(policy, line, request, 'refused') : refuse(refused);
  const unsealedNote = task ? `\n${TASK_UNSEALED} ${TASK_CONTINUE}` : '';
  if (tier === 'refuse') return sealedInstead(`Command refused: ${reason}${unsealedNote}`);
  if (unfollowable !== undefined) return sealedInstead(`Command refused: ${unfollowableReason(unfollowable)}${unsealedNote}`);

  const outbound = [...(outboundTexts ?? []), ...(webUrls ?? []).map((url) => url.href)];
  if (outbound.length && carriesSecret(outbound, [...site.outboundSecrets()])) {
    return refuse(webUrls?.length
      ? 'Command refused: a web command contains what looks like a secret. Fetch the page with your web fetch tool, without credentials.'
      : 'Command refused: what this command sends over the network contains what looks like a secret. Run it without the value.');
  }

  const vettedAddresses = new Map<string, string>();
  for (const url of webUrls ?? []) {
    const check = await site.vetEgress(url.hostname, url.port);
    if (!check.ok) return refuse(`Command refused: Blocked host: ${check.reason}. ${READ_REFUSAL_HINT}`);
    vettedAddresses.set(url.origin, check.addresses[0]);
  }

  // What runs once the command is approved, or needed no approval. The network
  // follows the tier (ADR-0011 B3): an `ask` command got here approved, by the
  // user, a standing grant, the allowlist or the mode, and keeps it where the
  // site gives approved commands any. An `auto` one, including one approved
  // only for the paths it names, has none.
  const approved = async (): Promise<Settled> => {
    // The allowlist read again: an exclusion added while the card was up holds.
    if (webUrls?.length) {
      const latest = classifyCommand(line, { ...policy.commandPolicy(), allow: policy.allowlist() });
      if (latest.tier === 'refuse') return refuse(`Command refused: ${latest.reason}`);
    }
    for (const probe of wgetVersionCommands(line)) {
      if (!probe) return refuse(`Command refused: the wget executable cannot be checked in an uncertain working directory. ${READ_REFUSAL_HINT}`);
      const version = await site.probe(probe);
      if (!version.success || !/^GNU Wget 1\./.test(version.output)) {
        return refuse(`Command refused: only GNU Wget 1.x is supported; wget2 can write persistent databases. ${READ_REFUSAL_HINT}`);
      }
    }
    const pinned = pinWebCommandAddresses(line, vettedAddresses);
    if (webUrls?.length) {
      const latest = classifyCommand(line.reparse(pinned.command), { ...policy.commandPolicy(), allow: policy.allowlist(), trustedWebResolves: pinned.resolves });
      if (latest.tier === 'refuse') return refuse(`Command refused: ${latest.reason}`);
    }
    return { kind: 'native', network: policy.network && asks, command: pinned.command };
  };

  if (!request) return approved();

  // The approval mode refuses without asking anyone, so where a sealed run
  // can start that is what runs (S2). Elsewhere the request goes in, and the
  // mode's refusal is recorded as it always was. A site that asks nobody reads
  // its standing answer, whose mode refuses whatever would ask (ADR-0046).
  const standing = policy.peek?.(request);
  if (standing?.decision === 'deny' && standing.source === 'mode' && await site.canSeal()) return sealedUnlessDenied(policy, line, request, 'refused');
  const denied = task
    ? `Command not run: ${command}\n${taskRefusal(standing)} ${TASK_CONTINUE}`
    : !policy.asks
      ? subagentUnapproved(command)
      : outside.length > 0
        ? `Access denied: "${command}" touches ${touched}, outside the workspace root (${root}), and was not approved. Keep research inside the workspace, or ask the user to approve this location.${cdUnfollowed(line) ? CD_HINT : ''}`
        : `Command not approved: ${command}\nIt is outside the auto-allowed read-only set and the planner allowlist (${scope}). ${NOT_APPROVED_HINT}${/(^| )g?sed( |$)/.test(scope) ? SED_HINT : ''}`;
  const answer = (granted: boolean): Promise<Settled> => granted ? approved() : Promise.resolve(refuse(denied));
  if (!policy.asks) return answer(standing?.decision === 'allow');
  return { kind: 'ask', request, answer };
}

/**
 * A sealed run (ADR-0036 S1) unless the person said no to it (S3): a `!`
 * exclusion naming the command or a path it touches, and a denial given on
 * the card this session, of the command or of one a wrapper carries.
 */
function sealedUnlessDenied(policy: SitePolicy, line: ParsedLine, request: ApprovalRequest | undefined, why: SealedRunReason): Settled {
  const command = line.raw;
  const allow = policy.allowlist();
  const rule = allow ? excludedBy(line, allow) : undefined;
  if (rule) return refuse(`Command refused: the planner allowlist excludes it ("${rule}"), and an exclusion holds for a sealed run too.`);
  const standing = request ? policy.peek?.(request) : undefined;
  if (request && standing?.decision === 'deny' && standing.source === 'excluded') {
    return refuse(`Command refused: the planner allowlist excludes ${request.subject === command ? 'it' : `"${request.subject}"`}, and an exclusion holds for a sealed run too.`);
  }
  if (standing?.decision === 'deny' && standing.source === 'remembered') {
    return refuse(`Command not approved: ${command}\nThe user denied it this session, and a denial holds for a sealed run too. Continue without it.`);
  }
  const denied = deniedInnerScope(policy, line);
  if (denied) return refuse(`Command not approved: ${command}\nThe user denied "${denied}" this session, and a denial holds for a sealed run too. Continue without it.`);
  return { kind: 'sealed', why, command };
}

/**
 * A scope inside the line the user denied on the card this session, or
 * undefined (S3). The whole command's request is peeked by the caller; this
 * reaches the commands a refused wrapper — a loop, a pipe — hides, each
 * remembered under its own scope, so wrapping a denied command never routes
 * around the denial. Only the person's denial: a scope the approval mode
 * alone would refuse is what a sealed run is for (S2).
 */
function deniedInnerScope(policy: SitePolicy, line: ParsedLine): string | undefined {
  if (!policy.peek) return undefined;
  for (const scope of innerCommandScopes(line)) {
    const standing = policy.peek({ kind: 'shell_command', subject: line.raw, scope });
    if (standing.decision === 'deny' && standing.source === 'remembered') return scope;
  }
  return undefined;
}
