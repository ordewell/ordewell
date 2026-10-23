import { z } from 'zod/v4';
import { TASK_QUERY_TASK_FIELDS, OUTPUT_LINES_MAX } from '../TaskQuery';
import { TASK_LOG_KINDS } from '../taskLogRead';
import type { ToolOutcome } from '../../interfaces/IFileSystem';
import { HANDOFF_LIMITS } from '../../models/Handoff';

/**
 * The tools of the Ordewell MCP server, per token role (ADR-0022), and the
 * handler interfaces the session side implements to answer them.
 *
 * Every handler method is optional so each tool can be wired on its own; one
 * left unset answers its call with a "not available" error rather than
 * disappearing from `tools/list`, so the list a runner sees never depends on
 * how far the wiring has got.
 */

const handoffReference = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    path: z.string().min(1).max(HANDOFF_LIMITS.reference).describe('A path in the repository.'),
    line: z.number().int().min(1).optional(),
  }),
  z.object({
    kind: z.literal('commit'),
    sha: z.string().regex(/^[0-9a-fA-F]{4,64}$/, 'A commit sha is 4 to 64 hex characters.'),
    repo: z.string().min(1).max(HANDOFF_LIMITS.reference).optional().describe('The repository it is in, where the run has several.'),
  }),
  z.object({
    kind: z.literal('task'),
    task: z.union([z.string().min(1), z.number().int().min(0)]).transform(String).pipe(z.string().max(HANDOFF_LIMITS.reference))
      .describe('A task you may read — this one, one it depends on, or its loop\'s other end: "#order", its id or its title.'),
    finding: z.string().max(HANDOFF_LIMITS.reference).regex(/^F[1-9][0-9]*$/, 'A finding is named as Ordewell numbered it: "F1", "F2", ….').optional()
      .describe('One of that task\'s findings, as "F3".'),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.string().min(1).max(HANDOFF_LIMITS.reference).describe('An http or https URL.'),
  }),
]);

const handoffFinding = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'info'])
    .describe('How much it matters to the next reader. Advice only: it never changes the verdict.'),
  title: z.string().trim().min(1).max(HANDOFF_LIMITS.title).regex(/^[^\r\n]*$/, 'A title is one line.').describe('One line.'),
  detail: z.string().max(HANDOFF_LIMITS.detail).optional(),
  evidence: z.array(handoffReference).max(HANDOFF_LIMITS.evidence).optional().describe('Where a reader can check it.'),
});

const taskCompleteInput = z.object({
  status: z.enum(['done', 'blocked', 'failed'])
    .describe("'done' only when the task is fully complete. 'blocked' or 'failed' end the attempt without passing."),
  summary: z.string().max(HANDOFF_LIMITS.summary, `The summary is at most ${HANDOFF_LIMITS.summary} characters: put the long form in report.`)
    .describe('The handoff the next task reads first, written for that reader: what changed, what is left, what to watch.'),
  reason: z.string().optional().describe("Why the task is blocked or failed. Expected for anything but 'done'."),
  findings: z.array(handoffFinding).max(HANDOFF_LIMITS.findings).optional()
    .describe('What the next reader must act on, one item each, most important first. Ordewell numbers them F1, F2, … in this order.'),
  artifacts: z.array(handoffReference).max(HANDOFF_LIMITS.artifacts).optional()
    .describe('What this task produced, for the next reader to start from.'),
  report: z.string().max(HANDOFF_LIMITS.report).optional()
    .describe('The long form, for a reader who needs it all: kept with this attempt and read only on demand, never put in another task\'s prompt.'),
});

const checkpointInput = z.object({
  question: z.string().min(1).describe('The question for the user. The call returns their answer.'),
});

const listRunnersInput = z.object({});

const listModelsInput = z.object({
  runner: z.string().min(1).describe('A runner id from list_runners.'),
});

/**
 * What a sealed run is, said where the model chooses the tool (ADR-0036 S4)
 * and shared with the API planner's `bash`, so a sealed failure on the
 * network reads as the sandbox's doing rather than one to retry.
 */
export const SEALED_RUNS = 'Where this machine has a sandbox, a command that would be refused without asking (a loop, a here-document, a pipe into python3) runs sealed instead: no network, no home directory or credentials, and nothing it writes reaches the workspace; $TMPDIR, which is also $HOME, is a scratch directory kept for this session. Its result starts with "[Ran sealed".';

