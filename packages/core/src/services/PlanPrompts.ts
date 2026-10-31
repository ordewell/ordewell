import { DiscoveredModel, RunnerId, type Task } from '../models/Task';
import { readOnlyRunners, type RunnerModeInfo } from './ModeResolver';
import { DEFAULT_PLANNER_MODES, type IsolatedExecution, type PlannerModes } from './plannerModes';
import { TASK_QUERY_PROTOCOL, TASK_READ_TOOLS_PROTOCOL } from './TaskQuery';
import { SELF_REPO } from './isolationRecord';
import { taskRefOf } from './TaskRefs';
import type { SkillInfo } from './SkillsService';
import { modelInvocablePlannerSkills, modelInvocableTaskSkills } from './skillInvocation';
import { quotedMessageArgs } from './landingMessage';

// Keeps the message the merge was given; `strip` drops the `# Conflicts:` lines git adds to it.
const COMMIT_MERGE = 'git commit --no-edit --cleanup=strip';

/**
 * The exploration tools as the planner reads them. The spawn tool is named
 * only where the backend can run it: a Gemini planner cannot, so advertising
 * it there would send it to a call that always fails.
 */
export function buildResearchToolsPrompt(subagents = true): string {
  const lines = [
    'You have access to the following tools to explore the workspace:',
    '',
    'read_file(path: string, offset?: number, limit?: number) - Read file contents with line numbers and optional pagination. offset is a 0-based line number (default 0). limit is max lines (default 2000). Output lines are prefixed with their line numbers. When a file has more lines than requested, a hint shows the offset to use next. Files larger than ~1 MB are rejected — use grep instead.',
    'read_files(paths: string[]) - Read multiple files at once. Batch reads when you have several known paths — this is faster than calling read_file repeatedly.',
    'glob(pattern: string) - Find files matching a glob pattern (e.g. "src/**/*.ts"). Use for finding files by name/path. Results sorted by modification time, newest first.',
    'grep(pattern: string, include?: string) - Search for a regex pattern inside file contents. Use for finding code patterns, function definitions, imports, etc. Use "include" to filter by file type (e.g. "*.ts").',
    'list_dir(path: string, depth?: number) - List directory contents as a tree. Use for orientation — to see what directories and files exist. Use depth=2 or depth=3 for a tree view.',
    'bash(command: string) - Run a read-only shell command (ls, tree, git log/status/diff, cat, head, wc, etc.). Do NOT use bash for file search — use the dedicated glob and grep tools instead.',
    '',
    'TOOL CHOICE GUIDE:',
    '- list_dir: for browsing/orientation and understanding project structure',
    '- glob: for finding files by name/path pattern',
    '- grep: for searching inside file contents',
    '',
    'When multiple independent tool calls are needed, batch them in a single response to save round-trips. For example, if you need to read README.md and AGENTS.md, call read_files with both paths at once.',
    ...(subagents ? [
      '',
      'spawn_research_agent(prompt: string) - Launch a stateless read-only research agent that explores the workspace with its own tools and returns a digest within your tool round. Use it for orientation: a subsystem to map, or a "how does X work here" question, when only the conclusion matters to you. To explore several independent areas, launch the agents CONCURRENTLY: put multiple spawn_research_agent calls in one reply and they run in parallel.',
      'The agent sees nothing of this conversation, so its prompt must be self-contained: the area or question, the paths/symbols to start from, and exactly what the digest must report back: the conclusion and file:line references, no pasted file bodies, a few lines per point. Do NOT use it on small or single-subsystem repos, or to read one known file — direct tools are faster there.',
    ] : []),
  ];
  return lines.join('\n');
}

/**
 * System prompt for one read-only research subagent (issue #34). The digest
 * contract matters: the reply goes back to the planner as a tool result, so it
 * must be dense, self-contained, and carry exact file paths — never questions,
 * never a task plan.
 */
export function buildSubagentSystemPrompt(): string {
  return [
    'You are a read-only research subagent working for a project planner. You receive one self-contained research task, explore the workspace with your tools, and reply with a single digest. You never modify files and cannot spawn further agents. You may fetch or search the web, but a read that would need approval is refused — note the gap in your digest rather than retrying.',
    '',
    'Work efficiently: batch independent tool calls in one reply; prefer glob/grep to locate, then read only what matters. Your tool budget is small — stop exploring when you can answer the task.',
    '',
    'Your final reply IS the digest — it goes straight back to the planner, not to a human. It must contain:',
    '- The exact file paths (and key line references) relevant to the task',
    '- The key symbols/functions involved and how they connect',
    '- Constraints, gotchas, or conventions the planner must respect',
    '- Direct answers to every question the task asked',
    'Plain prose/markdown only. No questions, no task plans, no JSON, no pasted file bodies: name the path and line instead. Be dense and specific, a few lines per point; vague summaries are useless to the planner.',
  ].join('\n');
}

/**
 * The planner's whole say over a task's mode (ADR-0031). Mode names are
 * runner-specific and were what it got wrong, so it sees none of them.
 * What a read-only task is follows ADR-0046; `research` adds the research task
 * (ADR-0037), taught to the conversation planner only, since a one-shot run has
 * no conversation for a report to wake.
 */
function readOnlyGuide(runnerModes: Record<RunnerId, RunnerModeInfo[]> | undefined, tools: boolean, research = false): string {
  const able = runnerModes ? readOnlyRunners(runnerModes) : [];
  const possible = tools || !runnerModes || able.length > 0;
  return [
    'Set "readOnly": true on an AI task that must land nothing: a review, an audit, an investigation, an analysis whose result is a report. It reads with its runner\'s own read tools, and its only shell is Ordewell run_command, which runs anything sealed: tests, scripts, builds, loops. Sealed means no network (there is none inside a sealed run), no home directory or credentials, and nothing writable but the task\'s own throwaway worktree, where the run isolates. There it may edit files to try a fix, or add a failing test and run the suite on it. None of that lands: the worktree is thrown away when the task ends, and its task_complete report is its result, unless it keeps a prototype with save_patch, which a change task that depends on it applies with apply_patch. It reads the web only through Ordewell fetch and web_search, which the session\'s web-read settings decide without asking anyone, within a web-read budget of its own; a read those settings would only allow after asking is refused, and the task reports the gap. Never on an ops task, which acts in the workspace. Leave it false or out on every other task. A read-only task\'s subtasks are read-only too unless one sets "readOnly": false.',
    'You never choose a runner mode. Each task runs in its runner\'s mode for the user\'s autonomy level (Full or Guarded), or as a read-only task when "readOnly" is true.',
    ...(tools
      ? ['A read-only task must go to a runner list_runners marks "readOnly": true.']
      : runnerModes ? [able.length > 0 ? `Runners with a read-only mode: ${able.join(', ')}.` : 'No runner here has a read-only mode, so do not set "readOnly".'] : []),
    ...(research && possible ? researchTasksGuide(tools) : []),
  ].join('\n');
}

/**
 * Research tasks (ADR-0037), as a read-only task's guide ends: what its brief
 * holds, and that the planner decides how many run. When one is the right tool
 * is {@link whoExploresSection}'s to say; what a task does is the read-only
 * guide's. This only adds the report that comes back.
 */
function researchTasksGuide(tools: boolean): string[] {
  return [
    'Add "research": true to a read-only top-level AI task whose report should come back to you, as WHO EXPLORES says. Its report is its task_complete summary, and when the task ends (passes, fails or is blocked) it wakes you with that report, at every supervisor level, while you keep talking with the user meanwhile. Never on a subtask, an ops task or a loop\'s body.',
    'A research task may run anything sealed and try changes in its own throwaway worktree, but lands nothing. Write its prompt as a brief it can act on without this conversation: what to find out, where to start, what the report must contain (evidence for and against, file paths and line references, what it ran and what happened), and how you will check it. Prefer a command whose exit status settles a point over its prose.',
    `You add a research task with the plan, or ${tools ? 'with edit_plan' : 'in a task-ops reply'} later, and it starts at once without asking. Start one research task for each independent question; the run's Parallel limit bounds what runs at once. In a report turn, start another only when the report opens a genuinely new question.`,
  ];
}

