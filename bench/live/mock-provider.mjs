#!/usr/bin/env node
/**
 * Cheap-model simulator: a local OpenAI-compatible /chat/completions server
 * that reproduces the formatting quirks of budget models (DeepSeek V4 Flash
 * class) so the planner conversation loop can be exercised end-to-end,
 * deterministically, and offline:
 *
 *   - `reasoning` deltas streamed before any content (long think time)
 *   - plan JSON wrapped in ```json fences with a trailing comma
 *   - prose preamble before the JSON ("Here is the plan:")
 *   - questions asked as plain prose (no tags — the loop must not need them)
 *   - an eager persona that ignores grilling and commits a plan immediately
 *   - an empty-content turn (some cheap models return "" after tool use)
 *
 * Personas are selected by the requested `model` id:
 *   mock/interviewer   grilling flow: explore → question → question → outline → fenced plan
 *   mock/eager-planner ignores interviewing and emits a plan on turn one
 *   mock/fenced-json   research (2 tools) → preamble + fenced JSON plan
 *   mock/prd-flow      PRD preview → marker-wrapped PRD → outline → plan
 *   mock/empty-turn    returns an empty assistant turn after one tool call
 *   mock/visibility    one parallel round mixing allowed, refused and out-of-scope calls
 *   mock/task-query-editor  reads a task's prompt via taskQuery, then edits it
 *                       from what the answer actually contained
 *   mock/desktop-e2e   a two-task plan on turn one whose prompts steer
 *                       bench/pipeline's fake-claude (the desktop app's
 *                       acceptance test, packages/desktop/e2e); a goal that
 *                       names DESKTOP_FIT_GOAL gets the widest cards instead
 *   mock/desktop-tour  the desktop tour's plan (DESKTOP_TOUR_PLAN): the
 *                       acceptance plan, then one card of each kind; the fit
 *                       goal gets the widest cards here too
 *
 * The five `mock/goal-*` personas are the kinds of goal the strategy step
 * teaches (#108), each replying with the plumbing its kind calls for:
 *   mock/goal-question  one read, then a prose answer and no plan
 *   mock/goal-effect    one `run_script` call, then a short confirmation
 *   mock/goal-build     a plan of three vertical slices, chained
 *   mock/goal-failure   a reproduction script task with a loop, two parallel
 *                       research tasks, and the fix in the loop's body
 *   mock/goal-open      a first round of two research tasks, no build
 * They are driven by `drive-conversation.mjs`, which asserts the session's
 * acceptance of each shape; the scenario table is GOAL_SCENARIOS in
 * scenarios.mjs.
 *
 * Usage: node bench/live/mock-provider.mjs [--port 3799] [--hold-file <path>]
 *
 * With --hold-file, a turn streams its reasoning and then waits while that file
 * exists, so a caller can look at the planner mid-turn (the desktop's visual
 * tour, packages/desktop/e2e/tour.spec.ts) and let it finish by deleting it.
 */
import fs from 'node:fs';
import http from 'node:http';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const port = Number(arg('--port') ?? 3799);
const holdFile = arg('--hold-file');

async function released() {
  while (holdFile && fs.existsSync(holdFile)) await new Promise((resolve) => setTimeout(resolve, 100));
}

const PLAN_JSON = (title) => JSON.stringify({
  tasks: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      order: 1,
      title,
      description: 'First slice',
      type: 'ai',
      dependencies: [],
      prompt: 'Do the first slice end to end. Touch src/index.ts.',
      assignedModel: { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash' },
      assignedRunner: 'claude-code',
      taskMode: 'acceptEdits',
      autonomy: 'AFK',
      sliceType: 'AFK',
      subtasks: [],
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      order: 2,
      title: 'Write docs',
      description: 'Document the feature',
      type: 'user',
      dependencies: ['11111111-1111-4111-8111-111111111111'],
      userSteps: [{ order: 1, instruction: 'Update README', completed: false }],
      assignedRunner: 'claude-code',
      taskMode: 'acceptEdits',
      autonomy: 'HITL',
      sliceType: 'HITL',
      subtasks: [],
    },
  ],
}, null, 2);

// Trailing comma before the closing brace — classic budget-model emission.
const FENCED_PLAN = (title) =>
  'Great — generating the plan now.\n```json\n' + PLAN_JSON(title).replace(/\n  \]\n\}$/, '\n  ],\n}') + '\n```';

/** A plan object as a budget model emits it: a preamble, then a ```json fence. */
const fence = (plan) => 'Here is the plan.\n```json\n' + JSON.stringify(plan, null, 2) + '\n```';

