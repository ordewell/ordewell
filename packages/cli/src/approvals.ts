/**
 * The CLI's side of a planner approval prompt.
 *
 * Kept out of `plan.ts` so it is testable without a server, a socket, or a TTY:
 * the whole interaction is a pure function of the event plus three injected
 * capabilities. `plan.ts` supplies the real reader, stderr, and API client.
 */

export interface ApprovalDeps {
  respond: (sessionId: string, approvalId: string, granted: boolean) => Promise<unknown>;
  ask: (question: string) => Promise<string>;
  write: (text: string) => void;
  /** `--yes`: grant without prompting. Still printed, so the log records what ran. */
  autoApprove?: boolean;
  /** False in a pipe or CI, where there is nobody to answer. Defaults to true. */
  interactive?: boolean;
}

/** A socket event, which may or may not be an approval request. */
export interface ApprovalEvent {
  type: string;
  id?: unknown;
  kind?: unknown;
  subject?: unknown;
  scope?: unknown;
  detail?: unknown;
  [key: string]: unknown;
}

export function describeApproval(event: ApprovalEvent): string {
  const subject = String(event.subject ?? '');
  const scope = String(event.scope ?? '');
  const detail = event.detail ? String(event.detail) : '';

  const headline = event.kind === 'shell_command'
    ? `The planner wants to run a command:\n    ${subject}`
    : event.kind === 'url_fetch'
      ? `The planner wants to fetch a URL:\n    ${subject}`
      : `The planner wants to read a path outside the workspace:\n    ${subject}`;

  // `detail` disambiguates the `external_path` case in particular: an
  // auto-tier command like `cat` touching an outside path reads identically
  // to a plain `read_file` without it.
  const detailLine = detail ? `\n  ${detail}` : '';

  // The grant is deliberately wider than the request, so say so rather than
  // letting the user discover it when the next call does not prompt.
  return `${headline}${detailLine}\n  Approving also allows: ${scope}`;
}

/**
 * A decision reached with no round-trip prompt (pre-approved, remembered from
 * earlier this session, or the operator's mode floor) previously printed
 * nothing at all — indistinguishable, in the headless log, from the model
 * never having needed approval in the first place.
 */
export function describeApprovalDecision(event: ApprovalEvent & { granted?: unknown; source?: unknown }): string {
  const subject = String(event.subject ?? '');
  const source = String(event.source ?? '');
  const label = source === 'pre-approved' ? 'pre-approved'
    : source === 'remembered' ? 'remembered'
    : source === 'mode' ? 'policy'
    : 'no approval channel';
  return `${event.granted ? 'Auto-approved' : 'Auto-denied'} (${label}): ${subject}`;
}

/**
 * One handler per planning run, each owning its own answered-id memory — a
 * reconnecting socket can replay a request, and answering twice would either
 * double-prompt or 409. Deliberately not module-level state: that leaks
 * between runs in the same process.
 */
export function createApprovalHandler(sessionId: string, deps: ApprovalDeps) {
  const answered = new Set<string>();
  return (event: ApprovalEvent) => handleApprovalEvent(sessionId, event, deps, answered);
}

export async function handleApprovalEvent(
  sessionId: string,
  event: ApprovalEvent,
  deps: ApprovalDeps,
  answered: Set<string> = new Set(),
): Promise<void> {
  if (event.type === 'approval_decided') {
    deps.write(`\n${describeApprovalDecision(event)}\n`);
    return;
  }
  if (event.type !== 'approval_request') return;
  const id = String(event.id ?? '');
  if (!id || answered.has(id)) return;
  answered.add(id);

  const interactive = deps.interactive ?? true;
  deps.write(`\n${describeApproval(event)}\n`);

  let granted: boolean;
  if (deps.autoApprove) {
    granted = true;
    deps.write('  Approved automatically (--yes).\n');
  } else if (!interactive) {
    granted = false;
    deps.write('  Denied: no interactive terminal. Re-run with --yes, or pre-approve via ORDEWELL_APPROVAL_ALLOW.\n');
  } else {
    const answer = (await deps.ask('  Allow? [y/N] ')).trim().toLowerCase();
    granted = answer === 'y' || answer === 'yes';
  }

  try {
    await deps.respond(sessionId, id, granted);
  } catch {
    // The planner's own timeout will deny this request; failing the whole
    // planning run because one answer could not be delivered would be worse.
    deps.write('  (could not deliver the answer — the planner will treat it as denied)\n');
  }
}