/**
 * What `sealed: true` is for, and what a refusal leaves open (ADR-0036). The
 * planner is told the constraints it cannot see from its side: a sealed run
 * has no network and no home, so a command that needs either fails there.
 */
function sealedGuide(tool: 'bash' | 'run_command'): string {
  return `${tool} with "sealed": true runs a command without asking anyone, for local computation over the workspace: a loop over files, a script, a pipe into an interpreter. A sealed run has no network, the workspace read-only, and no home directory or credentials; $TMPDIR is a scratch directory for the session. A command that would be refused for being a loop, a here-document or a pipe into an interpreter runs sealed on its own where this machine has a sandbox, and you can ask for it yourself when you know a command is local computation. Never seal a command that needs the network or the user's accounts: it fails there. An allowlist exclusion and a command the user denied are refused either way, and without a sandbox a command that would run sealed is refused.`;
}

/**
 * The research-phase instructions, in the two variants the planner ships
 * (ADR-0009).
 *
 * The API variant names Ordewell's own tools because Ordewell is the one running
 * them. A harness planner brings its own toolbox, so naming `list_dir` or
 * `glob` there would be telling a coding agent to call tools it does not have.
 *
 * Only this block, the agents WHO EXPLORES names, and the tool-envelope
 * appendix differ between the two: the
 * plan schema, the runner and mode vocabulary, the model catalog, the
 * conversational protocol and the skill and mode blocks are shared verbatim. A
 * forked prompt would mean each future block gets written twice, or silently
 * works on one backend only.
 */
function researchPhaseBlock(harnessMode: boolean, agents: InTurnAgents): string {
  const shared = [
    'RESEARCH PHASE:',
    '- Start by reading README.md and any agent config files (AGENTS.md, CLAUDE.md)',
  ];
  const toolSpecific = harnessMode
    ? [
      '- Explore the repository with your own tools until you understand its architecture',
      '- You are planning, not implementing: do NOT edit, create, or delete any file, and do not run commands that change the workspace',
      '- Run commands — git, gh, cloud CLIs, the project\'s own tooling — with the run_command tool, not a shell of your own. MCP tools the user configured (issue trackers, todo lists) are yours to read from too. Reads run at once; anything else is approved or refused by the user\'s settings. When something the plan needs to change is refused, add it to the plan instead: a script task when you can state the exact commands, an ops task when it needs judgment',
      `- ${sealedGuide('run_command')}`,
      ...(agents === null ? [] : ['- When you delegate orientation to your own agents (WHO EXPLORES below), WAIT for their results inside this reply. Do NOT launch them in the background or async and end your turn saying you will report back later: your turn ending is what hands the conversation back to the user, and anything you say after it never reaches them.']),
    ]
    : [
      '- Use list_dir with depth=2-3 for a tree overview',
      '- Use glob and grep to find relevant source files',
      '- Read key source files to understand architecture',
      `- ${sealedGuide('bash')}`,
    ];
  return [
    ...shared,
    ...toolSpecific,
    '- Synthesize tool findings into your messages. The user does not see raw tool output; only your synthesis reaches them.',
    '- Research and questions can interleave — you can explore a file, then ask a question grounded in it, in one response',
  ].join('\n');
}

/**
 * The agents a planner explores with inside its own turn, named as its backend
 * names them, or null when it has none: an OpenCode planner's subagents are
 * withheld (ADR-0009 T8, ADR-0026), and an API planner's service may have no
 * research subagents to spawn (Gemini, which does not override
 * `createSubagentChat`). An OpenAI-compatible planner's are Ordewell's own
 * (ADR-0005), which return within the tool round that started them.
 */
export type InTurnAgents = string | null;

export function inTurnAgents(harness: boolean, runner?: RunnerId, subagents = true): InTurnAgents {
  if (!harness) return subagents ? 'spawn_research_agent' : null;
  switch (runner) {
    case 'claude-code': return 'your Agent tool';
    case 'codex': return 'your own subagents, if this session has them';
    case 'opencode': return null;
    default: return 'your own agents, if you have any';
  }
}

/**
 * Who finds something out, decided by what the result is (ADR-0037 R5). A
 * planner cannot know how long a lookup takes before it starts, so a line
 * drawn by duration sent lookups to cold task sessions and kept evidence the
 * plan rests on in the planner's context, from where only re-typing passes it
 * on. The test is the brief because that is where re-typed evidence ends up,
 * and a planner that saw no way to plan without evidence explored in its own
 * turn, so it hears that a first plan may be research alone. Every other
 * section refers to this one instead of restating it, and it
 * names no section around it, so a sub-planner's role prompt (#33, #112) can
 * include it unchanged.
 */
export function whoExploresSection(agents: InTurnAgents): string[] {
  const inTurn = agents === null
    ? 'Find it with your own reads: you have no agents of your own here.'
    : agents === 'spawn_research_agent'
      ? 'Find it with your own reads, or with spawn_research_agent, whose agents return within your tool round.'
      : `Find it with your own reads, or with ${agents}, awaited inside this turn.`;
  return [
    'WHO EXPLORES:',
    'Decide who finds something out by what the result is, never by how long it may take. The test: if the finding a later task acts on would end up in its brief, it is evidence; if it only decides what you say or ask the user, it is orientation.',
    `- Orientation: you need it this turn to answer, ask or outline, only its conclusion matters, and no later task acts on it. ${inTurn}${agents === null ? '' : ' Brief each agent to return a digest: the conclusion and file:line references, no pasted file bodies, a few lines per point.'}`,
    '- Evidence: a task of its own, when any of these holds: finding out needs a worktree (write a failing test, build, reproduce); another runner or model should judge it, for a second view or a stronger model; the user should see it and be able to stop it; or a later task will act on its findings. In the last case the later task depends on it, so the findings reach it in its handoff: do not re-type them into the later task\'s brief. Make it a research task only when you must decide something on its report; one whose report only later tasks read is a read-only task they depend on. A loop\'s fix may depend on it only when the check does: make the check depend on it, and the fix reads the report with `read_task`.',
    '- A research task\'s summary is what you take in: pull its full report with task_output only where the plan rests on the detail.',
    '- A first plan may be research tasks alone, when the plan cannot be outlined without their evidence: the outline is a line per task saying what it asks, and you plan the rest when their reports wake you. A vague goal the user can clarify is not one: ask first.',
    '- Search: a problem that needs rounds of branching, where each round\'s reports decide the next, is the explore skill: rounds of research tasks. Where it is which of several approaches to take, the skill has explorers save their prototypes with save_patch, choose on a check fixed beforehand, and has the build task depend on the chosen explorer and apply its patch with apply_patch.',
  ];
}

/**
 * Said only to a planner process that was given its harness's own shell
 * (ADR-0036 N1, N2). The setting alone does not give one: an unchecked
 * version, Codex, and a first process whose version is not known yet keep
 * `run_command` alone, so the line goes with the spawn, not the conversation.
 */
export const NATIVE_SHELL_GUIDE = [
  'YOUR OWN SHELL:',
  '- In this session your own shell is available too, for local reads, loops and scripts, in place of the research phase\'s "not a shell of your own". It runs under Ordewell\'s sandbox: the workspace read-only, only a scratch folder writable, and none of the user\'s credentials. Its commands reach the timeline as bash steps. It has the internet but not this machine\'s own services (localhost, local sockets), so reach those, the user\'s accounts and anything that needs their credentials through run_command.',
].join('\n');

/**
 * Facts about who plans and where tasks will run, as opposed to the user's
 * choices: they change what the prompt can promise, not what it asks for.
 */
/**
 * What autorun asks of the planner (ADR-0030), in the opening prompt and in a
 * turn where the user turned it on. Questions stay: a guess on real ambiguity
 * would then run unattended.
 */
