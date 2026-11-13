import { z } from 'zod/v4';
import { taskKinds, unknownTypeRefusal } from '../models/TaskKind';

/**
 * A task as the planner writes it, by any route: the fields `submit_plan`
 * takes, an `edit_plan` op's or a text reply's `changes`, `task`, `merged` and
 * `parts`. One table holds each field's shape, so the tools' schemas, the text
 * route's parse and the intake ({@link readSpec}) cannot disagree about what a
 * field holds (ADR-0022 P2). What a field means, and which writer may set it,
 * stays with the rules that judge it: this table judges only the shape.
 */

/** A task reference, as every tool and op takes one. */
export const taskRef = z.union([z.string().min(1), z.number().int().min(0)]).describe('A task id, "#order" ("#2.1" for a subtask), a bare order, or a title.');

interface TaskField {
  schema: z.ZodType;
  /** Where the planner may delegate, if the field reads otherwise there (ADR-0055 D1). */
  delegating?: z.ZodType;
  /** Only a task being made has it: an edit's copy is never read. */
  newOnly?: true;
  /** Only where the planner may delegate is the field listed at all. */
  delegatedOnly?: true;
  /**
   * What a value must be, for {@link readSpec}'s refusal. Absent where a rule
   * of its own judges the shape with a message of its own: a script's body
   * (`scriptBodyErrors`), a loop (`loopSpec`), a delegated task's fields
   * (`delegationErrors`).
   */
  must?: string;
}

const ref = z.union([z.string(), z.number()]);
const slice = z.enum(['AFK', 'HITL']);
const names = z.array(z.string());
const REFS = 'a list of task refs, as ["<id or #order>"]';

const modelAssignment = z.looseObject({
  modelId: z.string(),
  modelLabel: z.string().optional(),
  thinkingEffort: z.string().optional().describe("A variant id from that model's variants list."),
});

/** Every field, in the order `submit_plan` lists them. */
const TASK_FIELDS: Record<string, TaskField> = {
  id: { schema: ref, newOnly: true, must: 'text or a number' },
  order: { schema: z.number(), newOnly: true, must: 'a number' },
  title: { schema: z.string(), must: 'text' },
  description: { schema: z.string(), must: 'text' },
  type: { schema: z.enum(taskKinds(false)), delegating: z.enum(taskKinds(true)), must: 'a kind of task' },
  dependencies: { schema: z.array(ref), must: REFS },
  prompt: { schema: z.string(), must: 'text' },
  userSteps: { schema: z.array(z.looseObject({ order: z.number().optional(), instruction: z.string() })), must: 'a list of steps, as [{"instruction": "..."}]' },
  assignedRunner: { schema: z.string(), must: 'a runner id' },
  assignedModel: { schema: modelAssignment, must: 'a model, as {"modelId": "...", "modelLabel": "..."}' },
  readOnly: { schema: z.boolean().describe('True for a task that must not change any file. Ordewell picks every mode; there is no taskMode.'), must: 'true or false' },
  // Null as well as left out, on a new task too: a model with no variants has none to name.
  thinkingEffort: { schema: z.string().nullable(), must: 'a variant id of the assigned model, or null' },
  autonomy: { schema: slice, must: '"AFK" or "HITL"' },
  sliceType: { schema: slice, must: '"AFK" or "HITL"' },
  // Read as any value by design, so judged by no shape: anything but a literal true is a change task (`opsFlag`).
  ops: { schema: z.boolean() },
  userStoriesCovered: { schema: names, newOnly: true, must: 'a list of story names' },
  skills: { schema: names.describe('Task skills (applies-to: task) by name; their bodies go in the runner\'s prompt. A subtask lists its own.') },
  subtasks: { schema: z.array(z.record(z.string(), z.unknown())), newOnly: true, must: 'a list of tasks' },
  // ADR-0035.
  commands: { schema: z.array(z.array(z.string())).describe('A script task\'s argument vectors, run in order with no shell, stopping at the first that fails. Exactly one of commands or script.') },
  script: { schema: z.string().describe('A script task\'s script, run by the research shell. Exactly one of commands or script.') },
  timeoutMs: { schema: z.number().describe('A script task\'s time limit in milliseconds; ten minutes when left out.') },
  research: { schema: z.boolean().describe('A top-level read-only AI task whose report wakes the planner (ADR-0037 R1). Never in a loop body.'), must: 'true or false' },
  // ADR-0045.
  loop: {
    schema: z.looseObject({
      body: z.array(ref).describe('The ids of the top-level tasks that fix what this check finds; each depends on this task.'),
      maxRounds: z.number().optional().describe('The most times this check runs, 1 to 10; 3 when left out.'),
    }).describe('Makes this task a loop\'s check: while it fails with rounds left, Ordewell runs the body with its report, then runs it again.'),
  },
  // ADR-0055 D1, judged by `delegationErrors` once the task lands.
  goal: { schema: z.string().describe('A delegated task\'s goal: what its child plan must achieve, in place of a prompt.'), delegatedOnly: true },
  budget: {
    schema: z.looseObject({ tokens: z.number(), wallClockMs: z.number().optional() })
      .describe('A delegated task\'s budget, required: tokens, and a time limit in milliseconds if it has one. Carved from what this plan has left.'),
    delegatedOnly: true,
  },
  protectedPaths: {
    schema: names.describe('The paths a delegated task\'s child may not change: what its check runs and the configuration that runs it. Relative to the repository; `*` is the one wildcard. Required unless it is readOnly.'),
    delegatedOnly: true,
  },
  grants: { schema: names.describe('What a delegated task asks for past the floor, by name: research, delegate or effect.'), delegatedOnly: true },
  scope: {
    schema: z.looseObject({ paths: names.optional(), provides: names.optional(), consumes: names.optional() }).describe('What a delegated task declares it works on. Advisory.'),
    delegatedOnly: true,
  },
};

