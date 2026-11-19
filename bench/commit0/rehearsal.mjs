/**
 * The Commit0 rehearsal's scripts: what the scripted fake provider answers
 * the planner, the built-in runner and the supervisor in each scenario, and
 * what each scenario's result.json must then say. Pure, so the fake (in the
 * box), the driver, rehearse.mjs and the unit tests share one copy; zero
 * dependencies, since the box mounts this directory and runs it on its node.
 *
 * A rehearsal runs both arms as a paid run does, through the same code, with
 * the model replaced: the driver's following, stopping and scoring of a live
 * run are what it proves, never a model's ability.
 */

export const FAKE_DIR_IN_BOX = '/opt/commit0-fake';
export const FAKE_SERVER = 'rehearsal-fake.mjs';
export const FAKE_PORT = 3799;
export const FAKE_LOG_IN_BOX = '/tmp/commit0-rehearsal-requests.jsonl';
/** The value the box's key holds: core lists and calls only a provider it holds a key for. */
export const FAKE_KEY = 'not-a-real-key';
/** The reference source, put in the box after the leak probe, for the scripted agent to "write". */
export const REFERENCE_TAR_IN_BOX = '/tmp/commit0-rehearsal-reference.tar';
export const REHEARSAL_MODULE = '_commit0_rehearsal';
export const REHEARSAL_TEST = 'test_commit0_rehearsal_edit';
const READY = 'rehearsal fake listening on';
export const FAKE_READY = new RegExp(`${READY} http://127\\.0\\.0\\.1:(\\d+)/v1`);
export const readyLine = (port) => `${READY} http://127.0.0.1:${port}/v1`;
/** Every model call is priced at this unless a step says otherwise, so the recorded spend is never empty. */
export const TURN_COST_USD = 0.0001;

/**
 * Names of variables in `env` that hold a real credential. A rehearsal
 * refuses to start with any set: the fake is the only provider it may reach.
 */
export function realKeysIn(env) {
  return Object.keys(env)
    .filter((k) => /(^|_)(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN)$/.test(k) || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN')
    .filter((k) => env[k] && env[k] !== FAKE_KEY)
    .sort();
}

/** How long the scripted long command runs: past the settle window by more than two polls. */
export function longCommandSec({ settleMin, pollSec }) {
  return Math.ceil(settleMin * 60 + 2 * pollSec + 15);
}

// --- What the scripted agent does -------------------------------------------

const shell = (command, extra = {}) => ({ tool: 'shell', args: { command, ...extra } });

/** The work a task's attempt does: the long command, then a source edit, a new module and a test edit. */
export function editSteps({ src, tests }) {
  return [
    // The reference source stands in for a model's implementation: it is what makes the tests pass.
    shell(`tar -xf ${REFERENCE_TAR_IN_BOX} && git status --short | head -n 5`),
    { tool: 'write', args: { path: `${src}/${REHEARSAL_MODULE}.py`, content: 'VALUE = 1\n' } },
    // The package imports the new module, so scoring that leaves the module out breaks every import.
    shell(`printf '\\nfrom . import ${REHEARSAL_MODULE}\\n' >> ${src}/__init__.py`),
    shell(`f=$(find ${tests} -name 'test_*.py' | sort | head -n 1) && printf '\\n\\ndef ${REHEARSAL_TEST}():\\n    pass\\n' >> "$f" && echo "$f"`),
  ];
}

export const longStep = (sec) => shell(`sleep ${sec} && echo slept ${sec}s`, { timeout: (sec + 120) * 1000 });

const done = (subject, extra = {}) => ({ tool: 'task_complete', args: { status: 'done', summary: `${subject}.`, commit: { subject }, ...extra } });
const failed = (why) => ({ tool: 'task_complete', args: { status: 'failed', summary: why, reason: why } });

const checkpoint = (question) => ({ tool: 'checkpoint', args: { question } });
/** A file outside the library and its tests: work that lands without moving the score. */
const note = (file) => ({ tool: 'write', args: { path: file, content: 'Written by the rehearsal.\n' } });

/**
 * The heading of the block a change task is told when siblings land work
 * beside it (core's renderLandingBeside), and the merge command that block
 * gives, as the sentence in it carries it: `take it in with \`<command>\``.
 */
export const LANDING_HEADING = '## Work landing beside yours';
export const TAKE_IN = /take it in with `([^`]+)`/;
/** The subject of the merge that command makes (core's takeInMessage). */
export const TAKE_IN_SUBJECT = /^Merge: .+ \(take in landed work\)$/;
/** A shell step whose command the fake reads out of the task's own first user message: its first capture. */
const fromPrompt = (pattern) => ({ tool: 'shell', fromPrompt: pattern, exit0: true });
const CONSUMER_NOTE = 'commit0-rehearsal-consumer.md';
const CONSUMER_COMMIT = 'Note the rehearsal consumer';

/** Deterministic task ids, so a plan and its dependencies read back the same on every run. */
const taskId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Arm B's plan, as the planner emits it: one task per entry of `tasks`
 * ({ key, title, after?, kind?, loopBody? }), each on the bench's runner and
 * model in full mode, its prompt carrying the `[rehearsal:<key>]` the fake
 * routes its attempts by. `kind` makes a task something else: 'research' (a
 * read-only AI task), 'ops', or 'script' (which has no runner, model or
 * prompt); `loopBody` (keys) makes it a loop's check over those tasks.
 */
export function rehearsalPlan(tasks) {
  const order = new Map(tasks.map((t, i) => [t.key, i + 1]));
  return {
    tasks: tasks.map((t, i) => {
      const common = {
        id: taskId(i + 1), order: i + 1, title: t.title, description: t.title,
        dependencies: (t.after ?? []).map((k) => taskId(order.get(k))),
        sliceType: 'AFK',
        ...(t.loopBody ? { loop: { body: t.loopBody.map((k) => taskId(order.get(k))), maxRounds: 2 } } : {}),
      };
      // A script task's body is a list of argument vectors; nothing about it is a runner's.
      if (t.kind === 'script') return { ...common, type: 'script', commands: [['python', '-m', 'pytest', '-q']] };
      return {
        ...common, type: 'ai', prompt: `${t.title}. [rehearsal:${t.key}]`,
        assignedRunner: 'openrouter',
        assignedModel: { modelId: 'openrouter:deepseek/deepseek-v4.1-flash', modelLabel: 'DeepSeek V4.1 Flash' },
        taskMode: 'full', autonomy: 'AFK', subtasks: [],
        ...(t.kind === 'research' ? { readOnly: true, research: true } : {}),
        ...(t.kind === 'ops' ? { ops: true } : {}),
      };
    }),
  };
}

// Fresh, so the attempt opens a new runner conversation the fake counts as attempt 2; a session retry would continue attempt 1's.
/**
 * A task's line in the plan a wake-up turn shows (`#2 id=… "title" [awaiting_user] …`):
 * the turn's protocol text names checkpoints and failures too, so only a
 * task's own status is an event. A checkpoint leaves its task awaiting_user.
 */