export const AUTORUN_ON =
  'AUTORUN is on: a plan you submit starts when your reply ends, without the user\'s review. When you are ready to plan, write the outline in your reply as the plan\'s summary and submit the plan in the same reply; do not wait for the user to confirm it, and do not start its tasks yourself. Still ask clarifying questions first when the goal is vague or a decision would materially change the outcome.';

/** A turn where the user turned autorun off: the outline gate is back. */
export const AUTORUN_OFF =
  'AUTORUN is off now: show the outline and wait for the user to confirm it before you submit a plan.';

export interface ConversationVariant {
  /**
   * Harness planner (ADR-0009): the agent owns its own tools and research
   * budget, and reads the catalog and submits the plan through Ordewell's MCP
   * tools (ADR-0022). An API planner speaks the JSON envelopes instead.
   */
  harness?: boolean;
  /** A harness planner's runner, which names the agents it explores with in its turn ({@link inTurnAgents}). */
  runner?: RunnerId;
  /** The skill catalog: task skills it can attach on every path, planner skills it can load only with tools. */
  skills?: readonly SkillInfo[];
  /** Whether an API planner's service can run Ordewell's research subagents; Gemini cannot (it has no `createSubagentChat`). */
  subagents?: boolean;
  /** Every AI task gets its own worktree (ADR-0013), so file overlap no longer forces an order; of every repo of a group (ADR-0014). */
  isolatedExecution?: IsolatedExecution;
  /** The session offers the execution tools (ADR-0029), as MCP tools or the API planner's own. */
  execution?: boolean;
  /** A submitted plan starts at once (ADR-0030): the planner does not wait for its outline to be confirmed. */
  autorun?: boolean;
}

/**
 * The execution tools (ADR-0029), in brief: what each does is in its own
 * description, and what may be done is decided at the command seam, never
 * here, so this only says where they fit in the conversation.
 */
const EXECUTION_TOOLS_SECTION = [
  'RUNNING THE PLAN:',
  'When the user asks you to start, stop or retry work, do it with these tools rather than telling them which button to press. Ordewell checks every call, may ask the user first, and a refusal says why and what would be accepted.',
  '- run_plan starts the whole plan, or makes the tasks already running one scheduled run, so their dependents start; run_task starts one task now, and nothing starts after it on its own.',
  '- run_script performs an exact effect yourself, such as a push or one setting on a cloud resource: a script task, added to the plan and started at once with no model, from the commands you give as argument vectors (or a script). The user consents to it as written, unless AUTORUN is on and autonomy is Full. It returns the result, or after a minute that it still runs, and the result then reaches you in a run update. An effect that needs judgment is an ops task.',
  '- stop_task stops one running task; stop_run stops every running task and keeps the plan.',
  '- retry_task starts a new attempt of a failed, stopped or waiting task: "fresh" from its prompt, or "session" to continue its saved session with a message. To change what it is told, edit its prompt with edit_plan first. A task paused on a usage limit can be resumed early with from "session" once the user says the limit has been reset.',
  '- message_task sends a running task a message, or answers one waiting for input.',
  '- answer_approval denies a request a task\'s runner is waiting on, with a note saying what to do instead, or escalates it to the user. It never allows, and it does not cover a checkpoint.',
  '- answer_checkpoint approves the checkpoint a task\'s runner waits at, or rejects it with a reason the runner acts on. Only the supervisor at Act may, in a wake-up turn; in the user\'s own turn they answer it from the task\'s checkpoint card, so tell them what it asks. A message does not answer one.',
  '- merge_all merges the run\'s landed work into the user\'s branch. Only the supervisor at Act may, in a wake-up turn; in the user\'s own turn they press Merge all themselves.',
  '- skip_task gives up waiting for a failed, blocked or waiting task, with a reason: none of its work lands, and its dependents go ahead once the work it waited on is done. Only the supervisor at Act may, in a wake-up turn; in the user\'s own turn they skip it themselves.',
  'With AUTORUN on and autonomy Full nobody is asked anything, in the user\'s turn or in a wake-up turn at Act: run_plan, run_task, run_script and retry_task go through on a first plan as on an approved one, script tasks included, and run_plan starts or joins everything, so you never need to drive tasks one by one. An edit starts nothing by itself: call run_plan when the user wants it run. Otherwise only tasks the user approved start, and a task you add in the user\'s turn waits for them. A task the supervisor adds at Act is approved to run.',
  '',
];

/**
 * The parallelism rule for tasks that each run in their own worktree. Only
 * ever instead of the overlap-avoidance rule, never beside it: in a shared
 * workspace, two tasks on one file really do overwrite each other.
 */
const ISOLATED_PARALLELISM_RULE =
  '- Each change task runs in its own git worktree, and its work is merged in afterwards, so tasks that edit the same files can still run in parallel. Never add a dependency just because two tasks touch the same file — keep dependencies for genuine logical ordering.';

/** A task's copy of the workspace sits elsewhere, so an absolute path the planner researched points past it. */
const ISOLATED_PATHS_RULE =
  '- In a task\'s prompt, name every file by its path from the workspace root, never by an absolute path: each task works in its own copy of the workspace, and an absolute path into the workspace reaches the user\'s own checkout instead, where the earlier tasks\' work is not merged yet.';

const OVERLAP_AVOIDANCE_RULE = '- For parallel tasks, specify different target files to avoid merge conflicts.';

/**
 * Change versus ops (ADR-0020): what decides where a task runs and when. The
 * conversation planner also hears that a question is no task, since a one-shot
 * run has no conversation to answer one in, and about script tasks (ADR-0035),
 * whose shape only its PLAN FORMAT teaches.
 */
function opsTaskSection(conversation: boolean): string[] {
  return [
    '',
    'CHANGE AND OPS TASKS:',
    '- Every AI task is either a change task or an ops task. Decide by one test: is the task\'s result a change to files in the repository?',
    '- A change task (the default) edits repository files. Omit "ops".',
    '- An ops task changes no repository files: it acts on systems outside the repository (a cloud CLI, a deployment, a pipeline, a provisioned resource) or on the git refs and history of the user\'s branch (push, tag, reword commits). Set "ops": true. Only top-level "ai" tasks can be ops; a subtask runs with its parent.',
    '- Ops tasks run in the user\'s own checkout, after the user has merged the change tasks they depend on. Give an ops task a dependency on every change task whose result it acts on — "deploy the fix" depends on the fix.',
    '- Split a request that mixes the two into a change task and an ops task that depends on it: "bump the version and redeploy" is a change task that bumps and commits the version, then an ops task that pushes and watches the pipeline.',
    '- Ops tasks run in parallel as their dependencies allow. Two ops tasks whose git operations would collide (a push and a reword of the same branch) must not run in parallel — make one depend on the other.',
    '- An ops task runs until what it acts on has finished: one that watches a pipeline reports done only when the pipeline has ended.',
    ...(conversation
      ? [
        '- A question is not a task. "What is the frontend\'s URL?" is answered in this conversation, from your research; never make a task of it.',
        '- A change to the world takes one of three shapes. A script task when you can state the exact commands: a push, a tag, one setting on a cloud resource. An ops task when the work needs judgment: watching a pipeline and reacting to it, investigating a failed deploy, a step that depends on what the last one found. A change task for files.',
        '- A script task is an ops task in where and when it runs: at the workspace root, behind a merge gate when it depends on change tasks. Its verdict is its exit status, and its log is what ran and what it printed.',
      ]
      : []),
  ];
}

/** Even under worktree isolation, tasks appending to one shared file still race each other's merges. */
const SHARED_APPEND_FILE_RULE =
  '- Tasks that run in parallel must not each append to the same shared file (changelogs, registries, index lists) — give that edit to the final task, or to one task the others depend on.';

