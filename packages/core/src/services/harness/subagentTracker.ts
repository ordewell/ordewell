import type { SubagentOutcome } from '../../models/Task';
import type { AgentEvent } from './AgentAdapter';
import type { TurnOutcome } from './turnOutcome';

/**
 * What a delegating call asked of its subagent: the `description` a runner
 * gives it, else the `prompt` it was sent with. Every runner that delegates
 * through a tool call puts the brief in one of the two.
 */
export function subagentBrief(input: Record<string, unknown> | undefined): string {
  if (typeof input?.description === 'string') return input.description;
  return typeof input?.prompt === 'string' ? input.prompt : '';
}

/**
 * How a runner reported a subagent's end: the delegating call's pass or fail,
 * or a status of its own for the runners that name one.
 */
export type SubagentSaid = { success: boolean } | { status: SubagentOutcome };

/**
 * A subagent's lifecycle as the planner and the task view are told of it.
 * Runners restate it: a tool part is re-sent at every status change, a collab
 * item at every later call that observed the child. This is where "once" is
 * decided, so the service downstream forwards what it is given, and no runner
 * can report a finish for a subagent it never started, or a second one for a
 * subagent already finished.
 *
 * It lives as long as the adapter, not the turn: a backgrounded subagent
 * outlives the turn that launched it and finishes in a later one.
 *
 * A subagent an interrupt cut short is `stopped`, never `failed` (ADR-0018
 * W1): the runner reports the call it interrupted as an error, which is the
 * stop that was asked for. The latch is the turn's own, so this reads what the
 * turn's end reads and cannot disagree with it.
 */
export class SubagentTracker {
  private readonly lifecycle = new Map<string, 'open' | 'finished'>();

  constructor(private readonly turn: TurnOutcome) {}

  /** Whether the subagent started and has not finished: a result for any other call is not its end. */
  isOpen(id: string): boolean {
    return this.lifecycle.get(id) === 'open';
  }

  /** Report a subagent's start, once; false when it was already reported. */
  start(subagent: { id: string; brief: string; model?: string }, emit: (event: AgentEvent) => void): boolean {
    if (this.lifecycle.has(subagent.id)) return false;
    this.lifecycle.set(subagent.id, 'open');
    emit({ type: 'subagent_started', subagentId: subagent.id, brief: subagent.brief, ...(subagent.model ? { model: subagent.model } : {}) });
    return true;
  }

  /** Report a subagent's finish, once and only after its start; false when there is nothing to report. */
  finish(id: string, said: SubagentSaid, digest: string, emit: (event: AgentEvent) => void): boolean {
    if (!this.isOpen(id)) return false;
    this.lifecycle.set(id, 'finished');
    emit({ type: 'subagent_finished', subagentId: id, outcome: this.outcomeOf(said), digest });
    return true;
  }

  private outcomeOf(said: SubagentSaid): SubagentOutcome {
    const outcome = 'status' in said ? said.status : said.success ? 'done' : 'failed';
    return outcome === 'failed' && this.turn.requested ? 'stopped' : outcome;
  }
}