export const taskIs = (n, status) => new RegExp(`^#${n} id=\\S+ "[^"\\n]*" \\[${status}\\]`, 'm');

const RETRY = { tool: 'retry_task', args: { task: '#1', from: 'fresh', message: 'The rehearsal retries this once: make the edits again and report done.' } };
/**
 * The edit the closing turn makes to the failed task: its prompt changes (the
 * key stays, which routes the fake) and nothing is retried. The built-in
 * planner has no edit_plan tool, so an edit is a reply that carries the task
 * ops as JSON, as a real run's supervisor sent it.
 */
const EDIT_REPLY = `The rehearsal edits task #1 and retries nothing.\n\`\`\`json\n${JSON.stringify({ taskOps: [{ op: 'update', taskId: '#1', changes: { prompt: 'Implement the library, and this time make the edits and report done. [rehearsal:edit]' } }] }, null, 2)}\n\`\`\``;
/** What the second wake, raised for a failure the closing turn left standing, is told (core's standingDetail). */
const STILL_FAILED = /is still failed after your turn/;
const APPROVE = { tool: 'answer_checkpoint', args: { task: '#2', answer: 'approve', reason: 'Follow the tests.' } };
const FAILS_ON_PURPOSE = 'The rehearsal fails this task on purpose.';
const LEFT_PLAN = [
  { key: 'edit', title: 'Implement the library' },
  { key: 'after', title: 'Note the rehearsal', after: ['edit'] },
];

/**
 * The plan b-plan makes: a research task everything follows, a change on it, a
 * script that checks it as a loop's check over a fix, an ops task beside the
 * change, and a last change that waits on the check (a loop's body is waited on by nothing outside it) and the ops task. Task 1
 * gates the rest; the chain is 1, 2, 3, 4.
 */
const SHAPED_PLAN = [
  { key: 'survey', title: 'Survey the stubs', kind: 'research' },
  { key: 'edit', title: 'Implement the library', after: ['survey'] },
  { key: 'check', title: 'Run the test suite', kind: 'script', after: ['edit'], loopBody: ['fix'] },
  { key: 'fix', title: 'Fix what the suite finds', after: ['check'] },
  { key: 'tidy', title: 'Tidy the workspace', kind: 'ops', after: ['survey'] },
  { key: 'final', title: 'Write the closing note', after: ['check', 'tidy'] },
];

/**
 * Each scenario: the arm it runs, its scripted attempts per task (by the key
 * a task's prompt carries, or `A` for arm A's one task), and what its
 * result.json must hold. `ctx` is { src, tests, longSec }.
 */