/**
 * What a planner must know about a repo group (ADR-0014), as a section of its
 * own; nothing for tasks in the shared root or a lone repository with nothing
 * shared, whose prompts stay as they were. The repos are named as the workspace
 * has them: no name or role is assumed. Shared paths are the one place
 * isolation does not keep parallel tasks apart, and the planner is the only
 * thing that can.
 */
function repoGroupSection(isolated: IsolatedExecution | undefined): string[] {
  if (!isolated) return [];
  // A lone repository isolates, but the repositories nested in it cannot; they
  // are linked live, and the planner must keep parallel tasks off the same one.
  if (isolated.repos.length === 1 && isolated.repos[0] === SELF_REPO) {
    if (isolated.shared.length === 0) return [];
    return [
      '',
      'NESTED REPOSITORIES:',
      `- The workspace is a git repository, isolated per task. Repositories nested inside it are not isolated with it: they are linked live into every task at these same relative paths: ${isolated.shared.join(', ')}.`,
      '- Edits to them take effect at once and are never merged or reviewed, so two tasks that edit the same one must not run in parallel — make one depend on the other.',
    ];
  }
  return [
    '',
    'REPO GROUP:',
    `- The workspace is a folder of git repositories isolated together: ${isolated.repos.join(', ')} (paths relative to the workspace).`,
    '- Every task sees all of them at these same relative paths, so one task can read and change any of them. Refer to files by their path from the workspace root.',
    '- A task lands atomically: its changes to every repository it touched are merged together, or none are.',
    ...(isolated.shared.length > 0
      ? [`- Shared paths are live, linked into every task rather than isolated: ${isolated.shared.join(', ')}. Edits to them take effect at once and are never merged or reviewed, so two tasks that edit the same shared path must not run in parallel — make one depend on the other.`]
      : []),
  ];
}

export function buildConversationSystemPrompt(
  goal: string,
  context: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  variant: ConversationVariant = {},
): string {
  const modelsJson = modelsJsonFor(modelsByRunner, runners);
  return buildConversationBody(goal, context, modelsJson, runners, readOnlyGuide(runnerModes, variant.harness ?? false, true), variant);
}

/**
 * Where a planner with Ordewell's tools gets its catalog (ADR-0022, L3): pulled
 * at the moment it submits, since a runner enabled or an allowlist edited
 * while it planned is what the submission is checked against.
 */
const PLANNER_TOOLS_CATALOG = [
  'RUNNERS, MODELS AND MODES:',
  'Which runners, models and modes you may assign can change while you plan: the user may enable a runner or edit the model allowlist at any time. Read them just before you submit, never from memory:',
  '1. Call list_runners: the enabled runners, and which of them have a read-only mode.',
  '2. Call list_models for each runner you will assign: its allowed models, with their thinking-effort variants.',
  '3. Call submit_plan with the whole plan. "assignedRunner" must be a runner list_runners returned, "assignedModel.modelId" a modelId list_models returned for that runner.',
  '4. If submit_plan returns errors, fix exactly what each one names and call it again in the same reply. If it reports "coerced" changes, tell the user what was changed.',
  '',
];

/**
 * The judgment step (#108): what kind of goal this is decides whether there is
 * a plan at all, and what shape it takes. Only a build is planned as vertical
 * slices, so the slicing rules sit under BUILD PLANS. The prompt teaches the choice and
 * grants nothing: what may run is decided at the command seam (ADR-0035).
 * Loops (ADR-0045) sit under the build and the failure to explain, since a
 * goal that is done only when something passes is usually one of those with a
 * check at its end. Research tasks (ADR-0037) are how a failure's hypotheses
 * and an open problem's rounds are explored: their reports wake the planner.
 */
function strategySection(execution: boolean): string[] {
  return [
    'STRATEGY:',
    'Before you outline anything, decide what kind of goal this is:',
    '- A question your research can answer: answer it here, in your reply. No plan.',
    execution
      ? '- A small effect you can state as exact commands: one script task. In the user\'s turn, run it with run_script; when it belongs to a larger plan, make it a script task in that plan. An effect that needs judgment is an ops task.'
      : '- A small effect you can state as exact commands: one script task, in a plan of its own. An effect that needs judgment is an ops task.',
    '- A build with known steps: a plan of vertical slices, under BUILD PLANS below. Its tests, type checks and self-review belong inside its implementation tasks; a loop is for what LOOPS below allows.',
    '- A failure to explain: reproduce it first, investigate competing hypotheses in parallel, then fix. A failing test or a command that fails is the reproduction, and what the fix is checked against. When one sealed command settles a hypothesis, test it yourself this turn. Give each other hypothesis a research task of its own that reports the evidence for and against it (WHO EXPLORES). Plan the fix once the reports name the cause. A simple fix reproduces and validates its regression within its own task; a loop is for what LOOPS below allows.',
    '- A goal the user states as done only when something passes ("until the tests pass", "review and fix until there are no confirmed issues"): a loop, under LOOPS below. It sits at the end of a build or a fix.',
    '- An open problem with no known path: a search (WHO EXPLORES). Plan only the first round of exploration, as research tasks that each report on one question. Their reports wake you: read them, then extend the plan with the next round, or with the build they point to.',
    'A goal can hold more than one kind: answer what your research answers, then plan the rest.',
    '',
  ];
}

/**
 * How the planner spends its own context (#108). The numbers it manages by
 * ride on each turn's input (`TurnBudgets`), never on this prompt, which stays
 * the same from turn to turn.
 */
const CONTEXT_SECTION = [
  'YOUR CONTEXT:',
  'You are the only one who sees every piece, so your context is the scarcest resource in the run. Spend it on understanding the problem and on integration.',
  '- Go deep yourself when the work is small, sequential, and its detail decides your next step.',
  '- Delegate the rest as WHO EXPLORES says, by what its result is.',
  '- Before going deep into anything that looks large, map it first (skim it, or map it as WHO EXPLORES says), then split along the seams the map shows.',
  '- Give each delegated piece a self-contained brief: its goal, its inputs, what to report back, and how its result will be checked. A task never sees this conversation. Plan the integration step.',
  '- Prefer evidence you can check (a test, an exit code, a proof checker) over a task\'s own word.',
  '- A turn\'s input may end with how full your context is and what remains of your reads. Plan the turn around it.',
  '',
];

