import { v4 as uuidv4 } from 'uuid';
import type { ResearchLogEntry, ResearchProgress, ResearchStep, RunnerId } from '../models/Task';
import type { ConversationTurn, TurnRun } from './AiService';
import type { UsageLimitSignal } from './harness/AgentAdapter';
import type { RunnerModeInfo } from './ModeResolver';
import type { RunnerSignIn } from './signInHint';
import { classifyRunnerStop, PROVIDER_RETRY_DELAYS_MS } from './runnerExit';
import { redactAgentText } from '../utils/redactSecrets';
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
  /** Whether the runner's own field called the failure its usage limit, where it has one. */
  usageLimit?: UsageLimitSignal | false;
  /** With `failure`: the runner said its user is signed out, and these are its ways in (ADR-0052). */
  signIn?: RunnerSignIn;
  /**
   * The whole reply the user reads, when it is more than `text`: text from
   * calls the backend continued past on the user's behalf, joined in front.
   */
  fullText?: string;
  /**
   * The runs of reply text the call streamed, in order, `fullText` included.
   * Absent from a backend that reports none, whose discarded attempt is then
   * taken back whole.
   */
  runs?: TurnRun[];
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
}

/** A run for a message written in the planner's place: it never streamed, so a surface shows it last. */
export function noteRun(text: string): TurnRun {
  return { segmentId: uuidv4(), text, startedAt: new Date().toISOString() };
}

/**
 * The runs of a message written in place of a reply whose runs were `runs`
 * (ADR-0017 A1): the narration before its tool calls stays, and the message
 * goes last.
 */
export function writtenOver(runs: readonly TurnRun[] | undefined, text: string): TurnRun[] {
  return [...(runs ?? []).filter((run) => run.narration), noteRun(text)];
}

/** A reply's runs as one text, in the order they began, a paragraph apart. */
export function joinRuns(runs: readonly Pick<TurnRun, 'text'>[]): string {
  return runs.map((run) => run.text).filter((text) => text).join('\n\n');
}

/**
 * Settle one planner turn's reply (ADR-0002): classify what the model said,
 * and give what cannot be settled yet its bounded corrective retries — one
 * nudge for an empty reply, {@link MAX_JSON_REPAIRS} re-emits for a botched
 * envelope, the terser re-emit for a plan the output limit cut off. Both
 * planner families settle through here; how one call runs, tool rounds or an
 * agent's own turn, is the caller's `send`.
 *
 * A discarded attempt's reply is taken back before the next one answers in
 * its place, so a surface shows the retry and never the botched text beside
 * it. Nothing else ever is (ADR-0017 A1): the narration before a discarded
 * attempt's tool calls stays where it streamed, and the settled turn carries
 * it ahead of its own runs.
 */