export const SCENARIOS = Object.freeze({
  'b-plan': {
    arm: 'B',
    planOnly: true,
    about: 'arm B, --plan-only: the planner returns a six-task plan of every kind, its shape is recorded, and nothing runs, merges or is scored',
    plan: () => rehearsalPlan(SHAPED_PLAN),
    // What the harness must say of the plan above; the unit tests hold the shape function to its own cases.
    expect: {
      shape: {
        tasks: 6, subtasks: 0, kinds: { research: 1, change: 3, ops: 1, script: 1, user: 0, delegated: 0 }, loopChecks: 1, edges: 6,
        levels: 4, longestChain: 4, chain: ['Survey the stubs', 'Implement the library', 'Run the test suite', 'Fix what the suite finds'],
        widestLevel: 2, gatedByOne: true, gate: 'Survey the stubs', valid: true, problems: [],
      },
    },
  },
  'a-done': {
    arm: 'A',
    about: 'arm A: its one task makes the edits and reports done; `ordewell run` returns by itself',
    attempts: (ctx) => ({ A: [[...editSteps(ctx), done('Implement the library')]] }),
    ending: { by: 'completion', status: 'done', reason: null, calls: true },
    expect: { valid: true, runExit: 0, truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 1 } },
    playedOut: ['A'],
  },
  'a-failed': {
    arm: 'A',
    about: 'arm A: one shell command outlasts the settle window, then the edits, then the task reports failed; scored from its unlanded worktree',
    attempts: (ctx) => ({ A: [[longStep(ctx.longSec), ...editSteps(ctx), failed('The rehearsal fails this task on purpose.')]] }),
    ending: { by: 'completion', status: 'failed', reason: FAILS_ON_PURPOSE, calls: true },
    expect: {
      valid: true, scoredFrom: 'task-worktree', truncated: true, truncatedWhy: /^settled with 1 task open: 1 nothing ready/,
      stoppedWhy: null, passedAboveBaseline: true, testExcluded: true, tasks: { failed: 1 },
    },
    playedOut: ['A'],
  },
  'a-stall': {
    arm: 'A',
    about: 'arm A: the task makes the edits, then asks a checkpoint nobody answers: the stall rule ends the run, scored from its unlanded worktree',
    attempts: (ctx) => ({ A: [[...editSteps(ctx), checkpoint('Two docstrings disagree with the tests: may I follow the tests?'), done('Implement the library')]] }),
    ending: { by: 'stall', calls: true },
    expect: {
      valid: true, scoredFrom: 'task-worktree', truncated: true, truncatedWhy: /^stalled: waiting on checkpoint/, stoppedWhy: null, stalled: true,
      notComplete: true, passedAboveBaseline: true, testExcluded: true,
    },
    cutShort: ['A'],
  },
  'b-retry': {
    arm: 'B',
    about: 'arm B: task 1 fails while task 2 waits on it; the supervisor at Act retries it, answers task 2\'s checkpoint, and the run completes; scored from merged work',
    plan: () => rehearsalPlan(LEFT_PLAN),
    attempts: (ctx) => ({
      edit: [[...editSteps(ctx), failed(FAILS_ON_PURPOSE)], [...editSteps(ctx), done('Implement the library')]],
      after: [[checkpoint('Two docstrings disagree with the tests: may I follow the tests?'), note('commit0-rehearsal-note.md'), done('Note the rehearsal')]],
    }),
    supervisor: [{ when: taskIs(1, 'failed'), step: RETRY }, { when: taskIs(2, 'awaiting_user'), step: APPROVE }],
    ending: { by: 'completion', status: 'done', reason: null },
    expect: { valid: true, scoredFrom: 'merged', truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 2 } },
    playedOut: ['edit', 'after'],
    supervised: ['retry_task', 'answer_checkpoint'],
    supervision: { acts: ['retry_task', 'answer_checkpoint'], closingWakes: 0 },
  },
  'b-leave': {
    arm: 'B',
    about: 'arm B: task 1 fails while task 2 waits on it; the supervisor at Act leaves it, so the run is held and ends by the stall rule, never complete',
    plan: () => rehearsalPlan(LEFT_PLAN),
    attempts: (ctx) => ({ edit: [[...editSteps(ctx), failed(FAILS_ON_PURPOSE)]], after: [[note('commit0-rehearsal-note.md'), done('Note the rehearsal')]] }),
    // The closing turn leaves it, and so does the one core raises for the failure left standing: no third wake follows.
    supervisor: [{ when: STILL_FAILED, say: 'The rehearsal leaves task #1 failed.' }],
    // Nothing landed: arm B scores merged work, which the failed task's never became.
    ending: { by: 'completion', status: 'failed', reason: FAILS_ON_PURPOSE },
    expect: {
      scoredFrom: 'merged', truncated: true, truncatedWhy: /^settled with 2 tasks open/, stoppedWhy: null, stalled: true, heldOpen: 2,
      notComplete: true, passedAtBaseline: true, tasks: { failed: 1, completed: 0 },
    },
    playedOut: ['edit'],
    spoke: [/leaves task #1 failed/],
    supervision: { acts: [], closingWakes: 1 },
  },
  'b-edit-retry': {
    arm: 'B',
    about: 'arm B: task 1 fails; the supervisor\'s closing turn edits it and retries nothing; the second wake, for the failure left standing, retries it; the run goes on to its end and the work is merged and scored',
    plan: () => rehearsalPlan(LEFT_PLAN),
    attempts: (ctx) => ({
      edit: [[...editSteps(ctx), failed(FAILS_ON_PURPOSE)], [...editSteps(ctx), done('Implement the library')]],
      after: [[note('commit0-rehearsal-note.md'), done('Note the rehearsal', { findings: [{ severity: 'info', title: 'The rehearsal ends this task done with a finding' }] })]],
    }),
    // Order matters: the closing turn's wake holds both texts, and each rule plays once, the edit first.
    supervisor: [{ when: taskIs(1, 'failed'), say: EDIT_REPLY }, { when: STILL_FAILED, step: RETRY }],
    ending: { by: 'completion', status: 'done', reason: null },
    expect: { valid: true, scoredFrom: 'merged', truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 2 } },
    playedOut: ['edit', 'after'],
    // A task that ends done with a finding still lands: its note is in the merged work.
    landed: ['commit0-rehearsal-note.md'],
    supervised: ['retry_task'],
    spoke: [/edits task #1 and retries nothing/],
    supervision: { acts: ['plan_edit', 'retry_task'], closingWakes: 1, retryAfterWake: true },
  },
  'b-take-in': {
    arm: 'B',
    about: 'arm B: two tasks side by side; the producer lands its edits while the consumer runs a long step, then the consumer takes that work in with the merge command its own first message gives, and lands too',
    plan: () => rehearsalPlan([{ key: 'producer', title: 'Implement the library' }, { key: 'consumer', title: 'Build on the library' }]),
    attempts: (ctx) => ({
      producer: [[...editSteps(ctx), done('Implement the library')]],
      // The consumer commits its own work first, as its message says to: with nothing of its own the merge would be a fast-forward and leave no merge commit to find.
      consumer: [[
        longStep(ctx.longSec),
        note(CONSUMER_NOTE),
        { ...shell(`git add ${CONSUMER_NOTE} && git commit -q -m '${CONSUMER_COMMIT}' && git log --oneline | head -n 3`), exit0: true },
        fromPrompt(TAKE_IN),
        // What the producer made is in the consumer's worktree now.
        { ...shell(`test -f ${ctx.src}/${REHEARSAL_MODULE}.py && echo taken in`), exit0: true },
        done('Build on the library'),
      ]],
    }),
    ending: { by: 'completion', status: 'done', reason: null },
    expect: { valid: true, scoredFrom: 'merged', truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 2 } },
    playedOut: ['producer', 'consumer'],
    takeIn: { key: 'consumer', ownSubject: CONSUMER_COMMIT, landed: 'Implement the library' },
  },
  'b-cap': {
    arm: 'B',
    about: 'arm B: task 1 lands its edits, then task 2 reports usage past the spend cap mid-attempt: the stop, the merge and the scoring all happen',
    capUsd: 0.5,
    plan: () => rehearsalPlan([{ key: 'edit', title: 'Implement the library' }, { key: 'spend', title: 'Spend past the cap', after: ['edit'] }]),
    attempts: (ctx) => ({
      edit: [[...editSteps(ctx), done('Implement the library')]],
      spend: [[{ ...shell('echo spending'), costUsd: 1 }, longStep(ctx.longSec), done('Spend past the cap')]],
    }),
    ending: { by: 'cap', cap: 'spend' },
    expect: {
      valid: true, scoredFrom: 'merged', truncated: true, truncatedWhy: /^cap: spend/, stoppedWhy: 'spend', runStopped: true, mergeExit: 0,
      passedAboveBaseline: true, testExcluded: true, tasks: { completed: 1 },
    },
    playedOut: ['edit'],
    cutShort: ['spend'],
  },
});

