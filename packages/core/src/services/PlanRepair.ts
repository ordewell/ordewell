import type { Task, RunnerId } from '../models/Task';
import {
  PlanParseError, extractObjectsWithKey,
  PLAN_ENVELOPE_KEY, TASK_OPS_ENVELOPE_KEY, TASK_QUERY_ENVELOPE_KEY,
} from './JsonExtractor';
import { parsePlanJson, looksLikePlanAttempt } from './PlanValidator';
import { parseTaskOpsJson, textHasTaskOps, type TaskOp } from './TaskOps';
import { parseTaskQueryJson, textHasTaskQuery, type TaskQuery } from './TaskQuery';
import type { RunnerModeInfo } from './ModeResolver';

/**
 * The one owner of "the model emitted something unusable — correct it and
 * retry". Every repair path in the planner routes through this module:
 *
 * - {@link repairLoop} is the bounded driver (first reply → interpret →
 *   corrective re-send), used by plan generation ({@link generatePlanWithRepair}),
 *   the Session's task-ops settlement, and Planner.modifyDuringExecution.
 * - {@link classifyPlannerReply} decides what a planner reply *is* — a plan,
 *   targeted task edits, a botched attempt at either (worth a corrective
 *   retry), or prose. The conversation loop in BaseAiService keeps its own
 *   driver (it also runs the tool rounds) but delegates classification here.
 * - The corrective prompt texts live here, once.
 *
 * Policies stay at the call sites (ops validation, abort guards) —
 * they are inputs to the loop, not part of it.
 */

export type RepairVerdict<T> =
  | { done: T }
  | { retry: { errors: string[]; corrective: string; cause?: unknown } };

export interface RepairLoopOpts<R, T> {
  /** Produce the first reply (attempt 0) — often already in hand. */
  first: () => R | Promise<R>;
  /** Ask the model again with a corrective prompt after a retryable failure. */
  resend: (corrective: string) => Promise<R>;
  /**
   * Judge one reply: `done` with the settled value, or `retry` with the
   * errors and the corrective prompt to send. Throw for non-retryable
   * failures — those propagate immediately.
   */
  interpret: (reply: R) => RepairVerdict<T> | Promise<RepairVerdict<T>>;
  /** Corrective re-sends allowed after the first attempt (N repairs = N+1 attempts). */
  maxRepairs: number;
  /** Budget exhausted: receives the last reply and its errors; return a fallback or throw. */
  onExhausted: (last: { reply: R; errors: string[]; cause?: unknown }) => T;
}

export async function repairLoop<R, T>(opts: RepairLoopOpts<R, T>): Promise<T> {
  let reply = await opts.first();
  for (let repairs = 0; ; repairs++) {
    const verdict = await opts.interpret(reply);
    if ('done' in verdict) return verdict.done;
    if (repairs >= opts.maxRepairs) {
      return opts.onExhausted({ reply, errors: verdict.retry.errors, cause: verdict.retry.cause });
    }
    reply = await opts.resend(verdict.retry.corrective);
  }
}

// ---------------------------------------------------------------------------
// Corrective prompts — the texts the model sees when it must re-emit.
// ---------------------------------------------------------------------------

/** Instruction appended to a follow-up request asking the model to re-emit strict JSON. */
export const JSON_REPAIR_INSTRUCTION =
  'Your previous response could not be parsed as JSON. Re-send ONLY the JSON object — ' +
  'no prose before or after, no explanation, no markdown code fences.';

/**
 * The emission hit the output-token limit: a plain "re-send the JSON" retry
 * would be cut off at the same point, so this one asks for terser output.
 */
export const TRUNCATED_PLAN_REPAIR_INSTRUCTION =
  'Your previous response was cut off by the output length limit before the JSON finished. ' +
  `Re-send the COMPLETE plan as a single {"${PLAN_ENVELOPE_KEY}":[...]} JSON object — no prose, no code fences — ` +
  'and keep every task description and prompt brief so the whole object fits within the limit.';

/** A plan attempt was botched (invalid or truncated JSON): re-emit the whole plan. */
export function reEmitPlanPrompt(detail: string): string {
  return `Your plan JSON could not be committed: ${detail}. Re-emit the COMPLETE corrected plan as a single {"${PLAN_ENVELOPE_KEY}":[...]} JSON object — every task included, no prose, no code fences.`;
}

/** A plan emission was truncated mid-JSON; the caller may also have compacted the history to free input context. */
export function truncatedPlanReEmitPrompt(historyCompacted: boolean): string {
  return (historyCompacted
    ? 'Older raw research transcripts have been trimmed from this conversation to free space (subagent digests are intact). '
    : '') + TRUNCATED_PLAN_REPAIR_INSTRUCTION;
}

/** A task-ops attempt was botched (unparseable JSON): re-emit the ops object. */
export function reEmitTaskOpsPrompt(detail: string): string {
  return `Your task edits could not be applied: ${detail}. Re-emit ONLY a corrected {"${TASK_OPS_ENVELOPE_KEY}":[...]} JSON object — no prose, no code fences — or reply in prose if you did not intend to edit tasks.`;
}

/** A read attempt was botched (unparseable or unknown selector): re-emit the query object. */
export function reEmitTaskQueryPrompt(detail: string): string {
  return `Your task-detail request could not be read: ${detail}. Re-emit ONLY a corrected {"${TASK_QUERY_ENVELOPE_KEY}":{"tasks":["<id or #order>"],"fields"?:[...],"catalog"?:true}} JSON object — no prose, no code fences — or reply in prose if you did not mean to look anything up.`;
}

