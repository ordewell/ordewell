import { DiscoveredModel, RunnerId, type TaskSnapshot, type Task } from '../models/Task';
import type { LegacyPlanState } from '../models/Task';
import { buildModeGuide, filteredBuildModes, type RunnerModeInfo } from './ModeResolver';
import { DEFAULT_PLANNER_MODES, modesFor, type PlannerModes } from './plannerModes';
import { TASK_QUERY_PROTOCOL } from './TaskQuery';

export function buildResearchToolsPrompt(subagentsEnabled = false): string {
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
  ];
  if (subagentsEnabled) {
    lines.push(
      '',
      'spawn_research_agent(prompt: string) - Launch a stateless read-only research agent that explores the workspace with its own tools and returns a digest. Use it to delegate an open-ended exploration thread — a subsystem to map, or a "how does X work here" question — whenever one emerges during research. To explore several independent areas, launch the agents CONCURRENTLY: put multiple spawn_research_agent calls in one reply and they run in parallel.',
      'The agent sees nothing of this conversation, so its prompt must be self-contained: the area or question, the paths/symbols to start from, and exactly what the digest must report back. Do NOT use it on small or single-subsystem repos, or to read one known file — direct tools are faster there.',
    );
  }
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
    'You are a read-only research subagent working for a project planner. You receive one self-contained research task, explore the workspace with your tools, and reply with a single digest. You never modify files, never fetch URLs, and cannot spawn further agents.',
    '',
    'Work efficiently: batch independent tool calls in one reply; prefer glob/grep to locate, then read only what matters. Your tool budget is small — stop exploring when you can answer the task.',
    '',
    'Your final reply IS the digest — it goes straight back to the planner, not to a human. It must contain:',
    '- The exact file paths (and key line references) relevant to the task',
    '- The key symbols/functions involved and how they connect',
    '- Constraints, gotchas, or conventions the planner must respect',
    '- Direct answers to every question the task asked',
    'Plain prose/markdown only. No questions, no task plans, no JSON. Be dense and specific; vague summaries are useless to the planner.',
  ].join('\n');
}

function buildModeGuideForRunners(runners: RunnerId[], _autonomousDefault: boolean): string {
  const lines = ['Assign a "taskMode" to each AI task based on the runner:'];
  for (const r of runners) {
    if (r === 'claude-code') {
      lines.push('- For claude-code: "acceptEdits" (edit automatically, recommended), "default" (ask before edits), "plan" (read-only analysis), "bypassPermissions" (skip all prompts, CI only).');
    } else if (r === 'opencode') {
      lines.push('- For opencode: "build" (full access agent), "plan" (read-only analysis).');
    } else {
      lines.push(`- For ${r}: use the modes from the runner's manifest.`);
    }
  }
  lines.push('Use the recommended mode for implementation. Use "plan" for analysis-only requests.');
  return lines.join('\n');
}

function buildModeExamplesForRunners(runners: RunnerId[]): string {
  return runners.map(r => {
    if (r === 'claude-code') return 'claude-code: acceptEdits|default|plan|bypassPermissions';
    if (r === 'opencode') return 'opencode: build|plan';
    return `${r}: default|plan`;
  }).join(', ');
}

/**
 * Verification mode (evidence-based, AFK): a final task whose verdict comes
 * from running the suite, closing the "every task passed but the feature is
 * short" gap that per-task exit codes cannot see.
 */
