import { z } from 'zod/v4';
import { TASK_QUERY_TASK_FIELDS, OUTPUT_LINES_MAX } from '../TaskQuery';

/**
 * The tools of the Ordewell MCP server, per token role (ADR-0022), and the
 * handler interfaces the session side implements to answer them.
 *
 * Every handler method is optional so each tool can be wired on its own; one
 * left unset answers its call with a "not available" error rather than
 * disappearing from `tools/list`, so the list a runner sees never depends on
 * how far the wiring has got.
 */

const taskCompleteInput = z.object({
  status: z.enum(['done', 'blocked', 'failed'])
    .describe("'done' only when the task is fully complete. 'blocked' or 'failed' end the attempt without passing."),
  summary: z.string().describe('What was done, handed to the tasks that depend on this one.'),
  reason: z.string().optional().describe("Why the task is blocked or failed. Expected for anything but 'done'."),
});

const checkpointInput = z.object({
  question: z.string().min(1).describe('The question for the user. The call returns their answer.'),
});

const listRunnersInput = z.object({});

const listModelsInput = z.object({
  runner: z.string().min(1).describe('A runner id from list_runners.'),
});

const loadSkillInput = z.object({
  name: z.string().min(1).describe('The name of an Ordewell planner skill to load.'),
});

const taskRef = z.union([z.string().min(1), z.number().int().min(0)]).describe('A task id, "#order", a bare order, or a title.');

const modelAssignment = z.looseObject({
  modelId: z.string(),
  modelLabel: z.string().optional(),
  thinkingEffort: z.string().optional().describe("A variant id from that model's variants list."),
});

// Loose on purpose: the plan goes through the same validation and repair as the
// plan envelope (ADR-0022, P2), and a schema stricter than that path would
// make the two routes disagree about the same tasks.
const planTask = z.looseObject({
  id: z.string().optional(),
  order: z.number().optional(),
  title: z.string(),
  description: z.string().optional(),
  type: z.enum(['ai', 'user']).optional(),
  dependencies: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  userSteps: z.array(z.looseObject({ order: z.number().optional(), instruction: z.string() })).optional(),
  assignedRunner: z.string().optional(),
  assignedModel: modelAssignment.optional(),
  taskMode: z.string().optional(),
  autonomy: z.enum(['AFK', 'HITL']).optional(),
  sliceType: z.enum(['AFK', 'HITL']).optional(),
  ops: z.boolean().optional(),
  userStoriesCovered: z.array(z.string()).optional(),
  subtasks: z.array(z.record(z.string(), z.unknown())).optional(),
});

const submitPlanInput = z.object({
  tasks: z.array(planTask).min(1).describe('The whole plan, in order.'),
});

const taskFields = z.record(z.string(), z.unknown());
const handle = z.string().optional();

const taskOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), taskId: taskRef, changes: taskFields }),
  z.object({ op: z.literal('add'), task: taskFields, handle }),
  z.object({ op: z.literal('remove'), taskId: taskRef }),
  z.object({ op: z.literal('reorder'), taskIds: z.array(taskRef) }),
  z.object({ op: z.literal('merge'), taskIds: z.array(taskRef), merged: taskFields, handle }),
  z.object({ op: z.literal('split'), taskId: taskRef, parts: z.array(taskFields), handle }),
  z.object({ op: z.literal('rearm'), taskId: taskRef, changes: taskFields.optional() }),
]);

const editPlanInput = z.object({
  ops: z.array(taskOp).min(1).describe('Applied as one batch; every ref resolves against the plan before any op runs.'),
});

const taskQueryInput = z.object({
  tasks: z.array(taskRef).optional(),
  fields: z.array(z.enum(TASK_QUERY_TASK_FIELDS)).optional().describe('Omit to read every field. A task\'s output is read with task_output.'),
  catalog: z.boolean().optional().describe('Also return every runner with its models, thinking-effort variants and modes.'),
}).refine((q) => (q.tasks?.length ?? 0) > 0 || q.catalog === true, { message: 'Name at least one task, or set catalog: true.' });

const taskOutputInput = z.object({
  task: taskRef,
  lines: z.number().int().min(1).optional().describe(`How many lines to return; the default is 80 and anything over ${OUTPUT_LINES_MAX} is cut to ${OUTPUT_LINES_MAX}.`),
  since: z.number().int().min(0).optional().describe("A previous answer's nextOffset: return only what came after it."),
});

export type TaskCompleteArgs = z.infer<typeof taskCompleteInput>;
export type CheckpointArgs = z.infer<typeof checkpointInput>;
export type ListRunnersArgs = z.infer<typeof listRunnersInput>;
export type ListModelsArgs = z.infer<typeof listModelsInput>;
export type LoadSkillArgs = z.infer<typeof loadSkillInput>;
export type SubmitPlanArgs = z.infer<typeof submitPlanInput>;
export type EditPlanArgs = z.infer<typeof editPlanInput>;
export type TaskQueryArgs = z.infer<typeof taskQueryInput>;
export type TaskOutputArgs = z.infer<typeof taskOutputInput>;

/** What a handler answers with. `isError` marks a refusal the caller should act on. */
export interface McpToolReply {
  text: string;
  isError?: boolean;
}

