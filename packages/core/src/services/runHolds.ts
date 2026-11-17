import { flattenTasks, type AwaitingReason, type ConversationMessage, type Task } from '../models/Task';
import type { ExecutionCommandName, ExecutionRecord } from '../models/Execution';
import type { StartWait } from './readiness';

/**
 * A task that holds a run idle (ADR-0057 R4): pulled out of the scheduler, or
 * waiting on a person, with nothing running and nothing able to start.
 */
export interface RunHold {
  taskId: string;
  /** On hold with why, or waiting on a person for what. */
  hold: { kind: 'on-hold'; reason?: string } | { kind: 'waiting'; reason?: AwaitingReason };
  /** The tasks not yet done that need it, however far down. */
  holdsBack: number;
}

/**
 * What holds the plan's remaining tasks back from a person: each task on hold
 * and each waiting on a person, in plan order. A task paused on its runner's
 * usage limit is not one: the reset resumes it with nobody asked.
 */
export function runHolds(plan: readonly Task[], waits: ReadonlyMap<string, readonly StartWait[]>): RunHold[] {
  const tasks = flattenTasks([...plan]);
  const holdsBack = holdsBackIn(tasks);
  return tasks.flatMap((task) => {
    const hold = holdOf(task, waits);
    return hold ? [{ taskId: task.id, hold, holdsBack: holdsBack(task.id) }] : [];
  });
}

/** A task's hold, if it has one: on hold, or waiting on a person for anything but a usage limit's reset. */
function holdOf(task: Readonly<Task>, waits: ReadonlyMap<string, readonly StartWait[]>): RunHold['hold'] | undefined {
  if (task.status === 'awaiting_user') {
    return task.awaitingReason === 'usage-limit' ? undefined : { kind: 'waiting', ...(task.awaitingReason ? { reason: task.awaitingReason } : {}) };
  }
  const onHold = (waits.get(task.id) ?? []).find((w): w is Extract<StartWait, { kind: 'on-hold' }> => w.kind === 'on-hold');
  return onHold ? { kind: 'on-hold', ...(onHold.reason ? { reason: onHold.reason } : {}) } : undefined;
}

/** How many tasks not yet done need each task, however far down. */
function holdsBackIn(tasks: readonly Task[]): (id: string) => number {
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependencies) dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
  }
  const open = new Set(tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped').map((t) => t.id));
  return (id) => {
    const seen = new Set<string>();
    const walk = (from: string) => {
      for (const next of dependents.get(from) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        walk(next);
      }
    };
    walk(id);
    return [...seen].filter((t) => open.has(t)).length;
  };
}

/** A task that stops what needs it until someone releases it: failed, or held as {@link RunHold} says. */
export interface StandingBlock {
  taskId: string;
  block: { kind: 'failed' } | RunHold['hold'];
  /** The tasks not yet done that need it, however far down. */
  holdsBack: number;
}

/** Whether a task is failed or held now, and what it holds back; undefined when it is neither. */
export function standingBlock(plan: readonly Task[], waits: ReadonlyMap<string, readonly StartWait[]>, taskId: string): StandingBlock | undefined {
  const tasks = flattenTasks([...plan]);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return undefined;
  const block = task.status === 'failed' ? { kind: 'failed' as const } : holdOf(task, waits);
  return block ? { taskId, block, holdsBack: holdsBackIn(tasks)(taskId) } : undefined;
}

/** One key per failure or hold of a task: the same task, standing the same way. */
export function standingKey({ taskId, block }: StandingBlock): string {
  return `${taskId}:${block.kind}:${block.kind === 'failed' ? '' : block.reason ?? ''}`;
}

/** How a standing task stands, in words: "failed", "on hold (why)", "waiting for input". */
export function standingWords(block: StandingBlock['block']): string {
  if (block.kind === 'failed') return 'failed';
  if (block.kind === 'on-hold') return `on hold${block.reason ? ` (${block.reason})` : ''}`;
  return WAITING_WORDS[block.reason ?? 'input'];
}