export const scenarioNames = () => Object.keys(SCENARIOS);

/** The windows a rehearsal runs under, short enough for minutes; a scenario may set its own. */
export const WINDOWS = Object.freeze({ settleMin: 1, pollSec: 5, noStartMin: 3, stallMin: 2, wallMin: 25 });

/** drive.mjs's options for a scenario's windows and cap. */
export function windowArgs(s) {
  const w = { ...WINDOWS, ...(s.windows ?? {}) };
  return [
    '--settle-min', String(w.settleMin), '--poll-sec', String(w.pollSec), '--no-start-min', String(w.noStartMin),
    '--stall-min', String(w.stallMin), '--wall-min', String(w.wallMin), ...(s.capUsd ? ['--cap-usd', String(s.capUsd)] : []),
  ];
}

/** One line on what a result.json holds, for the rehearsal's log. */
export function describeResult(r) {
  if (!r) return 'no result.json';
  if (r.planOnly) {
    const sh = r.planned?.shape;
    return `plan-only (never valid); ${sh ? `${sh.tasks} tasks, chain ${sh.longestChain}, widest level ${sh.widestLevel}, ${sh.edges} edges` : 'no plan'}; planner $${r.planned?.plannerUsd ?? '-'}, ${r.planned?.planningMs ?? '-'} ms`;
  }
  const t =r.truncated?.truncated ? `truncated (${r.truncated.why})` : 'not truncated';
  return `valid ${r.valid}; scored from ${r.scoredFrom}; ${t}; stopped ${r.stopped?.why ?? 'by nothing'}; `
    + `tasks ${JSON.stringify(taskCounts(r.tasks))}; passed ${r.tests?.passed ?? '-'} (baseline ${r.baseline?.passed ?? '-'}); run exit ${r.steps?.run?.exit ?? '-'}`;
}

export function scenario(name) {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`no rehearsal scenario ${name}: ${scenarioNames().join(', ')}`);
  return s;
}

// --- How the fake reads a request -------------------------------------------

const toolNames = (request) => (request.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));

/**
 * Who is asking: the built-in runner, or the planner's conversation, which is
 * the supervisor once it has played the plan (a wake-up turn reaches the
 * same conversation). `planned` is whether the fake has played the plan.
 */
export function roleOf(request, planned = false) {
  if (toolNames(request).includes('task_complete')) return 'runner';
  return planned ? 'supervisor' : 'planner';
}

/**
 * The supervisor's turn: the first rule not yet played whose `when` matches
 * the newest user message (the wake-up) plays its step, once; after a tool's
 * answer the next such rule plays, so one wake that holds two events answers
 * both, and with none left it closes in prose. Anything else is left alone,
 * as `b-leave` needs.
 */
export function supervisorTurn(rules, messages, state) {
  const last = messages.at(-1);
  if (!last) return { content: 'Done.' };
  const said = text([...messages].reverse().find((m) => m.role === 'user'));
  const i = (rules ?? []).findIndex((r, n) => !state.supervised.includes(n) && r.when.test(said));
  if (i === -1) return { content: last.role === 'tool' ? 'Done.' : 'Nothing to do: the run goes on.' };
  state.supervised.push(i);
  if (rules[i].say) return { content: rules[i].say, rule: i };
  return { toolCall: { name: rules[i].step.tool, args: rules[i].step.args }, rule: i };
}

/** Which task an attempt is for: the `[rehearsal:<key>]` its prompt carries, or arm A's one task. */
export function taskKeyOf(messages) {
  for (const m of messages ?? []) {
    const hit = /\[rehearsal:([\w-]+)\]/.exec(text(m));
    if (hit) return hit[1];
  }
  return 'A';
}