function verificationModeBlock(): string {
  return [
    '',
    'VERIFICATION MODE:',
    'Add a FINAL verification task to the end of the plan (highest order number).',
    'This task closes the gap between "every task finished" and "the feature is correct": tasks executed in isolated sessions can each pass while the integrated feature is still short. Its outcome must come from commands and exit codes, never from judgement.',
    'This task must:',
    '- Have type "ai" and autonomy "AFK" — it needs no human input',
    '- Have dependencies on ALL other AI tasks in the plan',
    '- Use the same runner as the other tasks; a mid-tier model is fine (the work is running and writing tests, not architecture)',
    '- Its prompt should instruct the agent to:',
    '  * Re-read the ORIGINAL goal (and the PRD at `.scratch/<slug>/PRD.md` if one exists) — the whole feature spec, not any single task\'s slice',
    '  * Run the project\'s full test suite and typecheck/build, and fix any failure it finds',
    '  * If the project has NO test infrastructure, do not bootstrap a framework just for verification (unless an earlier task already added one) — instead write a standalone verification script that exercises the feature end-to-end through its public interface and exits non-zero on any failed check, and run it',
    '  * Walk the spec requirement by requirement — including every edge case the spec mentions — and check each one is covered by an executable test; write the missing tests at the public interface and make them pass',
    '  * Exercise the feature END-TO-END: integration gaps between task boundaries are this task\'s responsibility',
    '  * Succeed ONLY when the full suite, including the newly written tests, is green; if a check cannot be made to pass, fail the task loudly — never skip, weaken, or delete a check to get green',
  ].join('\n');
}

/**
 * The research-phase instructions, in the two variants the planner ships
 * (ADR-0009).
 *
 * The API variant names Ordewell's own tools because Ordewell is the one running
 * them. A harness planner brings its own toolbox, so naming `list_dir` or
 * `glob` there would be telling a coding agent to call tools it does not have.
 *
 * Only this block and the tool-envelope appendix differ between the two: the
 * plan schema, the runner and mode vocabulary, the model catalog, the
 * conversational protocol and every mode-toggle block are shared verbatim. A
 * forked prompt would mean each future toggle gets written twice, or silently
 * works on one backend only.
 */
function researchPhaseBlock(harnessMode: boolean): string {
  const shared = [
    'RESEARCH PHASE:',
    '- Start by reading README.md and any agent config files (AGENTS.md, CLAUDE.md)',
  ];
  const toolSpecific = harnessMode
    ? [
      '- Explore the repository with your own tools until you understand its architecture',
      '- You are planning, not implementing: do NOT edit, create, or delete any file, and do not run commands that change the workspace',
      '- If you delegate exploration to your own agents, WAIT for their results inside this reply. Do NOT launch them in the background or async and end your turn saying you will report back later: your turn ending is what hands the conversation back to the user, and anything you say after it never reaches them.',
    ]
    : [
      '- Use list_dir with depth=2-3 for a tree overview',
      '- Use glob and grep to find relevant source files',
      '- Read key source files to understand architecture',
    ];
  return [
    ...shared,
    ...toolSpecific,
    '- Synthesize tool findings into your messages. The user does not see raw tool output; only your synthesis reaches them.',
    '- Research and questions can interleave — you can explore a file, then ask a question grounded in it, in one response',
  ].join('\n');
}

