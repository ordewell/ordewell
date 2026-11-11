import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { PlannerAsk, TaskStartOptions } from './AgentAdapter';
import type { AcpToolCall } from './acpSchema';
import type { AcpAskedCall, AcpProfile, AcpRoles } from './acpProfiles';
import { existsSync } from 'fs';
import { resolveWithin } from '../pathScope';
import { decideReadOnlyTaskPermission } from './plannerPermissions';

/** The roles a profile claims, refused when they cannot hold (ADR-0060, R3): the connector table is built at load, so a bad profile never ships. */
export function acpRoles(profile: Pick<AcpProfile, 'manifest' | 'roles' | 'restricted'>): AcpRoles {
  const roles = profile.roles ?? { plans: false, readOnly: false };
  const name = profile.manifest.displayName;
  const readOnlyMode = profile.manifest.modes?.some((mode) => mode.readOnly) ?? false;
  if (roles.readOnly !== readOnlyMode) {
    throw new Error(roles.readOnly
      ? `${name} claims the read-only role, but its manifest has no mode tagged readOnly.`
      : `${name}'s manifest tags a read-only mode its profile does not claim.`);
  }
  if ((roles.plans || roles.readOnly) && !profile.restricted?.args.length) {
    throw new Error(`${name} claims a planner or read-only role without the controls that take its own write and shell tools away.`);
  }
  return roles;
}

const MISSING_PATH = 'This path is not on disk, and the agent would read a near match in its place, so it was not read. Name a file or directory that exists.';

/**
 * A request in the envelope's terms. A read or a search is a path only when it
 * names exactly one: several cannot be put to the envelope as one ask, and
 * none says nothing it could judge. The paths are its locations and, for an
 * agent that leaves those out, what the profile reads from its arguments,
 * resolved where the agent runs: it reads a relative path from there, not
 * from the workspace (ADR-0008). Both are counted together, so a derived path
 * never stands in for a location it disagrees with.
 *
 * A derived path must be on disk: an agent that names its files only in its
 * arguments may open a near match in place of a missing one (Cline tries
 * Unicode-whitespace, NFD and apostrophe variants), and that entry can be a
 * link out of the workspace, so the path as written proves nothing.
 */
export function acpAsk(call: AcpToolCall, site: { profile: Pick<AcpProfile, 'askedPaths'>; cwd: string }): PlannerAsk {
  if (call.kind === 'read' || call.kind === 'search') {
    const derived = (site.profile.askedPaths?.(call) ?? []).map((path) => resolveWithin(site.cwd, path).abs);
    if (derived.some((path) => !existsSync(path))) return { kind: 'other', note: MISSING_PATH };
    const paths = [...(call.locations ?? []).map((location) => location.path), ...derived];
    if (paths.length === 1) return { kind: 'path', path: paths[0], directory: call.kind === 'search' };
  }
  const input = call.rawInput;
  const url = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).url : undefined;
  if (call.kind === 'fetch' && typeof url === 'string') return { kind: 'fetch', url };
  return { kind: 'other' };
}

const deny = (note: string): ApprovalDecision => ({ decision: 'deny', note });

/**
 * What a planner or a read-only task is never allowed, whatever the agent's
 * own controls let through: no change to the worktree, no command outside
 * Ordewell's `run_command` (ADR-0046), and no leaving the mode it was started
 * in. ACP's kind is the agent's own word for what a call does.
 */
const REFUSED: Readonly<Record<string, string>> = {
  edit: 'Nothing may be written here: this session is read-only.',
  delete: 'Nothing may be deleted here: this session is read-only.',
  move: 'Nothing may be moved here: this session is read-only.',
  execute: 'Your own shell is off here. Run commands with Ordewell\'s run_command.',
  switch_mode: 'This session stays in the mode it was started in.',
};

export const DELEGATION_REFUSED = 'No other agent may be started here: its work would run outside this session\'s rules. Do the work yourself, or plan a research task for it.';

/**
 * The answer to a request on a restricted start, or undefined to hold it for
 * the planner's envelope, which `CliAgentAiService` applies to every held
 * request with its `ask` (ADR-0026). A read-only task has nobody to ask, so
 * everything is answered here (ADR-0046). A request may ask only for the path
 * its call needs, as a read, where the turn reported the call as a write or a
 * command: Copilot asks so for a file it would create, so the call is refused
 * for what either says it does. A call of the agent's own delegation tool is
 * refused by its name, before its kind is read: an agent may call a spawn
 * `think` or `read` (ADR-0026).
 */
export function decideRestricted(
  { request, report }: AcpAskedCall,
  ask: PlannerAsk,
  start: { kind: 'planner' } | Pick<TaskStartOptions, 'kind' | 'cwd' | 'workspaceRoot'>,
  profile: Pick<AcpProfile, 'delegation'>,
): ApprovalDecision | undefined {
  const delegation = profile.delegation;
  const tool = delegation?.toolOf(report ? { request, report } : { request });
  if (tool && delegation?.tools.includes(tool)) return deny(DELEGATION_REFUSED);
  const refused = [request.kind, report?.kind].map((kind) => (kind ? REFUSED[kind] : undefined)).find((note) => note !== undefined);
  if (refused) return deny(refused);
  if (request.kind === 'think') return { decision: 'allow' };
  return start.kind === 'task' ? decideReadOnlyTaskPermission(ask, start) : undefined;
}
