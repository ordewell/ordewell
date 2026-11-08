import type { Task } from './Task';

/*
 * Which of a task's fields are the plan's and which are its execution state,
 * and what a fresh attempt clears, stated once. A planner's rewrite keeps the
 * execution state it never witnessed (`keepExecutionState`); a retry and a
 * rearm clear the same attempt either way, but where they differ, below.
 *
 * - `plan`: what the plan says to run. The planner writes it.
 * - `execution`: the task's record of having run, which outlives an attempt:
 *   a fresh attempt keeps it, and only a runner, the session or the user
 *   changes it.
 * - `attempt`: the latest attempt's outcome, or what it waits on. Execution
 *   state too, cleared by a fresh attempt.
 */
export type TaskFieldKind = 'plan' | 'execution' | 'attempt';

/** Every key of `Task`, classified: a field added to `Task` without a kind here fails typecheck. */
export const TASK_FIELDS = {
  id: 'plan',
  order: 'plan',
  title: 'plan',
  description: 'plan',
  type: 'plan',
  status: 'attempt',
  dependencies: 'plan',
  prompt: 'plan',
  userSteps: 'plan',
  subtasks: 'plan',
  verdict: 'attempt',
  outputSummary: 'attempt',
  handoff: 'attempt',
  assignedModel: 'plan',
  assignedRunner: 'plan',
  taskMode: 'plan',
  autonomy: 'plan',
  sliceType: 'plan',
  userStoriesCovered: 'plan',
  // Cleared when an attempt spawns fresh, not when one is asked for: until then Continue may still offer it.
  runnerSessionId: 'execution',
  runnerSessionOwner: 'execution',
  awaitingReason: 'attempt',
  parkedQuestion: 'attempt',
  // Moved by status changes and cleared at an attempt's start (ADR-0053), so a fresh attempt asked for leaves it.
  waitsEnded: 'execution',
  resumeAt: 'attempt',
  carriedFrom: 'attempt',
  skipReason: 'attempt',
  reverted: 'attempt',
  // A plan field, but where a failed task ran is fixed once it has run (ADR-0020): see `keepExecutionState`.
  ops: 'plan',
  research: 'plan',
  // A retry still owes research's report under its original authority (ADR-0037 R3).
  researchOrigin: 'execution',
  forcedPastGate: 'attempt',
  skills: 'plan',
  attemptSkills: 'execution',
  // Set by the session, never by an op (ADR-0029): the planner cannot write it.
  addedBy: 'execution',
  attempted: 'execution',
  attemptUsage: 'execution',
  commands: 'plan',
  script: 'plan',
  timeoutMs: 'plan',
  goal: 'plan',
  budget: 'plan',
  grants: 'plan',
  protectedPaths: 'plan',
  scope: 'plan',
  readOnly: 'plan',
  loop: 'plan',
  loopRound: 'attempt',
  reportTo: 'execution',
} as const satisfies Record<keyof Task, TaskFieldKind>;

type FieldsOf<K extends TaskFieldKind> = { [F in keyof typeof TASK_FIELDS]: (typeof TASK_FIELDS)[F] extends K ? F : never }[keyof typeof TASK_FIELDS];

export type ExecutionField = FieldsOf<'execution' | 'attempt'>;
export type AttemptField = FieldsOf<'attempt'>;

const fieldsOf = <F extends keyof Task>(kinds: readonly TaskFieldKind[]): readonly F[] =>
  (Object.keys(TASK_FIELDS) as (keyof typeof TASK_FIELDS)[]).filter((f) => kinds.includes(TASK_FIELDS[f])) as F[];

/** Every field that is execution state: what a planner's rewrite of the task never changes. */
export const EXECUTION_FIELDS: readonly ExecutionField[] = fieldsOf<ExecutionField>(['execution', 'attempt']);

/** What a fresh attempt clears; `status` is set to pending instead. */
export const ATTEMPT_FIELDS: readonly AttemptField[] = fieldsOf<AttemptField>(['attempt']);

export interface FreshAttemptOptions {
  /**
   * A resume after a usage limit goes on with the attempt the limit cut
   * short, so a loop's check stays in its round; any other fresh attempt
   * starts the rounds over (ADR-0045 L7).
   */
  sameRound?: boolean;
  /**
   * The planner's `rearm`, a plan edit rather than a start. It keeps
   * `reverted`: a revert's hold is the user's to release, by a retry or a
   * force start (ADR-0054), and the saved mark is what keeps that hold past a
   * restart, so clearing it here would let the planner's edit lift the hold at
   * the next load.
   */
  rearm?: boolean;
}

/**
 * The changes that make a task a fresh attempt, from nothing it earned:
 * pending, with every attempt field cleared (`undefined`), and its record of
 * having run kept. Spread over the task, or written into it.
 */
export function freshAttempt(opts: FreshAttemptOptions = {}): Partial<Task> {
  const changes: Partial<Record<keyof Task, unknown>> = {};
  for (const field of ATTEMPT_FIELDS) {
    if (field === 'loopRound' && opts.sameRound) continue;
    if (field === 'reverted' && opts.rearm) continue;
    changes[field] = undefined;
  }
  changes.status = 'pending';
  return changes as Partial<Task>;
}

/** The task's execution state, every field named whether it holds a value or not, to lay over a rewrite of it. */
export function executionStateOf(task: Readonly<Task> | undefined): Partial<Task> {
  const state: Partial<Record<keyof Task, unknown>> = {};
  for (const field of EXECUTION_FIELDS) state[field] = task?.[field];
  return state as Partial<Task>;
}