/** How many tool rounds this attempt has had: its next step's index. */
export const roundsOf = (messages) => (messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;

/**
 * The fake's state across requests: how many attempts each task has started.
 * A request with no tool round yet opens a new attempt.
 */
export function createState() {
  return { attempts: {}, planned: false, supervised: [] };
}

/**
 * One turn for one request: `{ toolCall?: {name, args}, content?, costUsd }`.
 * `state` is updated in place. Past its script an attempt says it is done in
 * prose, which ends the runner's loop without a verdict, as a model that
 * stops talking would.
 */
export function turnFor(name, request, state, ctx) {
  const s = scenario(name);
  const messages = request.messages ?? [];
  const role = roleOf(request, state.planned);
  if (role === 'runner') {
    const key = taskKeyOf(messages);
    const round = roundsOf(messages);
    if (round === 0) state.attempts[key] = (state.attempts[key] ?? 0) + 1;
    const attempt = state.attempts[key] ?? 1;
    const scripts = s.attempts(ctx)[key] ?? [];
    const steps = scripts[Math.min(attempt, scripts.length) - 1] ?? [];
    const step = steps[round];
    if (!step) return { content: 'Done.', costUsd: TURN_COST_USD, role, key, attempt, round };
    if (step.fromPrompt) {
      // The command is whatever the task's own first message gives; a message that gives none makes a step that fails, which the judge reads.
      const first = messages.find((m) => m.role === 'user');
      const command = step.fromPrompt.exec(text(first))?.[1] ?? null;
      const args = { command: command ?? `echo 'the first message holds no command to run' >&2; exit 3` };
      return { toolCall: { name: step.tool, args }, costUsd: TURN_COST_USD, role, key, attempt, round, fromPrompt: command };
    }
    return { toolCall: { name: step.tool, args: step.args }, costUsd: step.costUsd ?? TURN_COST_USD, role, key, attempt, round };
  }
  if (role === 'supervisor') return { ...supervisorTurn(s.supervisor, messages, state), costUsd: TURN_COST_USD, role };
  if (role === 'planner' && s.plan) {
    state.planned = true;
    return { content: fencedPlan(s.plan(ctx)), costUsd: TURN_COST_USD, role };
  }
  return { content: 'Understood.', costUsd: TURN_COST_USD, role };
}

const fencedPlan = (plan) => `Here is the plan.\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;

// --- The OpenAI-style stream the fake writes ---------------------------------

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'rehearsal', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** The SSE body of one turn, as bench/live/mock-provider.mjs streams it, with the turn's cost in its usage. */
export function sseBody(turn, { promptChars = 0 } = {}) {
  const parts = [];
  if (turn.content) parts.push(chunk({ role: 'assistant', content: turn.content }));
  if (turn.toolCall) {
    const id = `call_${Math.random().toString(36).slice(2, 10)}`;
    parts.push(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) } }] }));
  }
  parts.push(chunk({}, turn.toolCall ? 'tool_calls' : 'stop'));
  const prompt = Math.max(1, Math.ceil(promptChars / 4));
  const completion = Math.max(1, Math.ceil(JSON.stringify(turn.toolCall ?? turn.content ?? '').length / 4));
  parts.push(`data: ${JSON.stringify({ id: 'rehearsal', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost: turn.costUsd ?? TURN_COST_USD } })}\n\n`);
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

/** The listing core's runner reads at each attempt's start, holding the model at the window the snapshot states. */
export function modelsBody({ modelId, contextLength }) {
  return {
    data: [{
      id: modelId, name: `${modelId} (rehearsal fake)`, description: 'scripted', context_length: contextLength,
      pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: contextLength, max_completion_tokens: 32_000 },
      supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
    }],
  };
}

// --- What a scenario's result.json must say ----------------------------------

/** Tasks by status, from result.tasks (the driver's chosen list). */
export function taskCounts(tasks) {
  const by = {};
  for (const t of tasks ?? []) by[t.status] = (by[t.status] ?? 0) + 1;
  return by;
}

/**
 * Whether the fake played every step of the attempts `playedOut` names, from
 * its request log: an attempt the driver stopped mid-step never reaches its
 * last one. Each task `cutShort` names must have started and never reached
 * its last step. Returns the failures.
 */
export function judgePlayed(name, turns, ctx) {
  const s = scenario(name);
  const f = [];
  if (s.planOnly) {
    // Nothing ran: the fake heard the planner and no runner or supervisor.
    if (!turns.some((t) => t.role === 'planner')) f.push('the fake never heard the planner');
    for (const t of turns.filter((x) => x.role === 'runner' || x.role === 'supervisor')) f.push(`a ${t.role} turn was played in a plan-only run`);
    return f;
  }
  const scripts = s.attempts(ctx);
  for (const key of s.playedOut ?? []) {
    const attempts = scripts[key] ?? [];
    attempts.forEach((steps, i) => {
      const last = steps.length - 1;
      const reached = turns.some((t) => t.role === 'runner' && t.key === key && t.attempt === i + 1 && t.round === last && t.toolCall?.name === steps[last].tool);
      if (!reached) f.push(`task ${key}, attempt ${i + 1}: its last scripted step (${steps[last].tool}) was never played`);
    });
  }
  for (const key of s.cutShort ?? []) {
    const steps = scripts[key]?.[0] ?? [];
    const mine = turns.filter((t) => t.role === 'runner' && t.key === key);
    if (!mine.length) f.push(`task ${key} never started: there was no attempt for the stop to cut short`);
    else if (mine.some((t) => t.round === steps.length - 1 && t.toolCall?.name === steps.at(-1)?.tool)) f.push(`task ${key}, attempt 1: its last scripted step (${steps.at(-1).tool}) was played: the stop did not cut it short`);
  }
  for (const re of s.spoke ?? []) {
    if (!turns.some((t) => t.role === 'supervisor' && !t.toolCall && re.test(t.content ?? ''))) f.push(`the supervisor never said ${re}`);
  }
  for (const tool of s.supervised ?? []) {
    if (!turns.some((t) => t.role === 'supervisor' && t.toolCall?.name === tool)) f.push(`the supervisor never played ${tool}`);
  }
  return f;
}

/** The exit code a shell tool's result ends with, or null. */
const exitOf = (m) => { const hit = /\[exit code (-?\d+)\]\s*$/.exec(text(m)); return hit ? Number(hit[1]) : null; };

/**
 * The failures of a take-in scenario: from the fake's request log (each line
 * { messages, turn }) the consumer's first message holds the heading and the
 * command, and every step that must exit 0 did; and from `history` (the
 * commits the merged work ends on, [{ sha, parents, subject }], or null when
 * they could not be read) the take-in is a merge of the producer's landing
 * into the consumer's own commit, and the consumer's landing holds it.
 */
export function judgeTakeIn(name, requests, ctx, history) {
  const s = scenario(name);
  if (!s.takeIn) return [];
  const { key } = s.takeIn;
  const f = [];
  const mine = requests.filter((r) => r.turn?.role === 'runner' && r.turn.key === key && r.turn.attempt === 1);
  const first = mine.find((r) => r.turn.round === 0);
  const told = text((first?.messages ?? []).find((m) => m.role === 'user'));
  if (!first) f.push(`task ${key} never made a request`);
  else if (!told.includes(LANDING_HEADING)) f.push(`task ${key}'s first message holds no "${LANDING_HEADING}" block`);
  const steps = s.attempts(ctx)[key]?.[0] ?? [];
  steps.forEach((step, round) => {
    if (!step.exit0) return;
    const asked = mine.find((r) => r.turn.round === round);
    const answered = mine.find((r) => r.turn.round === round + 1);
    const label = step.fromPrompt ? 'the take-in command' : `step ${round + 1} (${step.args?.command})`;
    if (step.fromPrompt && typeof asked?.turn.fromPrompt !== 'string') f.push(`task ${key}'s first message gives no command to take the work in with`);
    else if (!answered) f.push(`${label}: no answer to it reached the fake`);
    else if (exitOf((answered.messages ?? []).at(-1)) !== 0) f.push(`${label} exited ${exitOf((answered.messages ?? []).at(-1))}, wanted 0: ${text((answered.messages ?? []).at(-1)).slice(-300)}`);
  });
  if (!history) return [...f, 'the merged work\'s history could not be read from the arm\'s files'];
  const bySha = new Map(history.map((c) => [c.sha, c]));
  const take = history.find((c) => TAKE_IN_SUBJECT.test(c.subject) && c.parents.length === 2);
  if (!take) {
    return [...f, `the merged work holds no merge commit "Merge: ... (take in landed work)" (its subjects: ${history.slice(0, 12).map((c) => c.subject).join(' | ') || 'none'})`];
  }
  const [own, landed] = take.parents.map((sha) => bySha.get(sha)?.subject ?? '');
  if (own !== s.takeIn.ownSubject) f.push(`the take-in's first parent is "${own}", wanted the consumer's own commit "${s.takeIn.ownSubject}"`);
  if (!landed.includes(s.takeIn.landed)) f.push(`the take-in's second parent is "${landed}", wanted the landing of "${s.takeIn.landed}"`);
  if (!history.some((c) => c.parents.includes(take.sha))) f.push('nothing in the merged work has the take-in as a parent: the consumer\'s landing does not hold it');
  return f;
}