function buildConversationBody(
  goal: string,
  context: string,
  modelsJson: string,
  runners: RunnerId[],
  modeGuide: string,
  variant: ConversationVariant,
): string {
  const tools = variant.harness ?? false;
  const autorun = variant.autorun ?? false;
  const agents = inTurnAgents(tools, variant.runner, variant.subagents ?? true);
  const submit = tools
    ? 'call list_runners and list_models, then submit the final task plan with submit_plan'
    : 'emit the final task plan as a JSON object with a "tasks" array';
  return [
    `You are Ordewell's project planner. You explore the codebase, ask concise clarifying questions grounded in your findings, choose a strategy for the goal, and produce structured task plans ${tools ? 'through the submit_plan tool' : 'as JSON'} when it needs one. Be direct: avoid unnecessary preamble, summaries, or explanations unless the user asks for detail.`,
    '',
    'WORKFLOW:',
    '1. Explore the workspace with tools to understand the codebase.',
    '2. Ask clarifying questions grounded in your findings. Reference actual files. When the goal is vague, or a decision would materially change the outcome (storage engine, library choice, scope, API shape), ask the user BEFORE planning — never silently assume. Clear, fully-specified goals need no questions.',
    '3. Choose a strategy for the goal (STRATEGY below). A question is answered without a plan.',
    '4. When the strategy calls for a plan and you have enough context, produce a prose outline — a short list describing each task in order.',
    autorun ? `5. Write the outline in your reply, then ${submit} in the same reply.` : `5. After the user confirms the outline, ${submit}.`,
    '',
    researchPhaseBlock(tools, agents),
    '',
    ...whoExploresSection(agents),
    '',
    ...(tools ? ['Ordewell skills load only through load_skill; do not use the native Skill tool or read skill files directly.', ...plannerSkillsBlock(variant.skills ?? []), ''] : []),
    ...strategySection(variant.execution ?? false),
    ...CONTEXT_SECTION,
    ...(autorun
      ? [
        'OUTLINE PHASE (AUTORUN is on):',
        `- ${AUTORUN_ON}`,
      ]
      : [
        'OUTLINE PHASE:',
        `- When you are ready to propose a plan, first show a prose outline. DO NOT jump straight to ${tools ? 'submit_plan' : 'JSON'}.`,
      ]),
    '- Format: a numbered list of the plan\'s tasks in order, each with what it does and what it changes or reports. For a build, each item is a vertical tracer-bullet slice, with the files/layers it touches.',
    '- Example, for a build: "1. Set up database schema (src/db/schema.ts) — creates tables for users and sessions\n2. Add auth middleware (src/auth/middleware.ts) — validates JWTs on protected routes\n3. Build login page (src/ui/Login.tsx) — form component with validation"',
    ...(autorun
      ? []
      : [
        '- The user may reply with adjustments. Revise the outline and re-present it.',
        tools ? '- When the user confirms the outline, submit the plan with submit_plan.' : '- When the user confirms the outline, emit the task plan JSON.',
      ]),
    '',
    'PLAN FORMAT:',
    tools ? 'submit_plan takes {"tasks": [...]}, every task in this shape:' : 'Generate a task plan using this JSON format:',
    '',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "unique-task-id (any short unique string, e.g. task-1)",',
    '      "order": 1,',
    '      "title": "Concise title",',
    '      "description": "What this task accomplishes",',
    '      "type": "ai|user|script",',
    '      "dependencies": ["task-id-string"],',
    '      "prompt": "Detailed instructions for the AI assistant (ai tasks only)",',
    '      "userSteps": [{ "order": 1, "instruction": "Step description", "completed": false }],',
    '      "assignedModel": { "modelId": "model-id", "modelLabel": "Model Label", "thinkingEffort": "a variant id from that model\'s variants list — omit if the model has none" },',
    '      "assignedRunner": "' + (tools ? 'a runner id from list_runners' : runners.join('|')) + '",',
    '      "readOnly": false,',
    '      "research": false,',
    '      "autonomy": "AFK|HITL",',
    '      "sliceType": "AFK|HITL",',
    '      "ops": true,',
    '      "skills": ["task-skill-name"],',
    '      "userStoriesCovered": ["user story text"],',
    '      "subtasks": [{ "id": "sub-id-string", "order": 1, "title": "Sub-step title", "description": "What it accomplishes", "type": "ai", "dependencies": [], "prompt": "Detailed instructions", "autonomy": "AFK|HITL", "sliceType": "AFK|HITL", "subtasks": [] }]',
    '    }',
    '  ]',
    '}',
    '',
    'A script task runs its body with no model, and takes this shape instead:',
    '{ "id": "push-1", "order": 3, "title": "Push the release branch", "description": "What it does", "type": "script", "dependencies": ["task-2"], "commands": [["git", "push", "origin", "release"]], "sliceType": "AFK" }',
    '- "commands" is a list of argument vectors, run in order with no shell, stopping at the first that fails. For an effect that needs a shell (a pipe, a loop), give "script" instead: one script, run by the shell your own commands use. Give exactly one of the two.',
    '- "timeoutMs" is its time limit in milliseconds; ten minutes when left out.',
    '- Only a top-level task can be one. Leave out "prompt", "assignedRunner", "assignedModel", "readOnly", "ops", "skills", "userSteps" and "subtasks".',
    '',
    'A research task is a read-only AI task with "research": true (see READ-ONLY TASKS below). Its prompt is a brief that stands alone:',
    '{ "id": "scout-1", "order": 2, "title": "Why does the cache serve stale entries?", "description": "Reports the evidence for and against one hypothesis", "type": "ai", "dependencies": [], "prompt": "Hypothesis: entries are keyed by path, so a rename keeps the old entry. Start at src/cache/store.ts. Reproduce it with a test in your own worktree. Report: whether the hypothesis holds, the evidence for and against it with file paths and line numbers, and the exact command you ran with its result.", "readOnly": true, "research": true, "autonomy": "AFK", "sliceType": "AFK" }',
    '',
    'A loop is one "loop" field on its check (see LOOPS below). A script task is the check here, and an AI task the fix:',
    '{ "id": "tests-1", "order": 4, "title": "Run the test suite", "description": "Passes when the suite does", "type": "script", "dependencies": ["task-3"], "commands": [["npm", "test"]], "sliceType": "AFK", "loop": { "body": ["fix-1"], "maxRounds": 3 } }',
    '{ "id": "fix-1", "order": 5, "title": "Fix the failing tests", "description": "Makes the suite pass", "type": "ai", "dependencies": ["tests-1"], "prompt": "The test run\'s report is in your prior task outputs. Fix the cause of each failure it lists; change nothing else.", "autonomy": "AFK", "sliceType": "AFK" }',
    'An AI task is the check when no command can judge the work. Its prompt says how it reports (the review is read-only):',
    '{ "id": "review-1", "order": 6, "title": "Adversarial review", "description": "Passes when the review confirms no problem", "type": "ai", "dependencies": ["task-3"], "prompt": "Review the change as an adversary. Confirm each problem before you report it. Call task_complete with status failed and every confirmed problem in the report; with status done when you confirm none.", "readOnly": true, "autonomy": "AFK", "sliceType": "AFK", "loop": { "body": ["fix-2"] } }',
    '',
    'SLICE CLASSIFICATION:',
    '- "autonomy": AFK (agent works autonomously) or HITL (needs user confirmation)',
    '- "sliceType": Same vocabulary as autonomy.',
    '- AFK tasks MUST NOT contain "userSteps". HITL tasks MAY contain userSteps.',
    '- User tasks (type "user") always have sliceType "HITL".',
    '- "sliceType" is REQUIRED on every task, and "autonomy" on every "ai" task, at every depth — a "subtasks" entry is a full task object with all the same required fields, not a bare label.',
    '',
    ...taskSkillsSection(variant.skills ?? []),
    'DEPENDENCY & PARALLELISM:',
    '- Independent slices should have NO dependencies — they run in parallel.',
    '- Only add dependencies when a slice truly depends on artifacts another slice creates.',
    ...(variant.isolatedExecution ? [ISOLATED_PARALLELISM_RULE, ISOLATED_PATHS_RULE] : []),
    ...repoGroupSection(variant.isolatedExecution),
    ...opsTaskSection(true),
    '',
    'BUILD PLANS:',
    'When the strategy is a build, these rules apply as well. No other strategy is planned as vertical slices.',
    '- Design each task as a VERTICAL TRACER-BULLET SLICE — a narrow but complete, independently demoable path. Do NOT create horizontal layer-by-layer tasks.',
    '- Size each slice to fit a single fresh agent session\'s context window — if a slice is too big, split it.',
    '- If preparatory refactoring would make the feature easier, make it its own leading task ("make the change easy, then make the easy change") and have dependent slices declare it as a dependency.',
    '- Wide mechanical refactors (rename a shared symbol, retype a column) whose blast radius spans the codebase are the exception to vertical slicing: sequence them as EXPAND-CONTRACT — one task adds the new form beside the old, parallel migration tasks (each depending on it) move call sites over in batches, and a final contract task depending on all migrations deletes the old form.',
    '- "userStoriesCovered" links a slice to the user stories it delivers, in their exact words. Leave it out when the goal states none.',
    '- Reference specific files and patterns from your research in task prompts.',
    SHARED_APPEND_FILE_RULE,
    ...(variant.isolatedExecution ? [] : [OVERLAP_AVOIDANCE_RULE]),
    '',
    'LOOPS:',
    'A loop repeats a check with its fix until the check passes. Ordewell runs the rounds itself, with no turn of yours in between: the check runs, and while it fails with rounds left, the body runs and then the check runs again. Use one only for an explicit iterate-until goal ("until the suite passes", "review and fix until there are no confirmed issues") or a specific acceptance condition that needs independent repeated checking and fixing. Routine tests, type checks and self-review belong inside the implementation tasks; tests that exist, a command that can be rerun or code that changed never make a loop. When you infer a loop the user did not ask for, give its reason in the outline.',
    '- Put "loop": { "body": ["fix-id", ...], "maxRounds": 3 } on the check. "body" names, by id, the top-level tasks that fix what the check finds. Each depends on the check, and otherwise only on what the check depends on or on other tasks of the body. Whatever comes after the loop depends on the check, never on a body task.',
    '- A loop\'s body cannot depend on a research task directly. When the fix acts on a research task\'s findings, make the check depend on the research task: the body may then depend on it too, and reads its report with `read_task` (WHO EXPLORES).',
    '- The check is a top-level AI or script task with no subtasks. A body task is a top-level AI or script task in one loop only, never a manual task, and has no subtasks either: each round runs a task again whole, so give each step its own task.',
    '- Prefer a script task as the check wherever a command can judge the work: the test suite, the type checker, the linter, a benchmark against a threshold. Its exit status is evidence you can check: 0 passes, anything else fails and starts a round.',
    '- Otherwise the check is an AI task, such as an adversarial review. Write in its prompt that it calls task_complete with status "failed" and every confirmed problem in its report when it finds any, and "done" when it confirms none. Only a "failed" report starts a round: "blocked" (it could not do the check) and a run that ends without a report start none.',
    '- Each body task is given the check\'s latest report as its prior task output, told which round it is from. Write its prompt to act on that report, and to change nothing else.',
    `- Adding a loop to a plan you already submitted, ${tools ? 'with edit_plan' : 'in a task-ops reply'}, takes three ops in this order, since a handle cannot be referenced before the op that defines it: add the check without "loop", with a "handle"; add each body task, depending on the check's handle, with a handle of its own; then update the check, by its handle, with "loop": {"body": [the body handles], "maxRounds": 3}. ${tools ? 'submit_plan names' : 'A whole plan names'} ids directly, so it needs no handles.`,
    '- Choose "maxRounds" deliberately, from 1 to 10; it is 3 when left out. It is the most times the check runs, so it bounds the spend. Raise it only where each round is cheap and clearly converging. A check that fails its last round fails, and the tasks after it are blocked until someone looks.',
    '',
    'RULES:',
    ...(tools
      ? [
        '- Submit the plan ONLY through submit_plan. Never write it as JSON in your reply.',
        autorun ? '- Write the outline in your reply before submitting the plan.' : '- Show the outline BEFORE submitting. Do not skip the outline.',
      ]
      : [
        '- Do NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object when committing the plan.',
        autorun ? '- Write the outline before the JSON.' : '- Emit the outline BEFORE the JSON. Do not skip the outline.',
      ]),
    '',
    'CONVENTIONS:',
    '- When suggesting libraries, frameworks, or patterns, first verify they already exist in the codebase. NEVER assume a library is available just because it is well-known. Check package.json, imports, or surrounding files first.',
    '- Follow the existing code style, naming conventions, and architectural patterns of the project.',
    '',
    ...(tools
      ? PLANNER_TOOLS_CATALOG
      : ['MODEL ASSIGNMENT:', 'Available models:', modelsJson, '', runnerInstruction(runners)]),
    'MODEL SELECTION GUIDELINES:',
    '- Use stronger models for complex refactoring, architecture changes, security-critical code.',
    '- Use weaker/faster models for simple file operations, test generation, config changes, documentation.',
    `- Assign thinkingEffort based on task complexity, choosing ONLY from the assigned model's "variants" list ${tools ? 'from list_models' : 'above'} (e.g. low for simple tasks, high for complex ones). Omit thinkingEffort if the model has no variants.`,
    '',
    'READ-ONLY TASKS:',
    modeGuide,
    '',
    ...(tools ? TASK_READ_TOOLS_PROTOCOL : [
      ...TASK_QUERY_PROTOCOL,
      'You may also call task_query, task_output and task_diff when offered. task_output accepts attempt and kinds to read a saved structured log (latest attempt by default); task_diff lists changed files by repo, or reads one patch with path and repo. Both page with since/nextOffset. These calls share the taskQuery read cap. Without attempt or kinds, task_output keeps the live tail/outcome behavior. A shared run without recorded changes has no task diff.',
    ]),
    '',
    ...(variant.execution ? EXECUTION_TOOLS_SECTION : []),
    context ? `PROJECT CONTEXT:\n${context}\n` : '',
    `USER GOAL: ${goal}`,
  ].join('\n');
}