export function buildConversationSystemPrompt(
  goal: string,
  context: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
  grillMeEnabled = false,
  prdEnabled = false,
  verificationEnabled = false,
  /** Harness planner (ADR-0009): the agent owns its own tools and research budget. */
  harnessMode = false,
): string {
  const modelsJson = modelsJsonFor(modelsByRunner, runners);
  const modeGuide = runnerModes ? buildModeGuide(runnerModes, autonomousDefault) : buildModeGuideForRunners(runners, autonomousDefault);

  const modeExamples = runnerModes
    ? Object.entries(runnerModes).map(([r, ms]) => {
        const filtered = filteredBuildModes(ms, autonomousDefault);
        return `${r}: ${filtered.map(m => m.id).join('|')}${ms.some(m => m.id === 'plan') ? '|plan' : ''}`;
      }).join(', ')
    : buildModeExamplesForRunners(runners);

  const grillMeBlock = grillMeEnabled ? [
    '',
    'INTERVIEW MODE — GRILL-ME:',
    'Interview the user relentlessly about every aspect of their goal until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.',
    'Ask one question at a time, waiting for the user\'s answer before continuing. For each question, propose your recommended answer so they can confirm or correct it. Asking multiple questions at once is bewildering.',
    'If a fact can be found by exploring the codebase, look it up instead of asking. The decisions, though, are the user\'s — put each one to them and wait.',
    'Only propose an outline after the user has answered enough questions that you genuinely understand the goal. Then present the prose outline and wait for explicit confirmation before emitting the task plan JSON.',
  ].join('\n') : '';

  const prdBlock = prdEnabled ? [
    '',
    'PRD MODE: Before producing the outline, generate a PRD in two steps.',
    'Step 1 — Propose a short prose preview containing: the problem statement, the proposed approach, the testing seams, and the main risks. Prefer existing seams over new ones; propose new seams at the highest point possible. The fewer seams across the codebase, the better — the ideal number is one. Propose a feature-slug for saving the PRD (e.g. `my-feature`). Ask the user whether they agree.',
    'Step 2 — Only after the user explicitly agrees, write the full markdown PRD using the standard PRD format (problem, user stories, implementation decisions, testing seams, out of scope). The user may edit the proposed feature-slug before you write the PRD; use the agreed slug in the final output.',
    'PRD content rules: user stories are an extensive numbered list, each "As an <actor>, I want <feature>, so that <benefit>". Record implementation decisions as decisions (modules, interfaces, schema changes, API contracts) — do NOT include specific file paths or code snippets; they go stale fast. Exception: a snippet from a prototype that encodes a decision more precisely than prose (state machine, reducer, schema, type shape) may be inlined, trimmed to the decision-rich parts.',
    'When writing the full PRD, wrap it EXACTLY with these markers so the system can save it automatically:',
    '<!-- ORDEWELL_PRD_START slug="<feature-slug>" -->',
    '... full markdown PRD ...',
    '<!-- ORDEWELL_PRD_END -->',
    'Do NOT emit the full PRD before the user agrees to the preview. Do NOT emit task plan JSON before the PRD is agreed and the outline is confirmed.',
  ].join('\n') : '';

  const verificationBlock = verificationEnabled ? verificationModeBlock() : '';

  return buildConversationBody(
    goal, context, modelsJson, runners, modeGuide, modeExamples, harnessMode,
    grillMeBlock, prdBlock, verificationBlock,
  );
}