export const SEALED_PARAM = 'Run it sealed, without asking anyone: for local computation over the workspace, such as a loop over files or a pipeline into python3. Never for a command that needs the network or the user\'s accounts; it fails sealed. An allowlist exclusion and a command the user denied are refused either way.';

const runCommandInput = z.object({
  command: z.string().min(1).describe('One shell command line, run from the workspace root.'),
  sealed: z.boolean().optional().describe(SEALED_PARAM),
});

const taskRunCommandInput = z.object({
  command: z.string().min(1).describe("One shell command line, run from this task's working directory."),
});

const fetchInput = z.object({
  url: z.string().min(1).describe('The http or https URL to read.'),
});

const webSearchInput = z.object({
  query: z.string().trim().min(1).describe('What to search for.'),
});

const loadSkillInput = z.object({
  name: z.string().min(1).describe('The name of an Ordewell planner skill to load.'),
});

const taskRef = z.union([z.string().min(1), z.number().int().min(0)]).describe('A task id, "#order" ("#2.1" for a subtask), a bare order, or a title.');

const readTaskInput = z.object({
  task: taskRef,
  attempt: z.number().int().min(1).optional().describe('One of its saved attempts; omit for the latest.'),
  include_report: z.boolean().optional().describe(`Also return its report, the long form, of at most ${HANDOFF_LIMITS.report} characters.`),
});

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
  type: z.enum(['ai', 'user', 'script']).optional(),
  dependencies: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  userSteps: z.array(z.looseObject({ order: z.number().optional(), instruction: z.string() })).optional(),
  assignedRunner: z.string().optional(),
  assignedModel: modelAssignment.optional(),
  readOnly: z.boolean().optional().describe('True for a task that must not change any file. Ordewell picks every mode; there is no taskMode.'),
  autonomy: z.enum(['AFK', 'HITL']).optional(),
  sliceType: z.enum(['AFK', 'HITL']).optional(),
  ops: z.boolean().optional(),
  userStoriesCovered: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional()
    .describe('Task skills (applies-to: task) by name; their bodies go in the runner\'s prompt. A subtask lists its own.'),
  subtasks: z.array(z.record(z.string(), z.unknown())).optional(),
  // ADR-0035. Their shape is the plan's rule to judge, as the other fields' is.
  commands: z.array(z.array(z.string())).optional()
    .describe('A script task\'s argument vectors, run in order with no shell, stopping at the first that fails. Exactly one of commands or script.'),
  script: z.string().optional().describe('A script task\'s script, run by the research shell. Exactly one of commands or script.'),
  timeoutMs: z.number().optional().describe('A script task\'s time limit in milliseconds; ten minutes when left out.'),
  // ADR-0045. Loose like the rest: the plan's rules judge the body and the rounds.
  research: z.boolean().optional().describe('A top-level read-only AI task whose report wakes the planner (ADR-0037 R1). Never in a loop body.'),
  loop: z.looseObject({
    body: z.array(z.string()).describe('The ids of the top-level tasks that fix what this check finds; each depends on this task.'),
    maxRounds: z.number().optional().describe('The most times this check runs, 1 to 10; 3 when left out.'),
  }).optional().describe('Makes this task a loop\'s check: while it fails with rounds left, Ordewell runs the body with its report, then runs it again.'),
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
  attempt: z.number().int().min(1).optional().describe('Read this saved attempt; omit for the latest. Supplying attempt or kinds selects the structured log.'),
  kinds: z.array(z.enum(TASK_LOG_KINDS)).optional().describe('Only these TaskLogEvent types. Commands appear in tool_call and tool_result; runner messages in text/text_delta.'),
  task: taskRef,
  lines: z.number().int().min(1).optional().describe(`How many lines to return; the default is 80 and anything over ${OUTPUT_LINES_MAX} is cut to ${OUTPUT_LINES_MAX}.`),
  since: z.number().int().min(0).optional().describe("A previous answer's nextOffset: return only what came after it."),
});

const taskDiffInput = z.object({
  task: taskRef,
  repo: z.string().min(1).optional().describe('A repository path from the file list; default is every repo.'),
  path: z.string().min(1).optional().describe('A literal repo-relative file path from the list. Omit for file change stats.'),
  lines: z.number().int().min(1).optional().describe('Maximum lines per page (default 80, cap 400).'),
  since: z.number().int().min(0).optional().describe('A previous nextOffset, in characters of this diff or file list.'),
});