/** The failures of a scenario that names files its merged work must hold; `present` says whether one is there. */
export function judgeLanded(name, present) {
  return (scenario(name).landed ?? []).filter((file) => !present(file)).map((file) => `${file} never landed: a task that ended done with a finding must still land`);
}

/**
 * The failures of a scenario's batch.json: the batch ran its one run to a
 * result, says it was this rehearsal, and never read the key, which on a
 * rehearsal is the fake's placeholder.
 */
export function judgeBatch(record, { lib, arm, rehearsal }) {
  if (!record) return ['no batch.json'];
  const f = [];
  if (record.rehearsal !== rehearsal) f.push(`batch.json is not marked as rehearsal ${rehearsal} (${JSON.stringify(record.rehearsal ?? null)})`);
  if (record.keyBeforeUsd !== null || record.keyAfterUsd !== null || record.keyReadings?.length) f.push('the batch read the key\'s usage (a key reading in batch.json): a rehearsal has no key to read');
  // The last write of batch.json is the one that marks the batch finished: one left unfinished is the write after the last run missing.
  if (record.finished !== true) f.push('batch.json is not marked finished: the batch\'s last write is missing');
  const runs = (record.runs ?? []).filter((r) => r.lib === lib && r.arm === arm);
  if (runs.length !== 1 || record.runs.length !== 1) return [...f, `batch.json wants 1 run of ${lib} ${arm}, not ${runs.length} (of ${record.runs?.length ?? 0} in all)`];
  if (runs[0].skipped) f.push(`the batch skipped its run: ${runs[0].skipped}`);
  if (!runs[0].resultDir) f.push('the batch found no result directory for its run');
  return f;
}

/**
 * What a plan-only scenario's result.json must say: the plan's shape, a
 * priced planner and a planning time, and that it is marked plan-only, never
 * valid, and holds nothing of a run: no score, no tests, no run or merge step.
 */