function buildConversationBody(
  goal: string,
  context: string,
  modelsJson: string,
  runners: RunnerId[],
  modeGuide: string,
  modeExamples: string,
  harnessMode: boolean,
  grillMeBlock: string,
  prdBlock: string,
  verificationBlock: string,
): string {
  return [
    'You are Ordewell\'s project planner. You explore the codebase, ask concise clarifying questions grounded in your findings, and produce structured task plans as JSON. Be direct: avoid unnecessary preamble, summaries, or explanations unless the user asks for detail.',
    '',
    'WORKFLOW:',
    '1. Explore the workspace with tools to understand the codebase.',
    '2. Ask clarifying questions grounded in your findings. Reference actual files. When the goal is vague, or a decision would materially change the outcome (storage engine, library choice, scope, API shape), ask the user BEFORE planning — never silently assume. Clear, fully-specified goals need no questions.',
    '3. When you have enough context, produce a prose outline — a short list describing each vertical slice in order.',
    '4. After the user confirms the outline, emit the final task plan as a JSON object with a "tasks" array.',
    '',
    researchPhaseBlock(harnessMode),
    grillMeBlock,
    prdBlock,
    verificationBlock,
    '',
    'OUTLINE PHASE:',
    '- When you are ready to propose a plan, first show a prose outline. DO NOT jump straight to JSON.',
    '- Format: a numbered list describing each vertical tracer-bullet slice, with the files/layers each slice touches.',
    '- Example: "1. Set up database schema (src/db/schema.ts) — creates tables for users and sessions\n2. Add auth middleware (src/auth/middleware.ts) — validates JWTs on protected routes\n3. Build login page (src/ui/Login.tsx) — form component with validation"',
    '- The user may reply with adjustments. Revise the outline and re-present it.',
    '- When the user confirms the outline, emit the task plan JSON.',
    '',
    'PLAN FORMAT:',
    'Generate a task plan using this JSON format:',
    '',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "unique-task-id (any short unique string, e.g. task-1)",',
    '      "order": 1,',
    '      "title": "Concise title",',
    '      "description": "What this task accomplishes",',
    '      "type": "ai|user",',
    '      "dependencies": ["task-id-string"],',
    '      "prompt": "Detailed instructions for the AI assistant (ai tasks only)",',
    '      "userSteps": [{ "order": 1, "instruction": "Step description", "completed": false }],',
    '      "assignedModel": { "modelId": "model-id", "modelLabel": "Model Label", "thinkingEffort": "a variant id from that model\'s variants list — omit if the model has none" },',
    '      "assignedRunner": "' + runners.join('|') + '",',
    '      "taskMode": "' + modeExamples + '",',
    '      "autonomy": "AFK|HITL",',
    '      "sliceType": "AFK|HITL",',
    '      "userStoriesCovered": ["user story text"],',
    '      "subtasks": [{ "id": "sub-id-string", "order": 1, "title": "Sub-step title", "description": "What it accomplishes", "type": "ai", "dependencies": [], "prompt": "Detailed instructions", "autonomy": "AFK|HITL", "sliceType": "AFK|HITL", "subtasks": [] }]',
    '    }',
    '  ]',
    '}',
    '',
    'VERTICAL SLICE PLANNING:',
    'Design each task as a VERTICAL TRACER-BULLET SLICE — a narrow but complete, independently demoable path. Do NOT create horizontal layer-by-layer tasks.',
    '- Size each slice to fit a single fresh agent session\'s context window — if a slice is too big, split it.',
    '- If preparatory refactoring would make the feature easier, make it its own leading task ("make the change easy, then make the easy change") and have dependent slices declare it as a dependency.',
    '- Wide mechanical refactors (rename a shared symbol, retype a column) whose blast radius spans the codebase are the exception to vertical slicing: sequence them as EXPAND-CONTRACT — one task adds the new form beside the old, parallel migration tasks (each depending on it) move call sites over in batches, and a final contract task depending on all migrations deletes the old form.',
    '',
    'SLICE CLASSIFICATION:',
    '- "autonomy": AFK (agent works autonomously) or HITL (needs user confirmation)',
    '- "sliceType": Same vocabulary as autonomy.',
    '- AFK tasks MUST NOT contain "userSteps". HITL tasks MAY contain userSteps.',
    '- User tasks (type "user") always have sliceType "HITL".',
    '- "sliceType" is REQUIRED on every task, and "autonomy" on every "ai" task, at every depth — a "subtasks" entry is a full task object with all the same required fields, not a bare label.',
    '',
    'DEPENDENCY & PARALLELISM:',
    '- Independent slices should have NO dependencies — they run in parallel.',
    '- Only add dependencies when a slice truly depends on artifacts another slice creates.',
    '',
    'RULES:',
    '- Do NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object when committing the plan.',
    '- Emit the outline BEFORE the JSON. Do not skip the outline.',
    '- Reference specific files and patterns from your research in task prompts.',
    '- For parallel tasks, specify different target files to avoid merge conflicts.',
    '',
    'CONVENTIONS:',
    '- When suggesting libraries, frameworks, or patterns, first verify they already exist in the codebase. NEVER assume a library is available just because it is well-known. Check package.json, imports, or surrounding files first.',
    '- Follow the existing code style, naming conventions, and architectural patterns of the project.',
    '',
    'MODEL ASSIGNMENT:',
    'Available models:',
    modelsJson,
    '',
    runnerInstruction(runners),
    'MODEL SELECTION GUIDELINES:',
    '- Use stronger models for complex refactoring, architecture changes, security-critical code.',
    '- Use weaker/faster models for simple file operations, test generation, config changes, documentation.',
    '- Assign thinkingEffort based on task complexity, choosing ONLY from the assigned model\'s "variants" list above (e.g. low for simple tasks, high for complex ones). Omit thinkingEffort if the model has no variants.',
    '',
    'TASK MODE:',
    modeGuide,
    '',
    // Shared by both variants on purpose: the read channel is a text envelope
    // exactly so a harness planner, which Ordewell cannot hand tools to, speaks
    // the same protocol as an API-backed one (ADR-0009).
    ...TASK_QUERY_PROTOCOL,
    '',
    context ? `PROJECT CONTEXT:\n${context}\n` : '',
    `USER GOAL: ${goal}`,
  ].join('\n');
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

export const CORE_PLANNER_PROMPT = [
  'You are a software project planner that produces structured task plans as JSON.',
  'Given a user\'s goal, create an ordered list of tasks that accomplish it.',
  '',
  'Generate a task plan using this JSON format:',
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
  '      "taskMode": "{{MODE_EXAMPLES}}",',
  '      "autonomy": "AFK|HITL",',
  '      "sliceType": "AFK|HITL",',
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
  '- Independent vertical slices (no shared files/modules) should have NO dependencies between them — they can run in parallel.',
  '- Only add dependencies when the second slice truly depends on artifacts (files, APIs) that the first slice creates.',
  '- Prefer parallelism over serial chains. A plan with 3 independent slices running in parallel is better than 3 sequential tasks.',
  '- Slices that touch different areas of the codebase are naturally parallel.',
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
  '- For parallel tasks, specify different target files to avoid merge conflicts.',
  '',
  'Do NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object.',
].join('\n');

function getPlanTemplate(): string {
  return [
    CORE_PLANNER_PROMPT,
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
    '  For OpenCode models that support variants (e.g. deepseek-v4-pro), use the variant IDs from the models list.',
    '  For Claude Code, use the variant IDs listed for each model in the models list (adaptive, low, medium, high, xhigh, max — per-model).',
    '  Omit thinkingEffort if the model has no variants.',
    '',
    'TASK MODE:',
    '{{MODE_GUIDE}}',
    '{{VERIFICATION_BLOCK}}',
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
): string {
  // Scoping here, once, is what keeps a one-shot prompt honest: grill-me and
  // PRD interview the user, and this path has told the model there is nobody
  // to ask. Verification is structural, so it belongs.
  const scoped = modesFor('one-shot', modes);
  const { autonomousDefault } = scoped;
  const template = getPlanTemplate();
  const researchReplacement = includeResearchSection ? RESEARCH_SECTION : '';
  const modelsJson = modelsJsonFor(modelsByRunner, runners);

  const modeGuide = runnerModes ? buildModeGuide(runnerModes, autonomousDefault) : buildModeGuideForRunners(runners, autonomousDefault);

  const modeExamples = runnerModes
    ? Object.entries(runnerModes).map(([r, ms]) => {
        const filtered = filteredBuildModes(ms, autonomousDefault);
        return `${r}: ${filtered.map(m => m.id).join('|')}${ms.some(m => m.id === 'plan') ? '|plan' : ''}`;
      }).join(', ')
    : buildModeExamplesForRunners(runners);

  return template
    .replace('{{RESEARCH_SECTION}}', researchReplacement)
    .replace('{{CLARIFICATION_INSTRUCTIONS}}', ONE_SHOT_INSTRUCTIONS)
    .replace('{{MODELS_JSON}}', modelsJson)
    .replace('{{RUNNER_CHOICES}}', runners.join('|'))
    .replace('{{RUNNER_INSTRUCTION}}', runnerInstruction(runners))
    .replace('{{MODE_GUIDE}}', modeGuide)
    .replace('{{VERIFICATION_BLOCK}}', scoped.verification ? `\n${verificationModeBlock()}\n` : '')
    .replace('{{MODE_EXAMPLES}}', modeExamples)
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
): string {
  return buildPlanPromptBase(userGoal, context, researchResults, modelsByRunner, runners, false, runnerModes, modes);
}

export function buildModifyPlanPrompt(
  existingPlan: LegacyPlanState,
  userRequest: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  aiflowContext?: string,
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): string {
  const modelsJson = modelsJsonFor(modelsByRunner, existingPlan.runners);
  const planJson = JSON.stringify(existingPlan.tasks, null, 2);
  const aiflowBlock = aiflowContext
    ? `<aiflow_context>\n${aiflowContext}\n</aiflow_context>\n\n`
    : '';

  const modeGuide = runnerModes ? buildModeGuide(runnerModes, autonomousDefault) : '';

  return [
    'You are a software project planner. You previously generated a task plan and the user now wants to modify it.',
    '',
    'Here is the CURRENT plan as JSON:',
    planJson,
    '',
    'Available models:',
    modelsJson,
    '',
    `${aiflowBlock}USER MODIFICATION REQUEST:`,
    userRequest,
    '',
    'Modify the plan according to the user request. You may add, remove, reorder, or change any task properties.',
    'Return the COMPLETE modified plan as a JSON object with a single "tasks" array.',
    '',
    'RULES:',
    '- For each task, preserve these exact fields: id, order, title, description, type, status, dependencies, prompt, userSteps, subtasks, assignedModel, thinkingEffort, taskMode.',
    '- DO NOT modify or delete completed tasks UNLESS the user explicitly asks to redo or replace them. If the user asks to redo a completed task, change its status from "completed" to "pending" and update its properties as requested.',
    '- DO NOT modify or delete tasks with status "in_progress" — they are currently executing.',
    '- DO NOT modify or delete tasks with status "failed" UNLESS the user asks to fix them — then update the prompt and change status from "failed" to "pending".',
    '- DO NOT modify or delete tasks with status "blocked" UNLESS the user asks to unblock them. If unblocking, remove the failed dependency from the blocked task\'s dependencies array.',
    '- When the user fixes a failed task, also update any blocked tasks that depend on it: change their status from "blocked" to "pending".',
    '- Preserve existing task IDs for all unchanged, completed, and in-progress tasks.',
    '- Only create new IDs for newly added tasks.',
    '- When removing a task, update all other tasks that reference the deleted ID in their dependencies.',
    '- Ensure dependency chains remain valid — no dangling references to deleted IDs.',
    '- Renumber task "order" fields sequentially starting from 1 after insertions or deletions.',
    '- When adding new tasks, assign appropriate models and thinking efforts based on complexity.',
    ...(modeGuide ? ['', modeGuide] : []),
    '- Do NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object.',
  ].join('\n');
}




export function modelContextBlock(
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): string {
  const modelsJson = modelsJsonFor(modelsByRunner, runners);
  const modeGuide = runnerModes ? buildModeGuide(runnerModes, autonomousDefault) : buildModeGuideForRunners(runners, autonomousDefault);

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
    'TASK MODE:',
    modeGuide,
    '',
  ].join('\n');
}

export function executionLogBlock(executionLog: TaskSnapshot[]): string {
  if (executionLog.length === 0) return '';

  const completed = executionLog.filter((t) => t.status === 'completed');
  const failed = executionLog.filter((t) => t.status === 'failed');

  const lines = ['EXECUTION LOG SUMMARY:'];
  lines.push(`Total entries: ${executionLog.length} (${completed.length} completed, ${failed.length} failed)`);

  if (completed.length > 0) {
    lines.push('');
    lines.push('COMPLETED TASKS:');
    for (const t of completed) {
      const verdict = t.verdict ? ` — ${t.verdict.outcome.toUpperCase()}: ${t.verdict.reason}` : '';
      lines.push(`- [${t.id}] ${t.title}${verdict}`);
    }
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push('FAILED TASKS (eligible for retry):');
    for (const t of failed) {
      const verdict = t.verdict ? ` — ${t.verdict.reason}` : '';
      lines.push(`- [${t.id}] ${t.title} (retry #${t.retryCount})${verdict}`);
    }
  }

  return lines.join('\n');
}

export function pendingEditRulesBlock(): string {
  return [
    'MODIFICATION RULES:',
    '- Preserve existing task IDs for all unchanged tasks. Only create new IDs for newly added tasks.',
    '- DO NOT modify completed tasks from the execution log UNLESS the user explicitly asks to retry them. If retrying a completed task, assign it the SAME id as the original and set its status to "pending".',
    '- DO NOT modify or remove tasks that are currently in_progress — they are being executed by an active agent session.',
    '- When removing a task, update all other tasks that reference the deleted ID in their dependencies.',
    '- Ensure dependency chains remain valid — no dangling references to deleted IDs.',
    '- Renumber task "order" fields sequentially starting from 1 after insertions or deletions.',
    '- When adding new tasks, assign appropriate models and thinking efforts based on complexity.',
    '- For failed tasks being retried: use the same ID, update the prompt to address the failure reason, and set status to "pending".',
    '- Only modify the tasks the user asked to change. Return ALL pending tasks, not just the modified ones.',
    '',
  ].join('\n');
}

export function buildModifyDuringExecutionPrompt(
  executionLog: TaskSnapshot[],
  pendingTasks: string,
  userMessage: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): string {
  const execLogBlock = executionLogBlock(executionLog);
  const rulesBlock = pendingEditRulesBlock();
  const modelBlock = modelContextBlock(modelsByRunner, runners, runnerModes, autonomousDefault);

  const sections = [
    CORE_PLANNER_PROMPT,
    '',
    'You are modifying a plan that is currently executing. Some tasks have already been completed or failed.',
    '',
  ];

  if (execLogBlock) {
    sections.push(execLogBlock);
    sections.push('');
  }

  sections.push('CURRENT PENDING TASKS (these are NOT yet executed):');
  sections.push(pendingTasks);
  sections.push('');
  sections.push(rulesBlock);
  sections.push(modelBlock);
  sections.push('');
  sections.push('USER REQUEST:');
  sections.push(userMessage);
  sections.push('');
  sections.push('Return the COMPLETE modified pending tasks as a JSON object with a single "tasks" array. Include all pending tasks, not just the modified ones.\nDo NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object.');

  return sections.join('\n');
}

/**
 * User-message prompt for a planner-driven merge: asks the model to combine the
 * selected tasks into one. Routed through the conversation loop, so the
 * task-ops protocol (with the "merge" op) is injected alongside it by
 * `planContextBlock`. The model emits a single taskOps merge op.
 */
export function buildMergePrompt(taskIds: string[], tasks: Task[]): string {
  const idSet = new Set(taskIds);
  const selected = tasks.filter((t) => idSet.has(t.id)).sort((a, b) => a.order - b.order);
  const refs = selected.map((t) => `#${t.order} "${t.title}" (id=${t.id})`).join(', ');
  return [
    `Merge these tasks into ONE combined task: ${refs}.`,
    'Write a clear combined title, description, and prompt that cover all of their work.',
    'The merged task takes the union of their dependencies (excluding the merged tasks themselves) and preserves their user stories.',
    'Set "assignedRunner" and "assignedModel" on the merged task — use one of the runners and models listed in <available_models> above. Prefer the strongest model if the merged work is complex.',
    'Reply with ONLY a taskOps JSON object using a single "merge" op:',
    `  {"taskOps":[{"op":"merge","taskIds":[${selected.map((t) => `"${t.id}"`).join(', ')}],"merged":{"title":"...","description":"...","prompt":"...","assignedRunner":"...","assignedModel":{"modelId":"...","modelLabel":"..."}}}]}`,
    'If this merge needs a companion op in the same batch (e.g. an added task that should depend on the merge result), give the merge op a "handle" (any unused name) and reference it from the later op\'s taskId/dependencies.',
  ].join('\n');
}

/**
 * User-message prompt for a planner-driven split: asks the model to decompose
 * one task into a sequence of smaller tasks. The model decides the breakdown —
 * the user does not hand-type the parts.
 */
export function buildSplitPrompt(taskId: string, tasks: Task[]): string {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return `Split task ${taskId} into smaller tasks.`;
  return [
    `Split task #${task.order} "${task.title}" (id=${task.id}) into multiple smaller tasks that together accomplish the same work.`,
    'Decompose it into a sensible ordered sequence. Write a clear title, description, and prompt for each part.',
    'The first part inherits the original task\'s dependencies. Each later part depends on the previous part. Tasks that depended on the original now depend on the LAST part.',
    'Set "assignedRunner" and "assignedModel" on each part — use the runners and models listed in <available_models> above. You may assign different models to different parts (e.g. a stronger model for a complex part, a faster one for a simple part).',
    'Reply with ONLY a taskOps JSON object using a single "split" op:',
    `  {"taskOps":[{"op":"split","taskId":"${task.id}","parts":[{"title":"...","description":"...","prompt":"...","assignedRunner":"...","assignedModel":{"modelId":"...","modelLabel":"..."}},...]}]}`,
    'If this split needs a companion op in the same batch (e.g. another task that should depend on the last part), give the split op a "handle" (any unused name) — it names the last part — and reference it from the later op\'s taskId/dependencies.',
  ].join('\n');
}