/**
 * How a checkpoint call ended. `withdrawn` is the attempt going away under it
 * (verdict, cancel, retry, stop) or the call being refused, not a verdict on
 * the question.
 */
export type CheckpointAnswer =
  | { kind: 'continue' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'withdrawn'; why: string };

/** The checkpoint call's result: the answer as the runner reads it (ADR-0022, V5). */
export function checkpointReply(answer: CheckpointAnswer): McpToolReply {
  switch (answer.kind) {
    case 'continue': return { text: 'continue' };
    case 'rejected': return { text: `rejected: ${answer.reason}` };
    case 'withdrawn': return { text: `The checkpoint was withdrawn: ${answer.why}`, isError: true };
  }
}

export interface McpToolContext {
  /** Aborts when the token is revoked or the caller cancels — a waiting handler must stop. */
  signal: AbortSignal;
}

type Run<A> = (args: A, context: McpToolContext) => Promise<McpToolReply>;

export interface TaskToolHandler {
  taskComplete?: Run<TaskCompleteArgs>;
  checkpoint?: Run<CheckpointArgs>;
}

export interface PlannerToolHandler {
  loadSkill?: Run<LoadSkillArgs>;
  listRunners?: Run<ListRunnersArgs>;
  listModels?: Run<ListModelsArgs>;
  submitPlan?: Run<SubmitPlanArgs>;
  editPlan?: Run<EditPlanArgs>;
  taskQuery?: Run<TaskQueryArgs>;
  taskOutput?: Run<TaskOutputArgs>;
}

export interface McpTool<H> {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations?: { readOnlyHint: boolean };
  /** Validate `args` and hand them to the handler's method for this tool. */
  call(handler: H, args: unknown, context: McpToolContext): Promise<McpToolReply>;
}

function tool<H, S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  pick: (handler: H) => Run<z.infer<S>> | undefined,
  annotations?: McpTool<H>['annotations'],
): McpTool<H> {
  return {
    name,
    description,
    inputSchema: { ...z.toJSONSchema(input, { io: 'input' }), type: 'object' },
    ...(annotations ? { annotations } : {}),
    async call(handler, args, context) {
      const run = pick(handler);
      if (!run) return { text: `${name} is not available in this session.`, isError: true };
      const parsed = input.safeParse(args ?? {});
      if (!parsed.success) return { text: `Invalid ${name} arguments: ${z.prettifyError(parsed.error)}`, isError: true };
      return run(parsed.data, context);
    },
  };
}

/** The task tool whose call settles the attempt (ADR-0022, V1). */
export const TASK_COMPLETE_TOOL = 'task_complete';

export const TASK_TOOLS: readonly McpTool<TaskToolHandler>[] = [
  tool(TASK_COMPLETE_TOOL, 'Report that this task has ended, and how. Call it once, as your last action.',
    taskCompleteInput, (h) => h.taskComplete?.bind(h)),
  tool('checkpoint', "Ask the user a question and wait for the answer, which is this call's result.",
    checkpointInput, (h) => h.checkpoint?.bind(h)),
];

/**
 * Claude Code's plan mode refuses an MCP tool that does not declare itself
 * read-only, pre-allowed or not, and the harness planner runs in plan mode.
 * True of the workspace for every planner tool: `submit_plan` and `edit_plan`
 * write only Ordewell's plan, through the same validation as the envelopes
 * (ADR-0022, P1/P2).
 */
const PLANNER_READ_ONLY = { readOnlyHint: true };

export const PLANNER_TOOLS: readonly McpTool<PlannerToolHandler>[] = [
  tool('list_runners', 'List the runners enabled right now, each with its modes and default mode. Call it just before submit_plan.',
    listRunnersInput, (h) => h.listRunners?.bind(h), PLANNER_READ_ONLY),
  tool('list_models', 'List the models a runner may use right now, with labels and thinking-effort variants.',
    listModelsInput, (h) => h.listModels?.bind(h), PLANNER_READ_ONLY),
  tool('submit_plan', 'Submit the whole plan. It is checked against the live runners and models; an error names the task, the field and what would be accepted.',
    submitPlanInput, (h) => h.submitPlan?.bind(h), PLANNER_READ_ONLY),
  tool('edit_plan', 'Change the current plan with task operations: update, add, remove, reorder, merge, split or rearm.',
    editPlanInput, (h) => h.editPlan?.bind(h), PLANNER_READ_ONLY),
  tool('task_query', 'Read the long fields of plan tasks that the plan summary leaves out (prompt, user steps, verdict, output summary), and optionally the live runner catalog. Read a task before you rewrite it.',
    taskQueryInput, (h) => h.taskQuery?.bind(h), PLANNER_READ_ONLY),
  tool('task_output', "Read the recent output of a running task, to check what its runner is doing; paged by offset. A task that is not running answers with its verdict, output summary and a digest of its last attempt.",
    taskOutputInput, (h) => h.taskOutput?.bind(h), PLANNER_READ_ONLY),
  tool('load_skill', 'Load an Ordewell planner skill by name. Returns its instructions; only model-invocable planner skills can be loaded.',
    loadSkillInput, (h) => h.loadSkill?.bind(h), PLANNER_READ_ONLY),
];