function judgePlanOnly(name, result) {
  const e = scenario(name).expect;
  const f = [];
  const want = (ok, what) => { if (!ok) f.push(what); };
  want(!result.aborted, `the run aborted: ${result.aborted}`);
  want(result.planOnly === true, `planOnly is ${JSON.stringify(result.planOnly)}, not true`);
  want(result.valid === false && (result.invalidReasons ?? []).some((r) => /^plan-only/.test(r)), `a plan-only result must be marked not valid for being plan-only (valid ${result.valid}, ${JSON.stringify(result.invalidReasons)})`);
  want(result.tests === null && result.scoredFrom === null && result.tasks === null && (result.patches ?? []).length === 0, 'the result holds a score: tests, scoredFrom, tasks or patches');
  want(result.baseline === null && result.truncated?.truncated === false, 'the result holds a baseline or a truncation');
  want(!result.steps?.run && !result.steps?.merge && !result.closing?.merge, `a run or a merge step happened: ${JSON.stringify({ run: result.steps?.run, merge: result.steps?.merge })}`);
  want(result.steps?.plan?.exit === 0, `ordewell plan exited ${JSON.stringify(result.steps?.plan ?? null)}`);
  want(result.stopped === null && result.stalled === null, `the run was stopped or stalled (${JSON.stringify(result.stopped ?? result.stalled)})`);
  const p = result.planned;
  if (!p) return [...f, 'no planned record'];
  want(p.protocolOk === true, `the plan broke the protocol: ${p.protocolFailures?.join('; ')}`);
  const shape = p.shape ?? {};
  for (const [k, v] of Object.entries(e.shape)) want(JSON.stringify(shape[k]) === JSON.stringify(v), `shape.${k} is ${JSON.stringify(shape[k])}, wanted ${JSON.stringify(v)}`);
  want(typeof p.plannerUsd === 'number' && p.plannerUsd > 0, `the planner's spend is ${p.plannerUsd}, not above 0`);
  want(typeof p.planningMs === 'number' && p.planningMs > 0, `the planning time is ${p.planningMs}`);
  want(result.recordedUsd === p.plannerUsd, `recordedUsd ${result.recordedUsd} is not the planner's ${p.plannerUsd}: something besides the planner spent`);
  want(result.metrics === null, 'a plan-only result holds run metrics');
  want(result.ending?.by === 'not-run' && result.providerSwitches === null, `a plan-only result holds an ending or provider switches: ${JSON.stringify([result.ending, result.providerSwitches])}`);
  return f;
}

/**
 * The failures of a plan-only run's directory: plan.json beside the result
 * (every task's title, brief and dependencies), the saved plan, and none of
 * what a scored run leaves (the copy of the arm's work, its patch, its tests).
 */
export function judgePlanOnlyDir({ names, digest, expectedTitles }) {
  const f = [];
  for (const need of ['result.json', 'plan.json', 'plan-saved.json']) if (!names.includes(need)) f.push(`the run directory holds no ${need}`);
  for (const stray of ['arm-workdir', 'arm.patch', 'baseline-tests.log', 'eval-tests.log']) if (names.includes(stray)) f.push(`the run directory holds ${stray}, which only a scored run makes`);
  const tasks = digest?.tasks ?? [];
  if (tasks.length !== expectedTitles.length) f.push(`plan.json holds ${tasks.length} tasks, wanted ${expectedTitles.length}`);
  expectedTitles.forEach((title, i) => {
    const t = tasks[i];
    if (!t) return;
    if (t.title !== title) f.push(`plan.json task ${i + 1} is "${t.title}", wanted "${title}"`);
    if (!t.brief) f.push(`plan.json task ${i + 1} has no brief`);
    if (!Array.isArray(t.dependencies) || !Array.isArray(t.dependsOn)) f.push(`plan.json task ${i + 1} has no dependencies`);
  });
  return f;
}

/**
 * What metrics.supervisor must hold: the acts the supervisor made besides
 * words (every call at the seam and every plan edit, in order, each done),
 * how many wakes were the one core raises for a failure the closing turn left
 * standing, that every wake names what triggered it in a line the harness
 * knows, and, with `retryAfterWake`, that the retry came after that wake.
 */
export function judgeSupervision(want, sup) {
  if (!sup?.actions || !sup.wakes) return ['metrics.supervisor holds no actions or wakes'];
  const f = [];
  const acts = sup.actions.filter((a) => a.kind !== 'message');
  const kinds = acts.map((a) => a.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(want.acts)) f.push(`the supervisor's acts are ${JSON.stringify(kinds)}, wanted ${JSON.stringify(want.acts)}`);
  for (const a of acts) if (a.outcome !== 'done') f.push(`act ${a.kind} was ${a.outcome}`);
  for (const a of sup.actions) if (!a.at) f.push(`act ${a.kind} has no time`);
  const triggers = sup.wakes.flatMap((w) => w.triggers);
  const closing = sup.wakes.filter((w) => w.triggers.some((t) => t.kind === 'failure_standing' && t.closing));
  if (closing.length !== want.closingWakes) f.push(`${closing.length} wake(s) for a failure the closing turn left, wanted ${want.closingWakes}`);
  if (!sup.wakes.length || sup.wakeUps < sup.wakes.length) f.push(`wakeUps ${sup.wakeUps} against ${sup.wakes.length} wake(s)`);
  for (const w of sup.wakes) if (!w.triggers.length) f.push(`the wake at ${w.at} names no trigger`);
  for (const t of triggers.filter((x) => x.kind === 'other')) f.push(`a trigger the harness cannot read: ${JSON.stringify(t)}`);
  if (want.closingWakes > 0 && closing[0]) {
    const standing = closing[0].triggers.find((t) => t.kind === 'failure_standing');
    if (standing.task !== '#1') f.push(`the closing wake names task ${standing.task}, wanted #1`);
  }
  if (want.retryAfterWake) {
    const retry = acts.find((a) => a.kind === 'retry_task');
    if (!retry || !closing[0] || !(retry.at > closing[0].at)) f.push(`the retry (${retry?.at}) did not follow the closing wake (${closing[0]?.at})`);
  }
  return f;
}