const runPlanInput = z.object({});

const oneTaskInput = z.object({ task: taskRef });

const retryTaskInput = z.object({
  task: taskRef,
  from: z.enum(['fresh', 'session'])
    .describe('"fresh": a new attempt from the task\'s prompt as the plan holds it now (change the prompt with edit_plan first). "session": continue the runner\'s saved session with "message"; for a completed or failed task, or one paused on a usage limit.'),
  message: z.string().optional().describe('What the runner should do next. Required with "session", except to resume a task paused on a usage limit.'),
});

const skipTaskInput = z.object({
  task: taskRef,
  reason: z.string().describe('Why the run should go on without this task. Shown to the user, and told to the tasks that depend on it.'),
});

const messageTaskInput = z.object({
  task: taskRef,
  text: z.string().trim().min(1).describe('The message. A running task reads it at its next step; one waiting for input takes it as its answer.'),
});

// What the body holds is judged by the plan's rules, as a script task's in submit_plan is (ADR-0035).
const runScriptInput = z.object({
  title: z.string().trim().min(1).describe('What the script does, as its task in the plan is titled.'),
  commands: z.array(z.array(z.string())).optional()
    .describe('Argument vectors run in order with no shell, stopping at the first that fails, like [["git", "push", "origin", "main"]]. Exactly one of commands or script.'),
  script: z.string().optional().describe('A script, run by the shell your run_command uses, for an effect that needs one (a pipe, a loop). Exactly one of commands or script.'),
  timeoutMs: z.number().optional().describe('Its time limit in milliseconds; ten minutes when left out.'),
  dependencies: z.array(taskRef).optional().describe('Tasks in the plan it runs after. It waits for the user to merge their work into their branch first.'),
});

const answerApprovalInput = z.object({
  task: taskRef,
  approval: z.string().optional().describe('Which request, when the task has more than one waiting; a refusal lists them.'),
  answer: z.string().min(1).describe('"deny" or "escalate". Never "allow": that would widen the mode the plan gave the task.'),
  note: z.string().optional().describe('With "deny": what the runner should do instead. It reads this.'),
});

export type TaskCompleteArgs = z.infer<typeof taskCompleteInput>;
export type CheckpointArgs = z.infer<typeof checkpointInput>;
export type ReadTaskArgs = z.infer<typeof readTaskInput>;
export type ListRunnersArgs = z.infer<typeof listRunnersInput>;
export type ListModelsArgs = z.infer<typeof listModelsInput>;
export type LoadSkillArgs = z.infer<typeof loadSkillInput>;
export type RunCommandArgs = z.infer<typeof runCommandInput>;
export type TaskRunCommandArgs = z.infer<typeof taskRunCommandInput>;
export type FetchArgs = z.infer<typeof fetchInput>;
export type WebSearchArgs = z.infer<typeof webSearchInput>;
export type SubmitPlanArgs = z.infer<typeof submitPlanInput>;
export type EditPlanArgs = z.infer<typeof editPlanInput>;
export type TaskQueryArgs = z.infer<typeof taskQueryInput>;
export type TaskOutputArgs = z.infer<typeof taskOutputInput>;
export type TaskDiffArgs = z.infer<typeof taskDiffInput>;
export type RunPlanArgs = z.infer<typeof runPlanInput>;
export type OneTaskArgs = z.infer<typeof oneTaskInput>;
export type RetryTaskArgs = z.infer<typeof retryTaskInput>;
export type MessageTaskArgs = z.infer<typeof messageTaskInput>;
export type SkipTaskArgs = z.infer<typeof skipTaskInput>;
export type AnswerApprovalArgs = z.infer<typeof answerApprovalInput>;
export type RunScriptArgs = z.infer<typeof runScriptInput>;

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

/** A command's outcome as `run_command` answers it, the planner's and a read-only task's alike. */
export function commandReply(outcome: ToolOutcome): McpToolReply {
  return { text: outcome.output || (outcome.success ? '(no output)' : 'The command failed with no output.'), ...(outcome.success ? {} : { isError: true }) };
}