/**
 * The supervisor's line for a task its wake-up turn left failed or held with
 * work waiting on it (ADR-0057 R4): what still stands, what waits, and the
 * calls that release it.
 */
export function standingDetail({ taskId, block, holdsBack }: StandingBlock, describe: (taskId: string) => string): string {
  const waiting = `${holdsBack} ${holdsBack === 1 ? 'task waits' : 'tasks wait'} on it`;
  const release = block.kind === 'waiting' && block.reason === 'checkpoint'
    ? 'answer it with answer_checkpoint'
    : block.kind === 'waiting'
      ? 'message_task its runner with what to do next, or call retry_task from "fresh" with a message, your note on what to do differently'
      : 'call retry_task from "fresh" with a message, your note on what to do differently, or edit it with edit_plan and call retry_task in the same reply';
  return `Task ${describe(taskId)} is still ${standingWords(block)} after your turn, and ${waiting}. Release it: ${release}; or skip_task it with your reason; or tell the user.`;
}

/** One key per distinct set of holds: the same tasks, held the same way. */
export function runHoldsKey(holds: readonly RunHold[]): string {
  return holds.map((h) => `${h.taskId}:${h.hold.kind}:${h.hold.reason ?? ''}`).sort().join('\n');
}

/** The commands that leave a task on hold, as an execution record names them. */
const HOLDING_COMMANDS: ReadonlySet<ExecutionCommandName> = new Set<ExecutionCommandName>(['stop_task', 'revert_task', 'mark_not_done']);

const ACTOR_NAMES: Record<ExecutionRecord['actor'], string> = {
  user: 'the user',
  'planner-turn': 'the planner in the user\'s turn',
  supervisor: 'the supervisor',
  autorun: 'autorun',
  subplanner: 'the subplanner',
};

/** Who last put a task on hold, by the plan's record of calls; Ordewell when no call did (a start that could not reach its runner). */
export function heldBy(history: readonly ConversationMessage[] | undefined, taskId: string): string {
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    const record = history![i].execution;
    if (record?.outcome === 'done' && record.task?.id === taskId && HOLDING_COMMANDS.has(record.command)) return ACTOR_NAMES[record.actor];
  }
  return 'Ordewell';
}

const WAITING_WORDS: Record<AwaitingReason, string> = {
  input: 'waiting for input',
  checkpoint: 'waiting at a checkpoint',
  'question-lost': 'waiting for input',
  conflict: 'waiting on its conflict, which could not land',
  'landing-failed': 'waiting on a landing git refused',
  'files-changed': 'waiting on the user, having changed tracked files in their checkout',
  'usage-limit': 'waiting on its runner\'s usage limit',
};

/**
 * The supervisor's line for a run idle behind its holds (ADR-0057 R4): one
 * sentence a hold, saying what holds it, who put it on hold, and how many
 * tasks it holds back.
 */
export function runHeldDetail(holds: readonly RunHold[], describe: (taskId: string) => string, by: (taskId: string) => string): string {
  const sentences = holds.map(({ taskId, hold, holdsBack }) => {
    const back = holdsBack === 0 ? 'holds back no other task' : `holds back ${holdsBack} ${holdsBack === 1 ? 'task' : 'tasks'}`;
    const what = hold.kind === 'on-hold'
      ? `is on hold${hold.reason ? ` (${hold.reason})` : ''}, put there by ${by(taskId)},`
      : `is ${WAITING_WORDS[hold.reason ?? 'input']},`;
    return `Task ${describe(taskId)} ${what} and ${back}.`;
  });
  const release = holds.some((h) => h.hold.kind === 'on-hold') ? ' A task on hold starts again only once it is retried or force started, or skipped, which releases what needs it.' : '';
  return `the run is idle: nothing is running and nothing can start. ${sentences.join(' ')}${release}`;
}