/** The fields a task's spec documents: what the prompts may name, and nothing else. */
export const TASK_SPEC_FIELDS: readonly string[] = Object.keys(TASK_FIELDS);

/** Whether a task being made (`new`) or an edit's `changes` (`patch`) is read. */
export type SpecKind = 'new' | 'patch';

function fieldSchema(field: TaskField, delegates: boolean, nullable = false): z.ZodType {
  const schema = (delegates && field.delegating) || field.schema;
  return nullable ? schema.nullable() : schema;
}

/**
 * A task as `submit_plan` lists and takes it: a title, and every other field
 * optional. Loose, as a field it does not list is the intake's to refuse or
 * ignore (a `taskMode`, say), by the message that says why.
 */
export function taskSpecSchema({ delegates = false }: { delegates?: boolean } = {}) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(TASK_FIELDS)) {
    if (!delegates && field.delegatedOnly) continue;
    const schema = fieldSchema(field, delegates);
    shape[name] = name === 'title' ? schema : schema.optional();
  }
  return z.looseObject(shape);
}

/**
 * What the table judges of one task's fields: those with a `must`, any kind
 * of task taken for `type`, the rest left to the rule that reads them, so its
 * message is the one the planner gets. A patch takes `null` in every field:
 * what a null means on that task (a script's `prompt` nulled is still a prompt
 * written) is the edit's rules to say. It refuses what {@link readSpec} does.
 */
function judgedSpec(kind: SpecKind) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(TASK_FIELDS)) {
    if (field.must && !(kind === 'patch' && field.newOnly)) shape[name] = fieldSchema(field, true, kind === 'patch').optional();
  }
  return z.record(z.string(), z.unknown()).pipe(z.looseObject(shape));
}