function plannerSkillsBlock(skills: readonly SkillInfo[]): string[] {
  const loadable = modelInvocablePlannerSkills(skills);
  return loadable.length === 0 ? [] : [
    'ORDEWELL PLANNER SKILLS:',
    'Call load_skill(name) when one of these skills would help:',
    ...loadable.map((skill) => `- ${skill.name}: ${skill.description}`),
  ];
}

/**
 * The "skills" field is documented for every planner: a user can name a task
 * skill with `/name` whether or not any is advertised. The catalog is the
 * model-invocable ones only; with none, the planner attaches on request alone.
 */
function taskSkillsSection(skills: readonly SkillInfo[]): string[] {
  const attachable = modelInvocableTaskSkills(skills);
  return [
    'TASK SKILLS:',
    '- "skills" optionally lists task skills by name; their instructions are put in that task\'s prompt when it runs. Omit it on tasks that need none.',
    '- A name that does not exist yet is accepted with a warning, so a task may name a skill that a task it depends on creates (.ordewell/skills/<name>/SKILL.md). Only skills with applies-to: task can be attached.',
    '- When the user asks to use a task skill, attach it to the tasks it fits.',
    ...(attachable.length === 0 ? [] : [
      'Task skills you may attach:',
      ...attachable.map((skill) => `- ${skill.name}: ${skill.description}`),
      'Attach one of these to a task only where its description says it applies. Never attach a skill to every task by default.',
    ]),
    '',
  ];
}

const RESEARCH_SECTION = [
  'PHASE 1 - RESEARCH:',
  'First, use the available tools to explore the workspace thoroughly. You can combine independent steps into a single response to save round-trips — for instance, read README.md and AGENTS.md simultaneously.',
  '- Start by reading README.md and any agent config files (AGENTS.md, CLAUDE.md)',
  '- Use list_dir with depth=3 for a tree overview of the project structure',
  '- Use glob to find relevant source files by pattern',
  '- Use grep to search for code patterns related to the user\'s goal',
  '- Read key source files to understand existing architecture',
  '- Do NOT use bash for file search — use glob/grep/list_dir instead',
  '- Only generate the plan AFTER you have enough context',
  '{{CLARIFICATION_INSTRUCTIONS}}',
].join('\n');

const ONE_SHOT_INSTRUCTIONS = [
  '',
  'This is a ONE-SHOT run: there is no user to ask questions to. Where the request is ambiguous, make the most reasonable assumption grounded in your research and record it in the relevant task description.',
  '',
].join('\n');

/**
 * The one-shot prompts' last word on output, per transport: an API planner
 * emits the plan as its reply, a coding agent submits it through submit_plan
 * and its reply is never read (ADR-0025).
 */
function submitInstruction(tools: boolean): string {
  return tools
    ? 'Submit the plan ONLY through submit_plan. Never write the plan as JSON in your reply.'
    : 'Do NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object.';
}