/**
 * What result.json says of how the arm stopped (`ending`) and of the upstream
 * switches (`providerSwitches`): the fields are always there, and the ending
 * is the one the scenario plays. The fake provider names no upstream, so
 * the switches are read, from every attempt's log, and none is found.
 */
function judgeEnding(want, result) {
  const f = [];
  const end = result.ending;
  if (!end || typeof end.by !== 'string') return ['result.json holds no ending'];
  const sw = result.providerSwitches;
  if (!sw || !(sw.attempts > 0) || sw.attemptsSwitched !== 0 || sw.switches !== 0) f.push(`providerSwitches is ${JSON.stringify(sw)}, wanted every attempt read and no switch`);
  if (!want) return f;
  for (const k of ['by', 'status', 'reason', 'cap']) if (k in want && end[k] !== want[k]) f.push(`ending.${k} is ${JSON.stringify(end[k])}, wanted ${JSON.stringify(want[k])}`);
  if (want.calls) {
    const m = end.modelCalls;
    if (!m || !(m.used > 0) || !(m.limitPerAttempt > 0) || m.reachedLimit) f.push(`ending.modelCalls is ${JSON.stringify(m)}, wanted calls used against the step limit`);
  } else if (end.modelCalls !== null) f.push(`ending.modelCalls is ${JSON.stringify(end.modelCalls)}, but only arm A reports its calls`);
  return f;
}

/** The failures of one scenario's result.json against its expectations; empty when it passed. */
export function judgeRehearsal(name, result) {
  if (!result) return ['no result.json'];
  if (scenario(name).planOnly) return judgePlanOnly(name, result);
  const e = scenario(name).expect;
  const f = [];
  const want = (ok, what) => { if (!ok) f.push(what); };
  want(!result.aborted, `the run aborted: ${result.aborted}`);
  if ('valid' in e) want(result.valid === e.valid, `valid is ${result.valid}, not ${e.valid}${result.invalidReasons?.length ? ` (${result.invalidReasons.join('; ')})` : ''}`);
  if (e.scoredFrom) want(result.scoredFrom === e.scoredFrom, `scored from ${result.scoredFrom}, not ${e.scoredFrom}`);
  if ('runExit' in e) want(result.steps?.run?.exit === e.runExit && result.steps.run.ended === 'by itself', `ordewell run ended ${JSON.stringify(result.steps?.run ?? null)}, not by itself with exit ${e.runExit}`);
  if (e.runStopped) want(result.steps?.run?.ended !== 'by itself', `ordewell run ended by itself (${JSON.stringify(result.steps?.run ?? null)}), but the driver had to stop it`);
  if ('truncated' in e) want(Boolean(result.truncated?.truncated) === e.truncated, `truncated is ${JSON.stringify(result.truncated)}, wanted ${e.truncated}`);
  if (e.truncatedWhy) want(e.truncatedWhy.test(result.truncated?.why ?? ''), `truncated because "${result.truncated?.why}", wanted ${e.truncatedWhy}`);
  if ('stoppedWhy' in e) want((result.stopped?.why ?? null) === e.stoppedWhy, `stopped by ${result.stopped?.why ?? 'nothing'}, wanted ${e.stoppedWhy ?? 'nothing'}`);
  if ('stalled' in e) want(Boolean(result.stalled) === e.stalled, `stalled is ${JSON.stringify(result.stalled ?? null)}, wanted ${e.stalled ? 'a record' : 'none'}`);
  if (e.heldOpen !== undefined) want((result.stalled?.open ?? []).length === e.heldOpen, `${(result.stalled?.open ?? []).length} task(s) held open, wanted ${e.heldOpen} (${JSON.stringify(result.stalled?.open ?? null)})`);
  if (e.mergeExit !== undefined) want(result.steps?.merge?.exit === e.mergeExit, `the merge step ${JSON.stringify(result.steps?.merge ?? null)}, wanted exit ${e.mergeExit}`);
  if (e.tasks) {
    const got = taskCounts(result.tasks);
    for (const [status, n] of Object.entries(e.tasks)) want((got[status] ?? 0) === n, `${got[status] ?? 0} task(s) ${status}, wanted ${n} (${JSON.stringify(got)})`);
  }
  if (e.notComplete) want(!(result.tasks ?? []).every((t) => t.status === 'completed'), 'every task is completed, but the run must not be');
  if (e.passedAboveBaseline) {
    const passed = result.tests?.passed ?? null;
    const base = result.baseline?.passed ?? 0;
    want(passed !== null && passed > base, `${passed} passed, not above the baseline's ${base}`);
    want(!(result.tests?.collectionErrors ?? []).some((c) => String(c).includes(REHEARSAL_MODULE)), `a collection error names ${REHEARSAL_MODULE}: the new module was not scored`);
  }
  if (e.passedAtBaseline) {
    const passed = result.tests?.passed ?? null;
    const base = result.baseline?.passed ?? null;
    want(passed !== null && passed === base, `${passed} passed, not the baseline's ${base}: work that never landed was scored`);
  }
  f.push(...judgeEnding(scenario(name).ending, result));
  if (scenario(name).supervision) f.push(...judgeSupervision(scenario(name).supervision, result.metrics?.supervisor));
  if (e.testExcluded) {
    want((result.excluded ?? []).some((x) => /test/.test(x.path ?? '') && /test/.test(x.reason ?? '')), `no test file in excluded (${JSON.stringify(result.excluded ?? null)}): the edited test was scored`);
  }
  return f;
}
