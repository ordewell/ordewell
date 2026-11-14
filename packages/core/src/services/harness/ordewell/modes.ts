import type { ApprovalDecision } from '../../../interfaces/IApproval';
import { ORDEWELL_FULL_MODE, ORDEWELL_GUARDED_MODE, ORDEWELL_READ_ONLY_MODE } from '../../../plugins/builtin/ordewell.manifest';
import type { AgentEvent, TaskStartOptions } from '../AgentAdapter';
import { PermissionLedger } from '../permissionLedger';
import { grantCovers, proposedGrant } from './commandGrants';
import { ordewellTools, type GateDecision, type OrdewellTool, type ToolGate } from './tools';

/**
 * The runner's modes (ADR-0070). It has no permission system of its own, so
 * each is enforced here, once, at the attempt's start: the mode decides which
 * tools exist and whether the shell asks, and neither changes mid-attempt, so
 * the request's tool list, and with it the cached prefix, holds.
 */
export type OrdewellMode = 'full' | 'guarded' | 'read-only';

/** The attempt's mode: a read-only task is read-only whatever level it was planned at (ADR-0046). */
export function attemptModeOf(opts: TaskStartOptions): OrdewellMode {
  if (opts.flags.readOnly) return 'read-only';
  if (opts.mode === ORDEWELL_FULL_MODE) return 'full';
  if (opts.mode === ORDEWELL_GUARDED_MODE) return 'guarded';
  if (opts.mode === ORDEWELL_READ_ONLY_MODE) {
    throw new Error(`Mode "${ORDEWELL_READ_ONLY_MODE}" of the Ordewell runner is for a read-only task: a change task runs "${ORDEWELL_FULL_MODE}" or "${ORDEWELL_GUARDED_MODE}".`);
  }
  throw new Error(`The Ordewell runner has no mode "${opts.mode}": its modes are "${ORDEWELL_FULL_MODE}", "${ORDEWELL_GUARDED_MODE}" and "${ORDEWELL_READ_ONLY_MODE}".`);
}

/**
 * The file and shell tools the mode offers. Read-only keeps only what touches
 * nothing: its one shell is the sealed `run_command` and its web the token's
 * `fetch` and `web_search`, both task tools (ADR-0046).
 */
export function toolsOf(mode: OrdewellMode): readonly OrdewellTool[] {
  return mode === 'read-only' ? ordewellTools.filter((tool) => tool.effect === 'read') : ordewellTools;
}

type Answer = (decision: ApprovalDecision | undefined) => void;

/**
 * Guarded's shell (ADR-0070): every `shell` call is a request a person answers
 * through the runner approval path, unless a grant this attempt was given
 * covers the line (see commandGrants). A denial is a refused call whose note
 * the model reads; an abort withdraws the request, so no answer runs it late.
 */
export class GuardedShell {
  private readonly grants = new Set<string>();
  private readonly ledger = new PermissionLedger<Answer>((answer, decision) => answer(decision), () => ({ role: 'task', autoApprove: false }));
  private readonly withdrawals = new Map<string, () => void>();
  private asked = 0;

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  readonly gate: ToolGate = async ({ tool, args, signal }) => {
    if (tool.effect !== 'exec') return { allow: true };
    const command = typeof args.command === 'string' ? args.command : '';
    if ([...this.grants].some((prefix) => grantCovers(prefix, command))) return { allow: true };

    const id = `shell-${++this.asked}`;
    const prefix = proposedGrant(command);
    const decision = await new Promise<ApprovalDecision | undefined>((resolve) => {
      const settle = (answer: ApprovalDecision | undefined): void => {
        signal.removeEventListener('abort', withdraw);
        this.withdrawals.delete(id);
        resolve(answer);
      };
      const withdraw = (): void => {
        this.ledger.withdraw(id, this.emit);
        settle(undefined);
      };
      if (signal.aborted) return withdraw();
      signal.addEventListener('abort', withdraw, { once: true });
      this.withdrawals.set(id, withdraw);
      this.ledger.raise(
        { id, name: tool.name, detail: command, input: { command }, suggestions: prefix ? [{ type: 'commandPrefix', prefix }] : [], ordewell: false },
        settle,
        this.emit,
      );
    });
    signal.throwIfAborted();
    return this.verdict(decision, prefix);
  };

  /** A person's answer to an open request; false when it is not open. */
  answer(id: string, decision: ApprovalDecision): boolean {
    return this.ledger.answer(id, decision);
  }

  /** A stopped turn takes no answer: what it held open is cancelled, never run late. */
  cancelOpen(): void {
    for (const withdraw of [...this.withdrawals.values()]) withdraw();
  }

  private verdict(decision: ApprovalDecision | undefined, prefix: string | undefined): GateDecision {
    if (decision?.decision === 'allowForTask' && prefix) this.grants.add(prefix);
    if (decision && decision.decision !== 'deny') return { allow: true };
    if (!decision) return { allow: false, reason: 'Interrupted: the turn was stopped before this shell command was answered.' };
    const note = decision.note?.trim() ? ` Their note: ${decision.note.trim()}` : '';
    return { allow: false, reason: `The user denied this shell command.${note}` };
  }
}