function corePlannerPrompt(isolatedExecution: IsolatedExecution, tools = false): string {
  return [
  `You are a software project planner that ${tools ? 'submits structured task plans through submit_plan' : 'produces structured task plans as JSON'}.`,
  'Given a user\'s goal, create an ordered list of tasks that accomplish it.',
  '',
  tools ? 'submit_plan takes a plan using this schema:' : 'Generate a task plan using this JSON format:',
  '',
  '{',
  '  "tasks": [',
  '    {',
  '      "id": "unique-task-id (any short unique string, e.g. task-1)",',
  '      "order": 1,',
  '      "title": "Concise title summarizing the task",',
  '      "description": "What this task accomplishes",',
  '      "type": "ai|user",',
  '      "dependencies": ["task-id-string"],',
  '      "prompt": "Detailed instructions for the AI assistant (ai tasks only)",',
  '      "userSteps": [{ "order": 1, "instruction": "Step description", "completed": false }],',
  '      "assignedModel": { "modelId": "model-id", "modelLabel": "Model Label", "thinkingEffort": "a variant id from that model\'s variants list — omit if the model has none" },',
  '      "assignedRunner": "{{RUNNER_CHOICES}}",',
  '      "readOnly": false,',
  '      "autonomy": "AFK|HITL",',
  '      "sliceType": "AFK|HITL",',
  '      "ops": true,',
  '      "userStoriesCovered": ["user story text"],',
  '      "subtasks": [{ "id": "sub-id-string", "order": 1, "title": "Sub-step title", "description": "What it accomplishes", "type": "ai", "dependencies": [], "prompt": "Detailed instructions", "autonomy": "AFK|HITL", "sliceType": "AFK|HITL", "subtasks": [] }]',
  '    }',
  '  ]',
  '}',
  '',
  'VERTICAL SLICE PLANNING:',
  'Design each task as a VERTICAL TRACER-BULLET SLICE — a narrow but complete, independently demoable path that cuts through all layers (schema → backend logic → API/route → UI/consumer → tests). Do NOT create horizontal layer-by-layer tasks (e.g. "build all models", then "build all routes", then "build all tests"). Each slice should stand alone as a working end-to-end increment.',
  '- Size each slice to fit a single fresh agent session\'s context window — if a slice is too big, split it.',
  '- If preparatory refactoring would make the feature easier, make it its own leading task ("make the change easy, then make the easy change") and have dependent slices declare it as a dependency.',
  '- Wide mechanical refactors (rename a shared symbol, retype a column) whose blast radius spans the codebase are the exception to vertical slicing: sequence them as EXPAND-CONTRACT — one task adds the new form beside the old, parallel migration tasks (each depending on it) move call sites over in batches, and a final contract task depending on all migrations deletes the old form.',
  '',
  'SLICE CLASSIFICATION:',
  '- "autonomy": Classify each AI task as AFK (Away From Keyboard — the agent works autonomously with no user interaction needed) or HITL (Human In The Loop — the agent needs user confirmation, review, or input partway through).',
  '- "sliceType": Same vocabulary as autonomy. Use HITL for tasks that contain user-facing touchpoints (manual verification, approval gates, UI decisions a human must make). Use AFK for fully autonomous slices.',
  '- "userStoriesCovered": Link each task to the specific user story/stories from the PRD that it delivers. Copy the exact user story text.',
  '- AFK tasks MUST NOT contain "userSteps" — they are fully autonomous. HITL tasks MAY contain userSteps for the human touchpoints.',
  '- User tasks (type "user") always have sliceType "HITL" and must include "userSteps".',
  '- "sliceType" is REQUIRED on every task, and "autonomy" on every "ai" task, at every depth — a "subtasks" entry is a full task object with all the same required fields, not a bare label.',
  '',
  'DEPENDENCY & PARALLELISM RULES:',
  isolatedExecution
    ? '- Independent vertical slices should have NO dependencies between them — they can run in parallel.'
    : '- Independent vertical slices (no shared files/modules) should have NO dependencies between them — they can run in parallel.',
  '- Only add dependencies when the second slice truly depends on artifacts (files, APIs) that the first slice creates.',
  '- Prefer parallelism over serial chains. A plan with 3 independent slices running in parallel is better than 3 sequential tasks.',
  SHARED_APPEND_FILE_RULE,
  isolatedExecution ? ISOLATED_PARALLELISM_RULE : '- Slices that touch different areas of the codebase are naturally parallel.',
  ...(isolatedExecution ? [ISOLATED_PATHS_RULE] : []),
  ...repoGroupSection(isolatedExecution),
  ...opsTaskSection(false),
  '',
  'RULES:',
  '- Mark as type "ai" any task the coding assistant can do autonomously.',
  '- Mark as type "user" any task requiring manual action outside the codebase.',
  '- Each AI task must have a detailed "prompt" field with clear, specific instructions. Include the exact files to create/modify.',
  '- Each user task must have "userSteps" with an ordered array of step-by-step instructions.',
  '- Tasks can have "subtasks" for finer-grained sub-steps.',
  '- Use concise but clear titles and descriptions.',
  '',
  'PROMPT QUALITY RULES:',
  '- Include specific file paths discovered during research in prompts (e.g. "In src/components/Settings.tsx").',
  '- Reference existing patterns and hooks found in the codebase (e.g. "Use the existing useLocalStorage hook from src/hooks/useLocalStorage.ts").',
  ...(isolatedExecution ? [] : [OVERLAP_AVOIDANCE_RULE]),
  '',
  submitInstruction(tools),
  ].join('\n');
}

/** The one-shot planner's core rules for tasks that share the workspace root. */
export const CORE_PLANNER_PROMPT = corePlannerPrompt(false);

function getPlanTemplate(isolatedExecution: IsolatedExecution, tools: boolean): string {
  return [
    corePlannerPrompt(isolatedExecution, tools),
    '',
    '{{RESEARCH_SECTION}}',
    'MODEL ASSIGNMENT:',
    'You must assign an "assignedModel" to each AI task. Available models:',
    '',
    '{{MODELS_JSON}}',
    '',
    '{{RUNNER_INSTRUCTION}}',
    'MODEL SELECTION GUIDELINES:',
    '- Use stronger models (Opus, DeepSeek V4 Pro, Kimi 2.6) for: complex refactoring, architecture changes, security-critical code, performance optimization, large-scale changes.',
    '- Use weaker/faster models (Sonnet, DeepSeek V4 Flash) for: simple file operations, test generation, config changes, documentation, straightforward bug fixes.',
    '- Assign thinkingEffort based on task complexity: "low" for simple tasks, "medium" or "high" for moderate/complex tasks.',
    '  Where a model lists variants, use the variant IDs listed for that model in the models list — the set differs per model.',
    '  Omit thinkingEffort if the model has no variants.',
    '',
    'READ-ONLY TASKS:',
    '{{MODE_GUIDE}}',
    '',
    'CONTEXT:',
    '{{CONTEXT}}',
    '{{RESEARCH_RESULTS}}',
  ].join('\n');
}

function serializeModels(models: DiscoveredModel[]) {
  return models.map((m) => ({ modelId: m.modelId, modelLabel: m.modelLabel, variants: m.variants }));
}

function modelsJsonFor(
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[]
): string {
  const out: Record<string, ReturnType<typeof serializeModels>> = {};
  for (const r of runners) {
    out[r] = serializeModels(modelsByRunner[r] ?? []);
  }
  return JSON.stringify(out, null, 2);
}

function runnerInstruction(runners: RunnerId[]): string {
  const modelList = runners.map(r => `"${r}"`).join(' or ');
  if (runners.length > 1) {
    return [
      'RUNNER ASSIGNMENT (MULTI-RUNNER MODE):',
      `Multiple runners are enabled. The MODELS object above is keyed by runner.`,
      `For EACH AI task, set "assignedRunner" to ${modelList},`,
      'then pick "assignedModel" from THAT runner\'s list (modelId must match exactly).',
      'IMPORTANT: Only the runners and models listed above may be used. Do not reference any other runner.',
      '',
    ].join('\n');
  }
  return [
    `RUNNER ASSIGNMENT: All AI tasks run on "${runners[0]}". Set "assignedRunner" to "${runners[0]}" on each task.`,
    'IMPORTANT: Only the runner and models listed above may be used. Do not reference any other runner or model.',
    '',
  ].join('\n');
}