/** The checkpoint call's result: the answer as the runner reads it (ADR-0022, V5). */
export function checkpointReply(answer: CheckpointAnswer): McpToolReply {
  switch (answer.kind) {
    case 'continue': return { text: 'approved: the user said yes — continue' };
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
  /** A handoff the task may read (ADR-0047), from its attempt's log. */
  readTask?: Run<ReadTaskArgs>;
  /** A read-only task's shell (ADR-0046); only its token lists `run_command`. */
  runCommand?: Run<TaskRunCommandArgs>;
}

export interface PlannerToolHandler {
  loadSkill?: Run<LoadSkillArgs>;
  runCommand?: Run<RunCommandArgs>;
  fetch?: Run<FetchArgs>;
  webSearch?: Run<WebSearchArgs>;
  listRunners?: Run<ListRunnersArgs>;
  listModels?: Run<ListModelsArgs>;
  submitPlan?: Run<SubmitPlanArgs>;
  editPlan?: Run<EditPlanArgs>;
  taskQuery?: Run<TaskQueryArgs>;
  taskOutput?: Run<TaskOutputArgs>;
  taskDiff?: Run<TaskDiffArgs>;
  runPlan?: Run<RunPlanArgs>;
  runTask?: Run<OneTaskArgs>;
  stopTask?: Run<OneTaskArgs>;
  stopRun?: Run<RunPlanArgs>;
  retryTask?: Run<RetryTaskArgs>;
  skipTask?: Run<SkipTaskArgs>;
  messageTask?: Run<MessageTaskArgs>;
  answerApproval?: Run<AnswerApprovalArgs>;
  mergeAll?: Run<RunPlanArgs>;
  runScript?: Run<RunScriptArgs>;
}

export interface McpTool<H> {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations?: { readOnlyHint: boolean };
  /** Validate `args` and hand them to the handler's method for this tool. */
  call(handler: H, args: unknown, context: McpToolContext): Promise<McpToolReply>;
}

/**
 * One rejected slot of a tool call, said so the caller can mend the call in
 * one try. Three kinds cover every schema failure: a count problem (a missing
 * or unexpected parameter, a wrong number of items), a parse problem (the
 * value's shape) and a constraint problem (the value's content).
 */
const slotOf = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? 'arguments' : path.map(String).reduce((at, part, i) => (i === 0 ? part : /^\d+$/.test(part) ? `${at}[${part}]` : `${at}.${part}`));

/** Whether the slot an issue names ever arrived in the raw call arguments. */
function arrived(args: unknown, path: readonly PropertyKey[]): boolean {
  let at: unknown = args;
  for (const part of path) {
    if (at === null || typeof at !== 'object') return true;
    if (!(part in at)) return false;
    at = (at as Record<PropertyKey, unknown>)[part];
  }
  return true;
}

function issueLines(issue: z.core.$ZodIssue, args: unknown): string[] {
  const at = slotOf(issue.path);
  switch (issue.code) {
    case 'invalid_type': {
      // A slot that never arrived is a count problem, not a shape one.
      if (!arrived(args, issue.path)) return [`wrong number of parameters: '${at}' is required and missing`];
      // This zod build neither types nor sets `received`; it says it only in the message.
      const received = /received (\S+)$/.exec(issue.message)?.[1] ?? 'nothing';
      return [`parameter parsing failed: '${at}' expected ${issue.expected}, the call sent ${received}`];
    }
    case 'invalid_union': {
      if ((issue as { note?: string }).note === 'No matching discriminator') return [`invalid parameter: '${at}' matches none of the accepted values`];
      const forms = issue.errors.map((option) => option[0]).filter(Boolean).map((first) => (first as { expected?: string }).expected ?? first.message);
      return [`parameter parsing failed: '${at}' matches none of its accepted forms: ${forms.length > 0 ? forms.join('; ') : 'none'}`];
    }
    case 'unrecognized_keys':
      return issue.keys.map((key) => `wrong number of parameters: '${at === 'arguments' ? key : `${at}.${key}`}' is not a parameter of this tool`);
    case 'too_small':
    case 'too_big':
      // An array bound counts items; every other bound is about one value's content.
      return issue.origin === 'array'
        ? [`wrong number of parameters: '${at}' ${issue.message}`]
        : [`invalid parameter: '${at}' ${issue.message}`];
    default: {
      // An enum: this zod build reports one code, `invalid_value`, with the choices but not what arrived.
      if ('values' in issue && Array.isArray(issue.values)) {
        return arrived(args, issue.path)
          ? [`invalid parameter: '${at}' — expected one of: ${issue.values.join(', ')}`]
          : [`wrong number of parameters: '${at}' is required and missing`];
      }
      return [`invalid parameter: '${at}' ${issue.message}`];
    }
  }
}

/** The cap on rejected slots in one reply: enough to mend a call, not enough to bury the fix. */
const ISSUE_LINES_MAX = 8;

/**
 * The reply to a call the schema rejected: every rejected slot with its kind
 * and its slot path (`ops[0].taskId`), then the parameters the tool takes.
 * Nothing ran, and the reply says so — several of these tools write.
 */
function invocationError(name: string, input: z.ZodObject, error: z.ZodError, args: unknown): string {
  const lines = error.issues.slice(0, ISSUE_LINES_MAX).flatMap((issue) => issueLines(issue, args));
  const more = Math.max(0, error.issues.length - ISSUE_LINES_MAX);
  const takes = Object.keys(input.shape);
  return [
    `Invocation error: ${name} rejected the call before it ran; nothing changed.`,
    ...lines,
    ...(more > 0 ? [`… and ${more} more rejected slots`] : []),
    ...(takes.length > 0 ? [`Parameters of ${name}: ${takes.join(', ')}.`] : [`${name} takes no parameters.`]),
  ].join('\n');
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
      if (!run) return { text: `Invocation error: ${name} is not available in this session — no handler is wired, so the call ran nothing.`, isError: true };
      const parsed = input.safeParse(args ?? {});
      if (!parsed.success) return { text: invocationError(name, input, parsed.error, args ?? {}), isError: true };
      return run(parsed.data, context);
    },
  };
}

