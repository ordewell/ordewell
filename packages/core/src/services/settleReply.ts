import type { ResearchLogEntry, ResearchProgress, ResearchStep, RunnerId } from '../models/Task';
import type { ConversationTurn } from './AiService';
import type { RunnerModeInfo } from './ModeResolver';
import {
  classifyPlannerReply, type PlannerReplyClassification, reEmitPlanPrompt, reEmitTaskOpsPrompt, reEmitTaskQueryPrompt, repairLoop, truncatedPlanReEmitPrompt,
} from './PlanRepair';

/** Corrective re-emits a botched envelope is owed per turn, on every planner backend. */
export const MAX_JSON_REPAIRS = 2;

/** One model call of a turn, run to the reply it ended on. */
export interface ReplyAttempt {
  /** The model's reply — what gets classified. */
  text: string;
  researchLog: ResearchLogEntry[];
  /** The provider said its output-token limit cut the reply off. */
  cutOff?: boolean;
  /** The call was stopped: what it had settles as a message, never classified. */
  aborted?: boolean;
  /** The call ended without a reply (a dead agent, a spent tool budget), and this says why. */
  failure?: string;
  /**
   * The whole reply the user reads, when it is more than `text`: text from
   * calls the backend continued past on the user's behalf, joined in front.
   */
  fullText?: string;
}

export interface SettleReplyOptions {
  /** The user's message, or whatever opens the turn. */
  message: string;
  /** Send one message to the model and run the call to its reply. */
  send: (message: string) => Promise<ReplyAttempt>;
  /**
   * What a reply's plan, edit and read envelopes are checked against. Absent
   * for a planner that plans only through Ordewell's tools (ADR-0025): its
   * reply is prose whatever JSON it carries, and is never sent back to fix one.
   */
  classify?: { runners: RunnerId[]; runnerModes?: Record<RunnerId, RunnerModeInfo[]>; autonomousDefault?: boolean };
  onProgress: (progress: ResearchProgress) => void;
  signal?: AbortSignal;

  // Where the planner families really differ (ADR-0009).

  /**
   * Free input context before a cut-off plan is re-emitted, returning the
   * characters removed. Only a backend that holds the model's context can: a
   * harness agent owns its own, and gets the terser re-emit alone.
   */
  compactHistory?: () => number;
  /**
   * The reply joins every segment its call streamed — a harness agent's text
   * around its tool calls — so a message settling it takes them all back
   * first, since the message replaces only the final segment. An API call's
   * reply is its final segment alone, and the text before its tool calls stays.
   */
  replyJoinsSegments: boolean;
}

/**
 * Settle one planner turn's reply (ADR-0002): classify what the model said,
 * and give what cannot be settled yet its bounded corrective retries — one
 * nudge for an empty reply, {@link MAX_JSON_REPAIRS} re-emits for a botched
 * envelope, the terser re-emit for a plan the output limit cut off. Both
 * planner families settle through here; how one call runs, tool rounds or an
 * agent's own turn, is the caller's `send`.
 *
 * What a discarded attempt streamed is taken back before the next one
 * answers in its place, so a surface shows the retry and never the botched
 * text beside it.
 */
export async function settleReply(opts: SettleReplyOptions): Promise<ConversationTurn> {
  const researchLog: ResearchLogEntry[] = [];
  const message = (text: string): Extract<ConversationTurn, { kind: 'message' }> => ({ kind: 'message', text, researchLog });
  const retract = () => opts.onProgress({ type: 'text_retracted' });
  const asProse = (attempt: ReplyAttempt) => {
    if (opts.replyJoinsSegments) retract();
    return message(said(attempt));
  };
  let nudged = false;

  // An empty reply (budget models do this after tool use; an agent can end on
  // a denied call) would leave the user facing silence. It is owed one nudge
  // per turn, outside the budget a botched envelope spends.
  const send = async (text: string): Promise<ReplyAttempt> => {
    const attempt = await opts.send(text);
    researchLog.push(...attempt.researchLog);
    if (attempt.text.trim() || attempt.aborted || attempt.failure !== undefined || nudged) return attempt;
    nudged = true;
    retract();
    return send(emptyReplyNudge(deniedStep(attempt), opts.classify !== undefined));
  };

  return repairLoop<ReplyAttempt, ConversationTurn>({
    first: () => send(opts.message),
    resend: (corrective) => {
      retract();
      return send(corrective);
    },
    interpret: (attempt) => {
      if (attempt.aborted) {
        const turn: ConversationTurn = { ...asProse(attempt), aborted: true };
        opts.onProgress({ type: 'interrupted' });
        return { done: turn };
      }
      if (attempt.failure !== undefined) return { done: message(attempt.failure) };
      if (!attempt.text.trim()) return { done: message(emptyReplyReport(deniedStep(attempt))) };

      const reply: PlannerReplyClassification = opts.classify ? classifyPlannerReply(attempt.text, opts.classify) : { kind: 'prose' };
      switch (reply.kind) {
        case 'plan': return { done: { kind: 'plan', tasks: reply.tasks, text: said(attempt), researchLog } };
        case 'task_ops': return { done: { kind: 'task_ops', ops: reply.ops, text: said(attempt), researchLog } };
        // A read is answered by the conversation, which owns the plan and the
        // catalog, so it leaves here the way a plan or an edit does.
        case 'task_query': return { done: { kind: 'task_query', query: reply.query, text: said(attempt), researchLog } };
        case 'prose': return { done: asProse(attempt) };
      }

      // Left as prose, a botched attempt would read as a chat bubble while the
      // plan or edit it meant silently failed to commit.
      if (opts.signal?.aborted) return { done: asProse(attempt) };
      const errors = [reply.error.message];
      switch (reply.kind) {
        case 'broken_task_ops': return { retry: { errors, corrective: reEmitTaskOpsPrompt(reply.error.message), cause: reply.error } };
        case 'broken_task_query': return { retry: { errors, corrective: reEmitTaskQueryPrompt(reply.error.message), cause: reply.error } };
        case 'broken_plan': {
          const corrective = reply.error.truncated || attempt.cutOff
            ? () => truncatedPlanReEmitPrompt((opts.compactHistory?.() ?? 0) > 0)
            : reEmitPlanPrompt(reply.error.message);
          return { retry: { errors, corrective, cause: reply.error } };
        }
      }
    },
    maxRepairs: MAX_JSON_REPAIRS,
    onExhausted: ({ reply }) => asProse(reply),
  });
}

const said = (attempt: ReplyAttempt): string => attempt.fullText ?? attempt.text;

function deniedStep(attempt: ReplyAttempt): ResearchStep | undefined {
  return attempt.researchLog.find((e): e is ResearchStep => !('type' in e) && e.outcome === 'denied');
}

const stepName = (step: ResearchStep): string => step.toolLabel ?? step.tool;

// The denial's own result says why, in its backend's terms: a harness planner
// is refused anything but reading, an API planner's command can go unapproved.
function emptyReplyNudge(denied: ResearchStep | undefined, envelopes: boolean): string {
  return denied
    ? `Your last reply was empty after "${stepName(denied)}" was denied: ${denied.result} Do not retry it. Answer the user now with what you already know, or ask your next question.`
    : `Your last reply was empty. Respond to the user now: answer their last message directly, ask your next question, or ${envelopes ? 'emit the plan JSON' : 'submit the plan with submit_plan'}.`;
}

function emptyReplyReport(denied: ResearchStep | undefined): string {
  return denied
    ? `The planner stopped without replying after "${stepName(denied)}" was denied: ${denied.result}`
    : 'The planner returned an empty reply twice. Please rephrase or try again.';
}