/** A goal-kind plan task, with the assignment fields every AI task needs. */
const aiTask = (over) => ({
  type: 'ai',
  assignedRunner: 'claude-code',
  assignedModel: { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash' },
  autonomy: 'AFK',
  sliceType: 'AFK',
  subtasks: [],
  ...over,
});

/** The build kind: three vertical slices of one flag, each standing on the last. */
const BUILD_PLAN = {
  tasks: [
    aiTask({
      id: 'build-flag', order: 1, title: 'Parse --verbose and print each file',
      description: 'The flag works end to end from the CLI entry point',
      dependencies: [], prompt: 'In src/index.ts add a --verbose flag to the existing argument parser, and in src/walk.ts print each file path the walker yields. Keep the default output unchanged.',
    }),
    aiTask({
      id: 'build-thread', order: 2, title: 'Thread --verbose through the file walk',
      description: 'The flag reaches the walker from the CLI',
      dependencies: ['build-flag'], prompt: 'In src/walk.ts accept a verbose option and inject it from src/index.ts. A test at test/walk.test.ts covers a nested directory.',
    }),
    aiTask({
      id: 'build-tests', order: 3, title: 'Test the verbose output',
      description: 'The flag has a test that fails without it',
      dependencies: ['build-thread'], prompt: 'Add test/verbose.test.ts: run the CLI with --verbose over a two-file fixture and assert both paths print in order. Run node --test.',
    }),
  ],
};

/**
 * The failure kind: the reproduction is the check of a loop whose body is the
 * fix, and two hypotheses run as research tasks in parallel while the planner
 * keeps talking. `h1`/`h2` are read-only, so they are approved to start as the
 * plan lands; the reproduction is not, because the user has not run the plan.
 */
const FAILURE_PLAN = {
  tasks: [
    {
      id: 'repro', order: 1, title: 'Reproduce the nested-array parse failure',
      description: 'The failing test is the reproduction', type: 'script', dependencies: [],
      commands: [['node', '--test', 'test/parser.test.mjs']], sliceType: 'AFK',
      loop: { body: ['fix'], maxRounds: 2 },
    },
    aiTask({
      id: 'h1', order: 2, title: 'Does the tokenizer split nested brackets?',
      description: 'Reports the evidence for and against one hypothesis', dependencies: [],
      prompt: 'Hypothesis: the tokenizer closes an array at the first ] even when nested. Reproduce `node --test test/parser.test.mjs`, then check src/parser/tokenizer.ts. Report whether it holds, with file paths and line numbers, and the command and output that settle it.',
      readOnly: true, research: true,
    }),
    aiTask({
      id: 'h2', order: 3, title: 'Does the parser treat a nested array as a delimiter?',
      description: 'Reports the evidence for and against the other hypothesis', dependencies: [],
      prompt: 'Hypothesis: the parser treats the inner [ of a nested array as the start of a new value. Reproduce `node --test test/parser.test.mjs`, then check src/parser/parse.ts. Report whether it holds, with file paths and line numbers, and the command and output that settle it.',
      readOnly: true, research: true,
    }),
    aiTask({
      id: 'fix', order: 4, title: 'Fix the cause the reports name',
      description: 'Makes the reproduction pass', dependencies: ['repro'],
      prompt: 'The reproduction and the research reports are in your prior task outputs. Fix the cause they name, in src/parser/, and change nothing else. Run node --test test/parser.test.mjs and report the result.',
    }),
  ],
};

/** The open-problem kind: one round, deliberately different questions, no build yet. */
const OPEN_PLAN = {
  tasks: [
    aiTask({
      id: 'open-approach', order: 1, title: 'Which sync architecture fits: full-state or op-log?',
      description: 'Compares the two candidate approaches on this codebase', dependencies: [],
      prompt: 'Compare a full-state sync and an op-log sync for src/sync/. Read the existing sync code and report: each approach\'s claim, the evidence for and against it in this codebase, what would break it, and the commands you ran. This is the first round; do not plan the build.',
      readOnly: true, research: true,
    }),
    aiTask({
      id: 'open-measure', order: 2, title: 'What does the current sync actually cost?',
      description: 'Measures the present path before either approach is chosen', dependencies: [],
      prompt: 'Measure the current sync path in src/sync/ rather than argue about it: count round trips and bytes for a representative change, in a test or a script. Report the method, the numbers with the command that produced them, and what would make the measurement wrong.',
      readOnly: true, research: true,
    }),
  ],
};

/**
 * The desktop acceptance plan, steering bench/pipeline's fake-claude by cue:
 * the first task writes a file, then holds its turn open until a message
 * reaches it (the test's line comment on that file) and passes; the second,
 * once it has, raises a checkpoint, so the run has a Needs you item to answer,
 * then writes its own.
 */
const fakeClaude = (cue) => `<fake-claude>${JSON.stringify(cue)}</fake-claude>`;
const DESKTOP_E2E_PLAN = {
  tasks: [
    aiTask({
      id: 'desktop-greeting', order: 1, title: 'Add a greeting module',
      description: 'Adds src/greeting.ts', dependencies: [], taskMode: 'acceptEdits',
      prompt: 'Add src/greeting.ts exporting a greeting.\n' + fakeClaude({
        write: { 'src/greeting.ts': "export const greeting = 'hello from the desktop e2e';\n" },
        awaitMessage: true,
        summary: 'Added src/greeting.ts exporting a greeting.',
      }),
    }),
    aiTask({
      id: 'desktop-farewell', order: 2, title: 'Add a farewell module',
      description: 'Adds src/farewell.ts after asking first', dependencies: ['desktop-greeting'], taskMode: 'acceptEdits',
      prompt: 'Ask before you add src/farewell.ts exporting a farewell.\n' + fakeClaude({
        calls: [['checkpoint', { question: 'Write the farewell module now?' }]],
        write: { 'src/farewell.ts': "export const farewell = 'goodbye from the desktop e2e';\n" },
        summary: 'Added src/farewell.ts exporting a farewell.',
      }),
    }),
  ],
};

/**
 * The desktop tour's plan: the acceptance plan's two tasks, then one of each
 * kind of card the graph draws, with long titles and long model names. Each
 * waits behind #2, which the tour leaves waiting for merge, so none runs and
 * the run's own states stay those of the acceptance plan. None is research:
 * a research task starts while the plan is still a draft, and the run would
 * then offer Stop where the tour approves. The tour detects
 * only Claude Code, so the long OpenCode-style model id rides on it.
 */
const DESKTOP_TOUR_PLAN = {
  tasks: [
    ...DESKTOP_E2E_PLAN.tasks,
    aiTask({
      id: 'tour-port', order: 3, title: 'Port the tokenizer to the streaming parser and keep every existing fixture passing',
      description: 'A long title on a long model id with a provider prefix', dependencies: ['desktop-farewell'],
      assignedModel: { modelId: 'opencode-go/deepseek-v4.1-flash', modelLabel: 'opencode-go/deepseek-v4.1-flash', thinkingEffort: 'high' },
      prompt: 'Port src/tokenizer.ts to the streaming parser.',
    }),
    aiTask({
      id: 'tour-survey', order: 4, title: 'Survey how other parsers recover from a truncated document',
      description: 'A read-only task on the largest effort', dependencies: ['desktop-farewell'], taskMode: 'plan',
      assignedModel: { modelId: 'opus', modelLabel: 'opus', thinkingEffort: 'xhigh' },
      prompt: 'Report how three parsers recover from a truncated document.', readOnly: true,
    }),
    {
      id: 'tour-check', order: 5, title: 'Run the parser suite', description: 'The check of a loop', type: 'script',
      dependencies: ['desktop-farewell'], commands: [['npm', 'test', '--', '--run', 'test/parser']], sliceType: 'AFK',
      loop: { body: ['tour-fix'], maxRounds: 3 },
    },
    aiTask({
      id: 'tour-fix', order: 6, title: 'Fix what the suite reports', description: 'The body of the loop',
      dependencies: ['tour-check'], taskMode: 'acceptEdits', prompt: 'Fix what the parser suite reports.',
    }),
    aiTask({
      id: 'tour-release', order: 7, title: 'Open the release pull request', description: 'An ops task with a human in the loop',
      dependencies: ['tour-check'], ops: true, autonomy: 'HITL', sliceType: 'HITL', prompt: 'Open the release pull request.',
    }),
    {
      id: 'tour-sign', order: 8, title: 'Sign off the release notes', description: 'A manual task', type: 'user',
      dependencies: ['tour-release'], userSteps: [{ order: 1, instruction: 'Read and sign the release notes', completed: false }],
      autonomy: 'HITL', sliceType: 'HITL', subtasks: [],
    },
  ],
};

/**
 * The tour's third launch, which enables all eight agents: the acceptance
 * plan's first task, then one task on each of the five newer agents, so the
 * plan panel and the graph draw every runner's badge. No model is named, since
 * none of those agents is installed there to list its models.
 */
const DESKTOP_TOUR_RUNNERS_PLAN = {
  tasks: [
    DESKTOP_E2E_PLAN.tasks[0],
    ...[
      ['copilot-cli', 'Review the parser change with Copilot'],
      ['qwen-code', 'Draft the migration notes with Qwen Code'],
      ['cline', 'Tidy the fixtures with Cline'],
      ['gemini-cli', 'Summarise the changelog with Gemini'],
      ['cursor-agent', 'Rename the helpers with Cursor'],
    ].map(([runner, title], i) => aiTask({
      id: `tour-${runner}`, order: 2 + i, title, description: `A task on ${runner}`, dependencies: [DESKTOP_E2E_PLAN.tasks[0].id],
      assignedRunner: runner, assignedModel: undefined, prompt: `${title}.`,
    })),
  ],
};

/**
 * The plan cards at their widest, for the desktop tour's overflow probe: long
 * titles, a long model with its effort, a loop's check and body, Research,
 * Ops, and a prompt with a path that has nowhere to break. It is never run.
 */
const DESKTOP_FIT_GOAL = 'Check that the plan cards fit';
const DESKTOP_FIT_PLAN = {
  tasks: [
    {
      id: 'fit-check', order: 1, title: 'Run the reconnect suite until the lease heartbeat survives a daemon restart',
      description: 'The failing suite is the check', type: 'script', dependencies: [],
      commands: [['node', '--test', 'packages/desktop/src/renderer/session/__tests__/reconnectAfterDaemonRestart.test.mjs']], sliceType: 'AFK',
      loop: { body: ['fit-fix'], maxRounds: 3 },
    },
    aiTask({
      id: 'fit-fix', order: 2,
      title: 'Find why the session lease heartbeat outlives the window that holds it after a reconnect with backoff',
      description: 'Makes the reconnect suite pass', dependencies: ['fit-check'],
      assignedRunner: 'claude-code',
      assignedModel: { modelId: 'opencode-go/deepseek-v4.1-flash', thinkingEffort: 'high' },
      prompt: 'Read packages/desktop/src/renderer/session/DaemonConnectionReconnectBackoffSupervisor.ts and clear the heartbeat timer where the window lets go of its lease.\nThen check every caller.',
    }),
    aiTask({
      id: 'fit-research', order: 3, title: 'Which of the daemon restart paths keeps the old lease heartbeat timer alive past its window?',
      description: 'Reports the evidence for one hypothesis', dependencies: ['fit-check'],
      prompt: 'Hypothesis: the restart path re-arms the timer before it clears the old one.', readOnly: true, research: true,
    }),
    aiTask({
      id: 'fit-ops', order: 4, title: 'Restart the shared development daemon on every workstation that still runs the old heartbeat',
      description: 'Changes no repository files', dependencies: ['fit-check'], ops: true,
      prompt: 'Restart the daemon.',
    }),
  ],
};

function toolCallTurn(name, args) {
  return { toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args: JSON.stringify(args) }] };
}