/**
 * One op of an `edit_plan` call or a `taskOps` reply, its tasks' fields
 * judged by the table. Each is listed to the planner as an object of task
 * fields: they are `submit_plan`'s, in the same list, and spelling them out
 * four times again would cost every planner turn. One schema serves every
 * planner, delegating or not: which kinds a planner may make is the intake's.
 */
export function taskOpSchema() {
  const patch = judgedSpec('patch');
  const made = judgedSpec('new');
  const handle = z.string().optional();
  return z.discriminatedUnion('op', [
    z.object({ op: z.literal('update'), taskId: taskRef, changes: patch }),
    z.object({ op: z.literal('add'), task: made, handle }),
    z.object({ op: z.literal('remove'), taskId: taskRef }),
    z.object({ op: z.literal('reorder'), taskIds: z.array(taskRef) }),
    z.object({ op: z.literal('merge'), taskIds: z.array(taskRef), merged: made, handle }),
    z.object({ op: z.literal('split'), taskId: taskRef, parts: z.array(made), handle }),
    z.object({ op: z.literal('rearm'), taskId: taskRef, changes: patch.optional() }),
  ]);
}

/** A value as a refusal quotes it, cut short so one long field does not drown the message. */
function shown(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

/** One field the spec holds in a shape the table refuses, and why, completing a sentence after the task's name. */
export interface SpecError {
  field: string;
  message: string;
}

/**
 * The fields of `raw` whose shape the table refuses, never coerced to
 * something else: a string where a list belongs once read as no list, and
 * cleared what it named. Each message completes a sentence after the task's
 * name. What another rule judges, and a field the table does not list, is
 * left to that rule; `type` takes every kind, delegated too, so the intake's
 * refusal of a delegated task where none may be is the one that says why; a
 * patch's `null` is the edit's rules' to read, as {@link taskOpSchema}'s is.
 */
export function readSpec(raw: unknown, kind: SpecKind): SpecError[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ field: kind === 'patch' ? 'changes' : 'task', message: `is ${shown(raw)}, which must be an object of task fields` }];
  }
  const errors: SpecError[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const field = Object.hasOwn(TASK_FIELDS, name) ? TASK_FIELDS[name] : undefined;
    if (!field?.must || (kind === 'patch' && field.newOnly) || value === undefined) continue;
    if (fieldSchema(field, true, kind === 'patch').safeParse(value).success) continue;
    errors.push({ field: name, message: name === 'type' ? unknownTypeRefusal(value) : `has "${name}" ${shown(value)}, which must be ${field.must}` });
  }
  return errors;
}

/**
 * Why an op cannot be read, naming the op and the slot, or null when it can:
 * the text route's reading of what `edit_plan`'s schema refuses, so a reply
 * the planner can fix is asked again rather than thrown.
 */
export function opShapeRefusal(op: unknown, index: number): string | null {
  const parsed = taskOpSchema().safeParse(op);
  if (parsed.success) return null;
  const kind = typeof op === 'object' && op !== null && typeof (op as { op?: unknown }).op === 'string' ? (op as { op: string }).op : undefined;
  const label = `op ${index + 1}${kind ? ` (${kind})` : ''}`;
  if (!kind || !['update', 'add', 'remove', 'reorder', 'merge', 'split', 'rearm'].includes(kind)) {
    return `${label} needs an "op" field: update | add | remove | reorder | merge | split | rearm`;
  }
  const issue = parsed.error.issues[0];
  const path = issue.path.map(String);
  const name = path.find((p) => Object.hasOwn(TASK_FIELDS, p));
  const slot = path.join('.');
  const value = path.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined), op);
  const must = name && path.at(-1) === name ? TASK_FIELDS[name].must : undefined;
  if (must && name === 'type') return `${label}: "${slot}" ${unknownTypeRefusal(value).replace(/^has "type" /, 'is ')}`;
  if (must) return `${label}: "${slot}" is ${shown(value)}, which must be ${must}`;
  return `${label}: "${slot}" is ${value === undefined ? 'missing' : shown(value)}: ${issue.message}`;
}
