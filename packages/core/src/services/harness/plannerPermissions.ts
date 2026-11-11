import { realpathSync } from 'fs';
import type { ApprovalDecision, IApproval } from '../../interfaces/IApproval';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';
import { grantScopeFor, resolveWithin } from '../pathScope';
import type { AgentStartOptions, PlannerAsk, TaskStartOptions } from './AgentAdapter';
import { NOT_APPROVED_HINT } from '../effectRoute';

/**
 * What a harness planner's own tool requests are decided against (ADR-0026):
 * the session's approval policy, the API planner's, and the web fetcher, whose
 * web-read policy decides a fetch (ADR-0027). Without `approval` nobody can be
 * asked, and only what the envelope holds anyway is allowed: the workspace and
 * the runner's own saved output (ADR-0032).
 */
export interface PlannerPermissionGate {
  approval?: IApproval;
  fetcher?: IWebFetcher;
  workspaceRoot: string;
  savedOutput?: (abs: string) => boolean;
}

// `other` is not always a write: a read the envelope has no rule for lands here
// too, so the message names the envelope rather than claiming an edit was tried.
const UNKNOWN_TOOL_DENIAL = 'The Ordewell planner is read-only and its envelope has no rule for this tool, so it did not run. Read with the read tools, use run_command for commands and fetch or web_search for the web; changes belong to the plan\'s tasks.';

const ALLOW: ApprovalDecision = { decision: 'allow' };
const NOBODY_TO_ASK = 'Nobody can approve this here. Continue without it.';

const SUBJECT_MAX_CHARS = 400;

function deny(note: string): ApprovalDecision {
  return { decision: 'deny', note };
}

function onDisk(target: string): string | undefined {
  try { return realpathSync.native(target); } catch { return undefined; }
}

/**
 * Where a harness planner's read lands. Its runner's in-workspace reads are
 * decided here (ADR-0028), so a link the repository ships pointing outside it
 * is followed, unlike `pathScope`'s lexical check; a path that does not exist
 * is judged as written.
 */
function readTarget(root: string, target: string): { abs: string; inside: boolean } {
  const written = resolveWithin(root, target);
  const real = onDisk(written.abs);
  return real === undefined ? written : resolveWithin(onDisk(root) ?? root, real);
}

/** ADR-0046: the manifest selects the profile; the credential also identifies its task tools. */
export function readOnlyTask(opts: AgentStartOptions | null | undefined): boolean {
  return opts?.kind === 'task' && (opts.flags.readOnly === true || opts.mcp?.readOnly === true);
}

/** No native tool may write or ask a person on a read-only task (ADR-0046). */
export function decideReadOnlyTaskPermission(ask: PlannerAsk | undefined, site: Pick<TaskStartOptions, 'cwd' | 'workspaceRoot'>): ApprovalDecision {
  if (ask?.kind === 'path') {
    const target = resolveWithin(site.cwd, ask.path).abs;
    if ([site.cwd, site.workspaceRoot].some((root) => root !== undefined && readTarget(root, target).inside)) return ALLOW;
    return deny('This read is outside the task worktree and workspace. Nobody can approve it here.');
  }
  return deny('This native tool is unavailable on a read-only task. Use Ordewell run_command for commands, and Ordewell fetch and web_search for the web; nobody can approve native tools here.');
}

export function readOnlyTaskPolicy(opts: AgentStartOptions | null | undefined): ((request: { ask?: PlannerAsk }) => ApprovalDecision) | undefined {
  if (opts?.kind !== 'task' || !readOnlyTask(opts)) return undefined;
  return (request) => decideReadOnlyTaskPermission(request.ask, opts);
}

export async function decidePlannerPermission(
  ask: PlannerAsk | undefined,
  input: Record<string, unknown>,
  gate: PlannerPermissionGate,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  if (!ask || ask.kind === 'other') return deny(ask?.note ?? UNKNOWN_TOOL_DENIAL);
  if (ask.kind === 'path') return decideRead(ask, gate, signal);
  // The opt-in is the consent (ADR-0036 N1): the command runs under Ordewell's
  // sealed profile, with the network its harness gives it (N2, N3), and every
  // call is on the timeline already. Asking per command would be a second
  // consent for the same grant, and nobody is there to give it in a one-shot.
  if (ask.kind === 'native-shell') return ALLOW;
  // It asked only so the read limit could count it (ADR-0068); a read outside
  // the workspace is decided by the `path` request it raises as well.
  if (ask.kind === 'native-read') return ALLOW;
  const { approval } = gate;
  if (!approval) return deny(NOBODY_TO_ASK);

  switch (ask.kind) {
    case 'mcp': {
      const args = JSON.stringify(input);
      const subject = `${ask.server ?? 'MCP'} · ${ask.tool} ${args.length > SUBJECT_MAX_CHARS ? `${args.slice(0, SUBJECT_MAX_CHARS)}…` : args}`;
      const granted = await approval.request({
        kind: 'mcp_tool',
        subject,
        scope: ask.scope,
        tool: ask.tool,
        detail: `The planner wants to use "${ask.tool}"${ask.server ? ` from ${ask.server}` : ''}. It may change things outside the repository.`,
      }, { signal });
      return granted ? ALLOW : deny(`Not approved: ${ask.scope}. ${NOT_APPROVED_HINT}`);
    }
    case 'fetch': {
      if (!gate.fetcher) return deny('This fetch cannot be approved here.');
      const decision = await gate.fetcher.decide({ kind: 'fetch', url: ask.url });
      return decision.allowed ? ALLOW : deny(decision.reason);
    }
    case 'search': {
      if (!gate.fetcher) return deny('This search cannot be approved here.');
      const decision = await gate.fetcher.decide({
        kind: 'search',
        query: ask.query,
        provider: ask.provider,
        providerLabel: ask.providerLabel,
        // It runs at the provider, which already holds the conversation the query came from.
        note: `${ask.provider} runs this search itself and already sees this planner's conversation.`,
      });
      return decision.allowed ? ALLOW : deny(decision.reason);
    }
  }
}

async function decideRead(ask: Extract<PlannerAsk, { kind: 'path' }>, gate: PlannerPermissionGate, signal?: AbortSignal): Promise<ApprovalDecision> {
  const { abs, inside } = readTarget(gate.workspaceRoot, ask.path);
  if (inside || gate.savedOutput?.(abs)) return ALLOW;
  if (!gate.approval) return deny(NOBODY_TO_ASK);
  const granted = await gate.approval.request({
    kind: 'external_path',
    subject: abs,
    scope: grantScopeFor(abs, ask.directory ? 'directory' : 'file'),
    detail: `Planner research wants to read ${abs}, outside the workspace (${gate.workspaceRoot}).`,
  }, { signal });
  return granted ? ALLOW : deny(`Access denied: "${abs}" is outside the workspace and was not approved.`);
}
