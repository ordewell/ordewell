import type { Task, TaskType } from './Task';

type Field = keyof Task | 'thinkingEffort';

interface KindRules {
  forbidden: readonly Field[];
  plannerEditForbidden: readonly Field[];
  leaving: readonly (keyof Task)[];
  entering: readonly (keyof Task)[];
  topLevelOnly: boolean;
  mayHaveSubtasks: boolean;
  runsInMode: boolean;
  hasRunner: boolean;
  mayBeOps: boolean;
  mayBeResearch: boolean;
}

const PLANNER_EDIT_FIELDS = ['readOnly', 'thinkingEffort'] as const;

const AI_ASSIGNMENT = ['assignedModel', 'taskMode', 'autonomy', 'ops'] as const;

// ADR-0035 and ADR-0055 D1: a script's body and a child's goal are not runner prompts.
export const TASK_KINDS = {
  ai: { forbidden: [], plannerEditForbidden: [], leaving: ['research'], entering: ['userSteps'], topLevelOnly: false, mayHaveSubtasks: true, runsInMode: true, hasRunner: true, mayBeOps: true, mayBeResearch: true },
  user: { forbidden: [], plannerEditForbidden: [], leaving: [], entering: AI_ASSIGNMENT, topLevelOnly: false, mayHaveSubtasks: true, runsInMode: false, hasRunner: false, mayBeOps: false, mayBeResearch: false },
  script: {
    forbidden: ['assignedRunner', 'assignedModel', 'thinkingEffort', 'taskMode', 'readOnly', 'prompt', 'skills', 'userSteps', 'ops', 'subtasks'],
    plannerEditForbidden: PLANNER_EDIT_FIELDS,
    leaving: ['commands', 'script', 'timeoutMs'], entering: [...AI_ASSIGNMENT, 'prompt', 'skills', 'userSteps'],
    topLevelOnly: true, mayHaveSubtasks: false, runsInMode: false, hasRunner: false, mayBeOps: false, mayBeResearch: false,
  },
  delegated: {
    forbidden: ['prompt', 'taskMode', 'skills', 'userSteps', 'ops', 'commands', 'script', 'timeoutMs', 'research'],
    plannerEditForbidden: PLANNER_EDIT_FIELDS,
    leaving: [], entering: [],
    topLevelOnly: true, mayHaveSubtasks: false, runsInMode: false, hasRunner: true, mayBeOps: false, mayBeResearch: false,
  },
} as const satisfies Record<TaskType, KindRules>;

export function forbiddenFields(kind: TaskType, boundary: 'task' | 'plannerEdit' = 'task'): readonly Field[] {
  return boundary === 'plannerEdit' ? TASK_KINDS[kind].plannerEditForbidden : TASK_KINDS[kind].forbidden;
}

/**
 * The forbidden fields a task or an edit holds, less those `ignored` (a
 * stored default, the read-only script exception). A `null` is a value it
 * holds, so it is refused as any other.
 */
export function presentForbiddenFields(kind: TaskType, fields: object, ignored: readonly Field[] = []): Field[] {
  return held(forbiddenFields(kind), fields, ignored, false);
}

/** The forbidden fields the planner's JSON wrote, where a `null` is how it leaves a field out. */
export function writtenForbiddenFields(kind: TaskType, raw: object, boundary: 'task' | 'plannerEdit' = 'task'): Field[] {
  return held(forbiddenFields(kind, boundary), raw, [], true);
}

function held(forbidden: readonly Field[], fields: object, ignored: readonly Field[], nullLeavesOut: boolean): Field[] {
  const raw = fields as Partial<Record<Field, unknown>>;
  return forbidden.filter((field) => {
    const value = raw[field];
    return !ignored.includes(field) && value !== undefined && !(nullLeavesOut && value === null) && value !== false
      && !(Array.isArray(value) && value.length === 0);
  });
}

/** Delegated tasks cannot flip: a child goal cannot become another kind of work (ADR-0055 D1). */
export function flipClears(from: TaskType, to: TaskType): (keyof Task)[] {
  if (from === to || from === 'delegated' || to === 'delegated') return [];
  return [...new Set<keyof Task>([...TASK_KINDS[from].leaving, ...TASK_KINDS[to].entering])];
}

/** Whether `value` names a kind: an edit's or a new task's `type` reaches core unchecked from the HTTP and MCP routes. */
export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && Object.hasOwn(TASK_KINDS, value);
}

/** Why a `type` that names no kind is refused, after the task it was written for. */
export function unknownTypeRefusal(value: unknown): string {
  const kinds = taskKinds(false).map((kind) => `"${kind}"`);
  return `has "type" ${JSON.stringify(value)}, which is no kind of task: use ${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}`;
}

/** Delegation changes the planner's vocabulary only when the session grants it (ADR-0055 D1). */
export function taskKinds(delegates: boolean): [TaskType, ...TaskType[]] {
  return (Object.keys(TASK_KINDS) as TaskType[]).filter((kind) => delegates || kind !== 'delegated') as [TaskType, ...TaskType[]];
}
