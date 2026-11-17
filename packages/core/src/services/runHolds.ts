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
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependencies) dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
  }
  const open = new Set(tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped').map((t) => t.id));
  const holdsBack = (id: string): number => {
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
  const holds: RunHold[] = [];
  for (const task of tasks) {
    if (task.status === 'awaiting_user') {
      if (task.awaitingReason === 'usage-limit') continue;
      holds.push({ taskId: task.id, hold: { kind: 'waiting', ...(task.awaitingReason ? { reason: task.awaitingReason } : {}) }, holdsBack: holdsBack(task.id) });
      continue;
    }
    const onHold = (waits.get(task.id) ?? []).find((w): w is Extract<StartWait, { kind: 'on-hold' }> => w.kind === 'on-hold');
    if (onHold) holds.push({ taskId: task.id, hold: { kind: 'on-hold', ...(onHold.reason ? { reason: onHold.reason } : {}) }, holdsBack: holdsBack(task.id) });
  }
  return holds;
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