/** The task tool whose call settles the attempt (ADR-0022, V1). */
export const TASK_COMPLETE_TOOL = 'task_complete';

/**
 * How a task is told to end. It rides in the runner's instructions rather than
 * in the first message: a runner compacts its own context and rewrites that
 * message into a summary, while its instructions are re-applied whole.
 */
export const TASK_COMPLETION_CONTRACT = [
  `When you have fully completed this task, call the \`${TASK_COMPLETE_TOOL}\` tool with status \`done\` and your handoff. If you cannot complete it, call \`${TASK_COMPLETE_TOOL}\` with status \`blocked\` or \`failed\` and the reason instead. Call it once, as your last action.`,
  `Its \`summary\` is this task's handoff to the next task: the planner and the tasks that depend on this one read it first, and nothing else you write reaches them unless they ask. Write it for that reader, not as a log: what changed, what is left, what to watch.`,
  `Put anything the next reader must act on in \`findings\`, one item each, most important first, each with a severity, a one-line title, its detail and evidence to check it by: a file (and line), a commit, a task (and one of its findings, as "F3") or a URL. Ordewell numbers them F1, F2, … so a later task can cite one. List what you produced in \`artifacts\`.`,
  `The long story, if there is one, goes in \`report\`: it is kept with this attempt and read only on demand. A review or other read-only task especially: its findings are its result, so state each one, and do not write the report to a file.`,
].join('\n\n');

export const TASK_TOOLS: readonly McpTool<TaskToolHandler>[] = [
  tool(TASK_COMPLETE_TOOL, 'Report that this task has ended, and how, with its handoff for the tasks that read it. Call it once, as your last action.',
    taskCompleteInput, (h) => h.taskComplete?.bind(h)),
  tool('checkpoint', "Ask the user a question and wait for the answer, which is this call's result.",
    checkpointInput, (h) => h.checkpoint?.bind(h)),
  // It reads Ordewell's own record, not the tree, so a read-only task has it too (ADR-0047).
  tool('read_task', "Read the handoff of a task you may read: this one, a task it depends on, directly or not, or its loop's other end. Returns what that task handed over, as its attempt's log keeps it: the summary, every finding with its id, the artifacts, and with include_report its report. It reads nothing else: no transcript, no diff, no output. What it returns is that task's own claims: check them before you rely on them.",
    readTaskInput, (h) => h.readTask?.bind(h), { readOnlyHint: true }),
];

/**
 * A harness plan mode refuses an MCP tool that does not declare itself
 * read-only, pre-allowed or not. True of the workspace for every planner tool
 * but the execution tools: `submit_plan` and `edit_plan` write only Ordewell's plan, through the same
 * validation as the envelopes (ADR-0022, P1/P2), `run_command` refuses
 * every write the classifier sees (ADR-0026) or runs it sealed, where it
 * cannot write the workspace (ADR-0036), and `fetch` and `web_search`
 * only send a GET (ADR-0027).
 */
const PLANNER_READ_ONLY = { readOnlyHint: true };