/** Fixed ids, so a test can assert a result landed on the call that announced it. */
function parallelToolTurn(calls) {
  return { toolCalls: calls.map(([id, name, args]) => ({ id, name, args: JSON.stringify(args) })) };
}

/** Count how many user turns arrived after the system prompt (tool msgs excluded). */
function shape(messages) {
  const users = messages.filter((m) => m.role === 'user').length;
  const lastRole = messages[messages.length - 1]?.role;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const toolRounds = messages.filter((m) => m.role === 'assistant' && m.tool_calls).length;
  return { users, lastRole, lastUser: String(lastUser), toolRounds };
}

/** The widest cards, for a session whose goal names DESKTOP_FIT_GOAL and that has no plan yet. */
function fitTurn(messages) {
  // The fit goal comes after a run, into a session whose context may already hold a skill load or a run's record.
  const planned = messages.some((m) => m.role === 'assistant' && String(m.content ?? '').includes('"tasks"'));
  if (planned || !messages.some((m) => m.role === 'user' && String(m.content ?? '').includes(DESKTOP_FIT_GOAL))) return undefined;
  return { reasoning: 'The widest cards. ', content: fence(DESKTOP_FIT_PLAN) };
}

function scriptTurn(model, messages) {
  const persona = model.split('/')[1] ?? model;
  const s = shape(messages);

  if (persona === 'eager-planner') {
    // Ignores the grilling instructions entirely — commits a plan turn one.
    return { reasoning: 'The goal seems clear enough, skipping questions. ', content: FENCED_PLAN('Eagerly planned slice') };
  }

  if (persona === 'desktop-e2e') {
    const fit = fitTurn(messages);
    if (fit) return fit;
    // Only the goal gets the plan: a supervisor's wake-up turn refuses plan edits.
    if (messages.some((m) => m.role === 'assistant')) return { content: 'Noted. Nothing to change.' };
    return { reasoning: 'Two small slices. ', content: fence(DESKTOP_E2E_PLAN) };
  }

  if (persona === 'desktop-tour-runners') {
    if (messages.some((m) => m.role === 'assistant')) return { content: 'Noted. Nothing to change.' };
    return { reasoning: 'One task on each newer agent. ', content: fence(DESKTOP_TOUR_RUNNERS_PLAN) };
  }

  if (persona === 'desktop-tour') {
    const fit = fitTurn(messages);
    if (fit) return fit;
    if (messages.some((m) => m.role === 'assistant')) return { content: 'Noted. Nothing to change.' };
    return { reasoning: 'Two small slices, then the release. ', content: fence(DESKTOP_TOUR_PLAN) };
  }

  if (persona === 'empty-turn') {
    if (s.toolRounds === 0) return { reasoning: 'Let me look around first. ', ...toolCallTurn('list_dir', { path: '.', depth: 2 }) };
    return { content: '' };
  }

  if (persona === 'visibility') {
    if (s.toolRounds === 0) {
      return {
        reasoning: 'Reading two files at once, and trying a couple of things I probably may not do. ',
        ...parallelToolTurn([
          ['vc-1', 'read_file', { path: 'README.md' }],
          ['vc-2', 'read_file', { path: 'src/index.ts' }],
          ['vc-3', 'bash', { command: 'rm -rf build' }],
          ['vc-4', 'read_file', { path: '/etc/passwd' }],
        ]),
      };
    }
    return { content: 'Some lookups were not allowed. **Question**: how should I proceed?' };
  }

  if (persona === 'task-query-editor') {
    // A scripted stand-in for "read before you edit": it never assumes what a
    // task's prompt says, it asks (the taskQuery envelope), and only emits an
    // edit once the answer — carrying a marker the plan context block never
    // includes — has actually come back on a prior user turn.
    const seen = messages.map((m) => String(m.content ?? '')).join('\n');
    const marker = seen.match(/MARKER-[A-Z0-9]+/)?.[0];
    if (!marker) {
      return { content: JSON.stringify({ taskQuery: { tasks: ['#2'], fields: ['prompt'] } }) };
    }
    return { content: JSON.stringify({ taskOps: [{ op: 'update', taskId: '#2', changes: { description: `read-confirmed:${marker}` } }] }) };
  }

  if (persona === 'goal-question') {
    // A question the research answers: one read, then prose. No plan, no tag.
    if (s.toolRounds === 0) return { reasoning: 'Read the README before answering; the goal is a question, not a plan. ', ...toolCallTurn('read_file', { path: 'README.md' }) };
    return {
      content: 'The demo project is a tiny app: `src/index.ts` prints a line and the README describes it, with a TODO for tests. There is no test suite checked in, so the TODO is still open. Nothing needs a plan for that answer.',
    };
  }

  if (persona === 'goal-effect') {
    // A small effect stated as exact commands: one script task through run_script.
    if (s.toolRounds === 0) {
      return {
        reasoning: 'One exact command, no files to change: run it as a script task. ',
        ...toolCallTurn('run_script', { title: 'Emit the completion marker', commands: [['node', '-e', "process.stdout.write('effect-ok')"]] }),
      };
    }
    return { content: 'Done: the marker command ran as a script task, and its output is in the task log.' };
  }

  if (persona === 'goal-build') {
    if (s.toolRounds === 0) return { reasoning: 'Ground the build in the real layout first. ', ...toolCallTurn('read_file', { path: 'README.md' }) };
    return { reasoning: 'Three vertical slices, each standing on the last. ', content: fence(BUILD_PLAN) };
  }

  if (persona === 'goal-failure') {
    if (s.toolRounds === 0) return { reasoning: 'Look at the failing area before planning reproduction. ', ...toolCallTurn('list_dir', { path: 'src', depth: 2 }) };
    return {
      reasoning: 'The reproduction is a command, so it is the loop check; two hypotheses run as research tasks; the fix is the loop body. ',
      content: fence(FAILURE_PLAN),
    };
  }

  if (persona === 'goal-open') {
    if (s.toolRounds === 0) return { reasoning: 'The problem has no known path: only the first round is plannable. ', ...toolCallTurn('list_dir', { path: 'src', depth: 2 }) };
    return { reasoning: 'Two deliberately different questions, no build yet. ', content: fence(OPEN_PLAN) };
  }

  if (persona === 'fenced-json') {
    if (s.toolRounds === 0) return { reasoning: 'I should read the README to ground the plan. ', ...toolCallTurn('read_file', { path: 'README.md' }) };
    if (s.toolRounds === 1) return { ...toolCallTurn('grep', { pattern: 'TODO', include: '*.md' }) };
    return { reasoning: 'Research done, emitting the plan. ', content: FENCED_PLAN('Fenced plan slice') };
  }

  if (persona === 'prd-flow') {
    if (s.users === 1 && s.toolRounds === 0) return { reasoning: 'Exploring before the PRD preview. ', ...toolCallTurn('list_dir', { path: '.', depth: 2 }) };
    if (s.users === 1) {
      return { content: 'Here is a short preview before the full PRD.\n\n**Problem**: the demo app lacks a widget.\n**Approach**: add a widget module.\n**Testing seams**: unit tests around widget.ts.\n**Risks**: none notable.\n\nProposed feature-slug: `demo-widget`. Do you agree with this preview?' };
    }
    if (s.users === 2) {
      return {
        content: 'Writing the full PRD now.\n\n<!-- ORDEWELL_PRD_START slug="demo-widget" -->\n# PRD: Demo Widget\n\n## Problem\nThe demo app lacks a widget.\n\n## User stories\n- As a user, I want a widget so that I can widget.\n\n## Implementation decisions\n- Add `src/widget.ts`.\n\n## Testing seams\n- Unit tests in `src/widget.test.ts`.\n\n## Out of scope\n- Widget theming.\n<!-- ORDEWELL_PRD_END -->\n\nNext, here is the outline:\n1. Add widget module (src/widget.ts)\n2. Document it\n\nConfirm to generate the task plan.',
      };
    }
    return { content: FENCED_PLAN('Add widget module') };
  }

  // default: interviewer (grilling flow)
  if (s.users === 1 && s.toolRounds === 0) {
    return { reasoning: 'Vague goal. Explore the workspace before asking anything. ', ...toolCallTurn('list_dir', { path: '.', depth: 2 }) };
  }
  if (s.users === 1) {
    return {
      reasoning: 'The repo is a tiny demo. The goal "make it better" could mean performance, UX, or code health. Ask one question with a recommendation. ',
      content: 'Looking at the repo, "make it better" could go several ways.\n\n**Question**: should I focus on code health (tests, types) or user-facing behavior?\n\nMy recommendation: code health first — the project has no tests at all.',
    };
  }
  if (s.users === 2) {
    return {
      content: '**Question**: for the test setup, do you prefer node:test (zero deps) or vitest?\n\nMy recommendation: node:test, matching the bench harness convention.',
    };
  }
  if (s.users === 3) {
    return {
      content: 'I believe we share an understanding now. Outline:\n\n1. Set up node:test and a first unit test (src/index.test.ts)\n2. Write docs\n\nReply "confirm" and I will emit the task plan.',
    };
  }
  return { reasoning: 'User confirmed. Emitting the final JSON. ', content: FENCED_PLAN('Set up node:test harness') };
}

function sseChunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const { model, messages } = parsed;
    const turn = scriptTurn(model ?? 'mock/interviewer', messages ?? []);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    // Stream reasoning first (in small chunks, like a real reasoning model)...
    if (turn.reasoning) {
      for (const piece of turn.reasoning.match(/.{1,12}/gs) ?? []) {
        res.write(sseChunk({ reasoning: piece }));
      }
    }
    await released();
    // ...then content...
    if (turn.content) {
      for (const piece of turn.content.match(/.{1,24}/gs) ?? []) {
        res.write(sseChunk({ content: piece }));
      }
    }
    // ...then tool calls, arguments split across chunks.
    if (turn.toolCalls) {
      turn.toolCalls.forEach((tc, index) => {
        res.write(sseChunk({ tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: '' } }] }));
        for (const piece of tc.args.match(/.{1,10}/gs) ?? []) {
          res.write(sseChunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
        }
      });
    }
    res.write(sseChunk({}, turn.toolCalls ? 'tool_calls' : 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${port}/v1`);
});
