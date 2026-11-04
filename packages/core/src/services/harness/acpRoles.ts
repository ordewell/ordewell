import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { PlannerAsk, TaskStartOptions } from './AgentAdapter';
import type { AcpToolCall } from './acpSchema';
import type { AcpAskedCall, AcpProfile, AcpRoles } from './acpProfiles';
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

/**
 * A request in the envelope's terms. A read or a search is a path only when it
 * names exactly one: several cannot be put to the envelope as one ask, and
 * none says nothing it could judge.
 */
export function acpAsk(call: AcpToolCall): PlannerAsk {
  const locations = call.locations ?? [];
  if ((call.kind === 'read' || call.kind === 'search') && locations.length === 1) {
    return { kind: 'path', path: locations[0].path, directory: call.kind === 'search' };
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

/**
 * The answer to a request on a restricted start, or undefined to hold it for
 * the planner's envelope, which `CliAgentAiService` applies to every held
 * request with its `ask` (ADR-0026). A read-only task has nobody to ask, so
 * everything is answered here (ADR-0046). A request may ask only for the path
 * its call needs, as a read, where the turn reported the call as a write or a
 * command: Copilot asks so for a file it would create, so the call is refused
 * for what either says it does.
 */
export function decideRestricted(
  { request, report }: AcpAskedCall,
  ask: PlannerAsk,
  start: { kind: 'planner' } | Pick<TaskStartOptions, 'kind' | 'cwd' | 'workspaceRoot'>,
): ApprovalDecision | undefined {
  const refused = [request.kind, report?.kind].map((kind) => (kind ? REFUSED[kind] : undefined)).find((note) => note !== undefined);
  if (refused) return deny(refused);
  if (request.kind === 'think') return { decision: 'allow' };
  return start.kind === 'task' ? decideReadOnlyTaskPermission(ask, start) : undefined;
}