export async function settleReply(opts: SettleReplyOptions): Promise<ConversationTurn> {
  const researchLog: ResearchLogEntry[] = [];
  const kept: TurnRun[] = [];
  const message = (text: string): Extract<ConversationTurn, { kind: 'message' }> => ({ kind: 'message', text, researchLog });
  const runs = (attempt: ReplyAttempt, own: TurnRun[]): Pick<ConversationTurn, 'runs'> =>
    (attempt.runs || kept.length > 0 ? { runs: [...kept, ...own] } : {});
  const narration = (attempt: ReplyAttempt): TurnRun[] => (attempt.runs ?? []).filter((run) => run.narration);
  const prose = (attempt: ReplyAttempt) => ({ ...message(said(attempt)), ...runs(attempt, attempt.runs ?? []) });
  const note = (attempt: ReplyAttempt, text: string) => ({ ...message(text), ...runs(attempt, writtenOver(attempt.runs, text)) });
  const discard = (attempt: ReplyAttempt) => {
    if (!attempt.runs) {
      opts.onProgress({ type: 'text_retracted' });
      return;
    }
    kept.push(...narration(attempt));
    for (const run of attempt.runs) {
      if (!run.narration) opts.onProgress({ type: 'text_retracted', segmentId: run.segmentId });
    }
  };
  let nudged = false;
  let providerRetries = 0;
  let current: ReplyAttempt | undefined;

  // An empty reply (budget models do this after tool use; an agent can end on
  // a denied call) would leave the user facing silence. It is owed one nudge
  // per turn, outside the budget a botched envelope spends.
  const send = async (text: string): Promise<ReplyAttempt> => {
    const attempt = await opts.send(text);
    current = attempt;
    researchLog.push(...attempt.researchLog);
    // A call its provider failed is tried again in the same conversation, as a task's turn is (ADR-0018 E1).
    if (providerFailed(attempt) && providerRetries < PROVIDER_RETRY_DELAYS_MS.length) {
      const delay = PROVIDER_RETRY_DELAYS_MS[providerRetries];
      providerRetries += 1;
      if (await waited(delay, opts.signal)) {
        discard(attempt);
        return send(providerRetryPrompt(attempt.failure ?? ''));
      }
    }
    if (attempt.text.trim() || attempt.aborted || attempt.failure !== undefined || nudged) return attempt;
    nudged = true;
    discard(attempt);
    return send(emptyReplyNudge(deniedStep(attempt), opts.classify !== undefined));
  };

  return repairLoop<ReplyAttempt, ConversationTurn>({
    first: () => send(opts.message),
    resend: (corrective) => {
      if (current) discard(current);
      return send(corrective);
    },
    interpret: (attempt) => {
      if (attempt.aborted) {
        const turn: ConversationTurn = { ...prose(attempt), aborted: true };
        opts.onProgress({ type: 'interrupted' });
        return { done: turn };
      }
      if (attempt.failure !== undefined) {
        const { usageLimit, signIn } = attempt;
        return { done: { ...note(attempt, attempt.failure), failed: true, ...(usageLimit !== undefined && { usageLimit }), ...(signIn && { signIn }) } };
      }
      if (!attempt.text.trim()) return { done: note(attempt, emptyReplyReport(deniedStep(attempt))) };

      // An envelope's own run is never prose: it streamed to the plan display.
      const envelope = { text: said(attempt), researchLog, ...runs(attempt, narration(attempt)) };
      const reply: PlannerReplyClassification = opts.classify ? classifyPlannerReply(attempt.text, opts.classify) : { kind: 'prose' };
      switch (reply.kind) {
        case 'plan': return { done: { kind: 'plan', tasks: reply.tasks, ...envelope } };
        case 'task_ops': return { done: { kind: 'task_ops', ops: reply.ops, ...envelope } };
        // A read is answered by the conversation, which owns the plan and the
        // catalog, so it leaves here the way a plan or an edit does.
        case 'task_query': return { done: { kind: 'task_query', query: reply.query, ...envelope } };
        case 'prose': return { done: prose(attempt) };
      }

      // Left as prose, a botched attempt would read as a chat bubble while the
      // plan or edit it meant silently failed to commit.
      if (opts.signal?.aborted) return { done: prose(attempt) };
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
    onExhausted: ({ reply }) => prose(reply),
  });
}

const said = (attempt: ReplyAttempt): string => attempt.fullText ?? attempt.text;

/** The call ended on its provider's error: a 5xx, an overload, a throttle that is not the usage limit. */
function providerFailed(attempt: ReplyAttempt): boolean {
  if (attempt.failure === undefined || attempt.aborted) return false;
  return classifyRunnerStop({ message: attempt.failure, ...(attempt.usageLimit !== undefined && { usageLimit: attempt.usageLimit }) }) === 'transient';
}

/** Wait out a backoff; false when the turn was stopped first, which ends the wait. */
function waited(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How much of a provider's error the retry repeats: some carry a whole response body. */
const PROVIDER_ERROR_CLIP = 300;

function providerRetryPrompt(failure: string): string {
  // The provider's words, which the conversation shows: redacted as all runner text is, then cut.
  const clean = redactAgentText(failure);
  const error = clean.length > PROVIDER_ERROR_CLIP ? `${clean.slice(0, PROVIDER_ERROR_CLIP)}…` : clean;
  return `Your last reply failed on a provider error, not on anything you did: ${error}. Continue where you left off and answer the user's last message.`;
}

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