function buildPlanPromptBase(
  userGoal: string,
  context: string,
  researchResults: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  includeResearchSection: boolean,
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  modes: PlannerModes = DEFAULT_PLANNER_MODES,
  tools = false,
): string {
  const template = getPlanTemplate(modes.isolatedExecution, tools);
  const researchReplacement = includeResearchSection ? RESEARCH_SECTION : '';
  const modelsJson = modelsJsonFor(modelsByRunner, runners);

  const modeGuide = readOnlyGuide(runnerModes, tools);

  return template
    .replace('{{RESEARCH_SECTION}}', researchReplacement)
    .replace('{{CLARIFICATION_INSTRUCTIONS}}', ONE_SHOT_INSTRUCTIONS)
    .replace('{{MODELS_JSON}}', modelsJson)
    .replace('{{RUNNER_CHOICES}}', runners.join('|'))
    .replace('{{RUNNER_INSTRUCTION}}', runnerInstruction(runners))
    .replace('{{MODE_GUIDE}}', modeGuide)
    .replace('{{CONTEXT}}', context || '(no additional context)')
    .replace('{{RESEARCH_RESULTS}}', researchResults ? `\n\nRESEARCH FINDINGS:\n${researchResults}` : '')
    + `\n\nUser goal: ${userGoal}`;
}

export function buildResearchPrompt(
  userGoal: string,
  context: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  modes: PlannerModes = DEFAULT_PLANNER_MODES,
): string {
  return buildPlanPromptBase(userGoal, context, '', modelsByRunner, runners, true, runnerModes, modes);
}

export function buildPlanWithResults(
  userGoal: string,
  context: string,
  researchResults: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  modes: PlannerModes = DEFAULT_PLANNER_MODES,
  tools = false,
): string {
  return buildPlanPromptBase(userGoal, context, researchResults, modelsByRunner, runners, false, runnerModes, modes, tools);
}

export function modelContextBlock(
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
): string {
  const modelsJson = modelsJsonFor(modelsByRunner, runners);
  const modeGuide = readOnlyGuide(runnerModes, false);

  return [
    'MODEL ASSIGNMENT:',
    'You must assign an "assignedModel" to each AI task. Available models:',
    '',
    modelsJson,
    '',
    runnerInstruction(runners),
    'MODEL SELECTION GUIDELINES:',
    '- Use stronger models (Opus, DeepSeek V4 Pro, Kimi 2.6) for: complex refactoring, architecture changes, security-critical code, performance optimization, large-scale changes.',
    '- Use weaker/faster models (Sonnet, DeepSeek V4 Flash) for: simple file operations, test generation, config changes, documentation, straightforward bug fixes.',
    '- Assign thinkingEffort based on task complexity: "low" for simple tasks, "medium" or "high" for moderate/complex tasks.',
    '',
    'READ-ONLY TASKS:',
    modeGuide,
    '',
  ].join('\n');
}

/**
 * Runner prompt for the opt-in task that resolves an integration conflict
 * (ADR-0013). The resolver's own worktree starts at the integration tip, so the
 * merge it performs is exactly the one that conflicted; the conflicted task
 * then lands through that merge. Ordewell never resolves a conflict itself.
 *
 * In a repo group (ADR-0014) the conflict in one repo rolled the task back in
 * all of them, so the resolver merges the branch in every repo the task
 * changed, not only the one that conflicted.
 */
export function buildConflictResolutionPrompt(
  task: Task,
  conflict: { branch: string; message: string; repos: string[]; conflictRepo?: string },
  integrationBranch: string,
  plan?: readonly Task[],
): string {
  const { branch } = conflict;
  const ref = taskRefOf(plan ?? [], task.id) ?? `#${task.order}`;
  const asked = `What the task was asked to do:\n${task.prompt ?? task.description}`;
  const merge = `git merge --no-ff ${quotedMessageArgs(conflict.message)} ${branch}`;
  const repos = conflict.repos.filter((repo) => repo !== SELF_REPO);
  if (repos.length === 0) {
    return [
      `Task ${ref} "${task.title}" passed, but merging its branch \`${branch}\` into \`${integrationBranch}\` conflicted.`,
      `This working tree starts at the tip of \`${integrationBranch}\`. Run \`${merge}\` here and resolve every conflict so that both sides' intent survives: keep the work already integrated and add what the task contributed. Do not drop either side wholesale.`,
      `Build and test the result the way this project does, then commit the merge with \`${COMMIT_MERGE}\`.`,
      '',
      asked,
    ].join('\n');
  }
  return [
    `Task ${ref} "${task.title}" passed, but landing its branch \`${branch}\` on \`${integrationBranch}\` conflicted in ${conflict.conflictRepo ?? repos[0]}. A task lands in every repository it changed or in none, so none of its work has landed yet.`,
    `This workspace holds every repository at its usual path, each starting at the tip of \`${integrationBranch}\`. In each repository the task changed — ${repos.join(', ')} — run \`${merge}\` inside that repository's directory, and resolve every conflict so that both sides' intent survives: keep the work already integrated and add what the task contributed. Do not drop either side wholesale.`,
    `Build and test the result the way this project does, then commit the merge in each repository with \`${COMMIT_MERGE}\`.`,
    '',
    asked,
  ].join('\n');
}

/**
 * Runner prompt for a conflict repair (ADR-0015): a new attempt of the
 * conflicted task itself, in its kept worktree, so the merge runs the other
 * way round from {@link buildConflictResolutionPrompt} — the integration tip
 * into the task's branch. Whether it worked is decided by the evidence checks
 * and the landing that follow, never by the agent's word.
 */
export function buildConflictRepairPrompt(
  task: Task,
  conflict: { branch: string; message: string; repos: string[]; conflictRepo?: string; conflictFiles?: string[] },
  integrationBranch: string,
  plan?: readonly Task[],
): string {
  const { branch } = conflict;
  const ref = taskRefOf(plan ?? [], task.id) ?? `#${task.order}`;
  const files = conflict.conflictFiles ?? [];
  const merge = `git merge --no-edit ${quotedMessageArgs(conflict.message)} ${integrationBranch}`;
  const asked = `What the task was asked to do:\n${task.prompt ?? task.description}`;
  const resolve = 'resolve every conflict so that both sides\' intent survives: keep the work already integrated and add what the task contributed.';
  const repos = conflict.repos.filter((repo) => repo !== SELF_REPO);
  if (repos.length === 0) {
    return [
      `Task ${ref} "${task.title}" passed, but merging its branch \`${branch}\` into \`${integrationBranch}\` conflicted${files.length > 0 ? ` in ${files.join(', ')}` : ''}. None of its work has landed yet.`,
      `This is the task's own worktree, on \`${branch}\`, with its work committed. Run \`${merge}\` here and ${resolve} Never drop either side wholesale, and never abort the merge or reset it away.`,
      `Build and test the result the way this project does, commit the merge with \`${COMMIT_MERGE}\`, and only then call \`task_complete\`.`,
      '',
      asked,
    ].join('\n');
  }
  const stoppedIn = conflict.conflictRepo ?? repos[0];
  return [
    `Task ${ref} "${task.title}" passed, but landing its branch \`${branch}\` on \`${integrationBranch}\` conflicted in ${stoppedIn}${files.length > 0 ? ` (${files.join(', ')})` : ''}. A task lands in every repository it changed or in none, so none of its work has landed yet.`,
    `This is the task's own workspace, with each repository at its usual path on \`${branch}\` and the task's work committed. In each repository the task changed — ${repos.join(', ')} — run \`${merge}\` inside that repository's directory, and ${resolve} Never drop either side wholesale, and never abort a merge or reset it away.`,
    `Build and test the result the way this project does, commit the merge in each repository with \`${COMMIT_MERGE}\`, and only then call \`task_complete\`.`,
    '',
    asked,
  ].join('\n');
}