/** Task ops parsed but failed semantic validation (cycles, unknown refs, locked tasks). */
export function taskOpsRejectedPrompt(errors: string[]): string {
  return `Those task edits were rejected:\n- ${errors.join('\n- ')}\nRe-emit a corrected {"${TASK_OPS_ENVELOPE_KEY}":[...]} JSON object, or reply in prose if something is unclear.`;
}

/** A modified plan failed validation during execution: full re-prompt feedback block. */
export function modifyValidationFeedback(errors: string[]): string {
  return [
    '',
    '=== VALIDATION ERRORS FROM PREVIOUS ATTEMPT ===',
    'Your previous plan modification was rejected by validation. Fix these issues:',
    ...errors.map((e, i) => `${i + 1}. ${e}`),
    '',
    'Resubmit the corrected plan. Do NOT wrap in markdown code blocks.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Reply classification — what did the planner actually emit?
// ---------------------------------------------------------------------------

export type PlannerReplyClassification =
  | { kind: 'plan'; tasks: Task[] }
  | { kind: 'task_ops'; ops: TaskOp[] }
  /** A read: show me these tasks in full (and/or the whole catalog) before I edit anything. */
  | { kind: 'task_query'; query: TaskQuery }
  /** Clearly attempted a plan (tasks-keyed object, or JSON cut off mid-stream) and botched it — worth a corrective retry. */
  | { kind: 'broken_plan'; error: PlanParseError }
  /** Clearly attempted an ops object and botched it — worth a corrective retry. */
  | { kind: 'broken_task_ops'; error: PlanParseError }
  /** Clearly attempted a read and botched it — worth a corrective retry. */
  | { kind: 'broken_task_query'; error: PlanParseError }
  | { kind: 'prose' };

/**
 * Classify one planner reply. Task ops are checked before the plan key — an
 * ops object never carries a top-level tasks array, but a model may mention
 * the word in prose around it. "Broken" is deliberately narrower than "failed
 * to parse": prose that merely mentions the envelope key is left alone.
 */
export function classifyPlannerReply(
  text: string,
  opts: {
    runners: RunnerId[];
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
    autonomousDefault?: boolean;
  },
): PlannerReplyClassification {
  if (textHasTaskOps(text)) {
    try {
      return { kind: 'task_ops', ops: parseTaskOpsJson(text) };
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      // Repairable only when the reply carries a real ops object and no plan
      // to fall through to; otherwise it may still be a plan, else prose.
      if (
        !text.includes(`"${PLAN_ENVELOPE_KEY}"`) &&
        extractObjectsWithKey(text, TASK_OPS_ENVELOPE_KEY).matches.length > 0
      ) {
        return { kind: 'broken_task_ops', error: err };
      }
    }
  }

  // Reads are checked before the plan key because a query's own body carries a
  // "tasks" list — an unguarded plan check would read every query as a botched
  // plan and spend a repair correcting a reply that was never wrong.
  if (textHasTaskQuery(text)) {
    try {
      return { kind: 'task_query', query: parseTaskQueryJson(text) };
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      if (extractObjectsWithKey(text, TASK_QUERY_ENVELOPE_KEY).matches.length > 0) {
        return { kind: 'broken_task_query', error: err };
      }
    }
  }

  // A reply is a candidate plan whenever its content carries a tasks key —
  // models often emit a short preamble before the JSON.
  if (text.includes(`"${PLAN_ENVELOPE_KEY}"`)) {
    try {
      return { kind: 'plan', tasks: parsePlanJson(text, opts.runners, opts.runnerModes, opts.autonomousDefault) };
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      if (looksLikePlanAttempt(text)) return { kind: 'broken_plan', error: err };
    }
  }

  return { kind: 'prose' };
}

// ---------------------------------------------------------------------------
// Plan-stream adapter — one-shot generation with JSON repair.
// ---------------------------------------------------------------------------

/**
 * Generate a plan, retrying on unparseable JSON. `generate` is called with an
 * optional repair hint (undefined on the first attempt, {@link JSON_REPAIR_INSTRUCTION}
 * thereafter) and must return the model's raw text. Only {@link PlanParseError} is
 * retried; transport/other errors propagate immediately. The last parse error is
 * re-thrown if every attempt fails.
 */
export async function generatePlanWithRepair(
  generate: (repairHint?: string) => Promise<string>,
  runners: RunnerId[],
  maxAttempts = 2,
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): Promise<Task[]> {
  return repairLoop<string, Task[]>({
    first: () => generate(undefined),
    resend: (corrective) => generate(corrective),
    interpret: (text) => {
      try {
        return { done: parsePlanJson(text, runners, runnerModes, autonomousDefault) };
      } catch (err) {
        if (!(err instanceof PlanParseError)) throw err;
        // A shape rejection is not a parse failure: telling the model its JSON
        // "could not be parsed" spends the one retry on a problem that does not
        // exist, and it re-sends the same object. Name the rule instead — the
        // conversational path has always done this.
        const corrective = err.truncated
          ? TRUNCATED_PLAN_REPAIR_INSTRUCTION
          : err.semantic
            ? reEmitPlanPrompt(err.message)
            : JSON_REPAIR_INSTRUCTION;
        return { retry: { errors: [err.message], corrective, cause: err } };
      }
    },
    maxRepairs: maxAttempts - 1,
    onExhausted: ({ cause }) => {
      throw cause ?? new PlanParseError('Plan generation produced no parseable output', '');
    },
  });
}