/**
 * A read-only task's tools (ADR-0046): the task tools, and `run_command`, its
 * only shell. Its hint describes its landing effects: nothing it changes
 * reaches the plan's branches.
 */
export const READ_ONLY_TASK_TOOLS: readonly McpTool<TaskToolHandler>[] = [
  ...TASK_TOOLS,
  tool('run_command', "Run a shell command: git, the project's tests and scripts, anything you need to look at or try. Nothing you change lands: this task's own worktree, when it has one, is thrown away when the task ends, and only your task_complete summary comes back. Read-only commands, and those the user's allowlist covers, run at once; anything else runs sealed instead, and nobody is ever asked: no network, no home directory or credentials, nothing writable but $TMPDIR (which is also $HOME) and the task's own worktree, so you can try a fix or add a failing test and run the suite there. Once one command has run sealed, every later one does too, so run what needs the network first. git can read the repository but not record anything in it. Where this machine has no sandbox, a command that would run sealed is refused. Use it instead of a shell of your own.",
    taskRunCommandInput, (h) => h.runCommand?.bind(h), PLANNER_READ_ONLY),
];

/**
 * The execution tools (ADR-0029) change what runs, so they say so. Every
 * harness planner is pre-authorized for the server by name, not by this hint,
 * and none runs in a plan mode that would refuse them for it.
 */
const PLANNER_EXECUTES = { readOnlyHint: false };

/**
 * The planner's execution tools (ADR-0029, #91): each call goes to the
 * session's command seam, which checks it, asks the user where consent needs
 * one, and records it. The API planner offers the same tools as its own.
 */
export const PLANNER_EXECUTION_TOOLS: readonly McpTool<PlannerToolHandler>[] = [
  tool('run_plan', 'Start the whole plan, as the user\'s Execute plan does. Only a plan the user has approved; in Guarded the user is asked first.',
    runPlanInput, (h) => h.runPlan?.bind(h), PLANNER_EXECUTES),
  tool('run_task', 'Start one task now. Refused, with the reason, for a task whose dependencies have not finished, one waiting for Merge all, or one the user has not approved; in Guarded the user is asked first. A task this reply\'s edit_plan adds may be named by the handle that edit gave it, or its title; the start waits for the edit to land as the reply ends.',
    oneTaskInput, (h) => h.runTask?.bind(h), PLANNER_EXECUTES),
  tool('stop_task', 'Stop one running task: it goes back to not started and is held until retried, and its open approvals are denied.',
    oneTaskInput, (h) => h.stopTask?.bind(h), PLANNER_EXECUTES),
  tool('stop_run', 'Stop every running task and the run. The plan is kept.',
    runPlanInput, (h) => h.stopRun?.bind(h), PLANNER_EXECUTES),
  tool('retry_task', 'Start a new attempt of a failed, stopped or waiting task: fresh from its prompt, or continuing its saved session with a message. To change what it is told, edit its prompt with edit_plan first. A task paused on a usage limit can be resumed early with from "session" once the user says the limit has been reset. In Guarded the user is asked first. A task this reply\'s edit_plan adds may be named by the handle that edit gave it, or its title; the start waits for the edit to land as the reply ends.',
    retryTaskInput, (h) => h.retryTask?.bind(h), PLANNER_EXECUTES),
  tool('skip_task', 'Give up waiting for a task that failed, is blocked or is waiting for input: it ends as skipped, none of its work lands, and the tasks that depend on it go ahead without it once the work it waited on is done, told your reason. It never marks work complete. Only the supervisor at Act may, in a wake-up turn; a reason is required.',
    skipTaskInput, (h) => h.skipTask?.bind(h), PLANNER_EXECUTES),
  tool('message_task', 'Send a message to a running task, or answer one waiting for input. A message to a task paused on a usage limit resumes it in its saved session.',
    messageTaskInput, (h) => h.messageTask?.bind(h), PLANNER_EXECUTES),
  tool('answer_approval', 'Answer a request a task\'s runner is waiting on: deny it with a note, or escalate it to the user. It never allows.',
    answerApprovalInput, (h) => h.answerApproval?.bind(h), PLANNER_EXECUTES),
  tool('merge_all', 'Merge the run\'s landed work into the user\'s branch, as their Merge all does, opening the merge gates that wait on it. Only the supervisor at Act may, in a wake-up turn; otherwise the user presses Merge all.',
    runPlanInput, (h) => h.mergeAll?.bind(h), PLANNER_EXECUTES),
  tool('run_script', 'Perform an exact effect yourself — a push, a tag, one setting on a cloud resource — as a script task: added to the plan and started at once, at the workspace root, with no model. Returns its verdict and the end of its output, or after a minute that it is still running; its result then reaches you in a run update when it ends. The user consents first: in Guarded, or in Full without autorun, they are asked on the approval card, shown the commands as written, and a denial leaves the task in the plan, not approved. For an effect that needs judgment, add an ops task instead; a change to repository files is a change task.',
    runScriptInput, (h) => h.runScript?.bind(h), PLANNER_EXECUTES),
];

export const PLANNER_TOOLS: readonly McpTool<PlannerToolHandler>[] = [
  tool('list_runners', 'List the runners enabled right now, and whether each takes a read-only task. Call it just before submit_plan.',
    listRunnersInput, (h) => h.listRunners?.bind(h), PLANNER_READ_ONLY),
  tool('list_models', 'List the models a runner may use right now, with labels and thinking-effort variants.',
    listModelsInput, (h) => h.listModels?.bind(h), PLANNER_READ_ONLY),
  tool('submit_plan', 'Submit the whole plan. It is checked against the live runners and models; an error names the task, the field and what would be accepted.',
    submitPlanInput, (h) => h.submitPlan?.bind(h), PLANNER_READ_ONLY),
  tool('edit_plan', 'Change the current plan with task operations: update, add, remove, reorder, merge, split or rearm.',
    editPlanInput, (h) => h.editPlan?.bind(h), PLANNER_READ_ONLY),
  tool('task_query', 'Read the long fields of plan tasks that the plan summary leaves out (prompt, user steps, verdict, output summary, handoff, attached skills), and optionally the live runner catalog. Read a task before you rewrite it.',
    taskQueryInput, (h) => h.taskQuery?.bind(h), PLANNER_READ_ONLY),
  tool('task_output', "Read the recent output of a running task, to check what its runner is doing; paged by offset. A task that is not running answers with its verdict, output summary, its whole handoff, its findings and report, and a digest of its last attempt. Supply attempt or kinds to page a saved structured log, latest by default.",
    taskOutputInput, (h) => h.taskOutput?.bind(h), PLANNER_READ_ONLY),
  tool('task_diff', 'Read what a task changed since it started: file stats with repository paths, or a single file patch with path and repo. Paged by since/nextOffset. Shared runs without recorded changes report not available.',
    taskDiffInput, (h) => h.taskDiff?.bind(h), PLANNER_READ_ONLY),
  tool('run_command', `Run a shell command for research: git, gh, az, kubectl, the project's own tooling, anything you need to look at. Read-only commands run at once; others ask the user, once per command family; commands that write files never change anything. ${SEALED_RUNS} Use it instead of a shell of your own.`,
    runCommandInput, (h) => h.runCommand?.bind(h), PLANNER_READ_ONLY),
  // Fallbacks (ADR-0027): a runner's own fetch or search, where it has one, is
  // decided by the same policy and carries the provider's own summaries, so
  // the descriptions send the model there first.
  tool('fetch', 'Read a web page over http or https: documentation, a changelog, an API reference. A fallback: if you have a built-in web fetch tool, use that instead. Whether a site may be read is up to the user\'s settings, and a refusal says why; private and local addresses and URLs that carry a credential are always refused, and each planning turn has a limited number of web reads.',
    fetchInput, (h) => h.fetch?.bind(h), PLANNER_READ_ONLY),
  tool('web_search', 'Search the web for result titles, URLs and snippets, then read the most promising result with a fetch. A fallback: if you have a built-in web search tool, use that instead. Whether a search may run is up to the user\'s settings, and a refusal says why; a query that carries a credential is refused, and searches count toward the turn\'s web reads.',
    webSearchInput, (h) => h.webSearch?.bind(h), PLANNER_READ_ONLY),
  tool('load_skill', 'Load an Ordewell planner skill by name. Returns its instructions; only model-invocable planner skills can be loaded.',
    loadSkillInput, (h) => h.loadSkill?.bind(h), PLANNER_READ_ONLY),
  ...PLANNER_EXECUTION_TOOLS,
];

export const PLANNER_TASK_READ_TOOLS = PLANNER_TOOLS.filter((t) => ['task_query', 'task_output', 'task_diff'].includes(t.name));
