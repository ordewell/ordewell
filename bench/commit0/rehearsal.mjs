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

const done = (subject) => ({ tool: 'task_complete', args: { status: 'done', summary: `${subject}.`, commit: { subject } } });
const failed = (why) => ({ tool: 'task_complete', args: { status: 'failed', summary: why, reason: why } });

const checkpoint = (question) => ({ tool: 'checkpoint', args: { question } });
/** A file outside the library and its tests: work that lands without moving the score. */
const note = (file) => ({ tool: 'write', args: { path: file, content: 'Written by the rehearsal.\n' } });

/** Deterministic task ids, so a plan and its dependencies read back the same on every run. */
const taskId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Arm B's plan, as the planner emits it: one task per entry of `tasks`
 * ({ key, title, after? }), each on the bench's runner and model in full mode,
 * its prompt carrying the `[rehearsal:<key>]` the fake routes its attempts by.
 */
export function rehearsalPlan(tasks) {
  const order = new Map(tasks.map((t, i) => [t.key, i + 1]));
  return {
    tasks: tasks.map((t, i) => ({
      id: taskId(i + 1), order: i + 1, title: t.title, description: t.title, type: 'ai',
      dependencies: (t.after ?? []).map((k) => taskId(order.get(k))),
      prompt: `${t.title}. [rehearsal:${t.key}]`,
      assignedRunner: 'openrouter',
      assignedModel: { modelId: 'openrouter:deepseek/deepseek-v4.1-flash', modelLabel: 'DeepSeek V4.1 Flash' },
      taskMode: 'full', autonomy: 'AFK', sliceType: 'AFK', subtasks: [],
    })),
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
const APPROVE = { tool: 'answer_checkpoint', args: { task: '#2', answer: 'approve', reason: 'Follow the tests.' } };
const FAILS_ON_PURPOSE = 'The rehearsal fails this task on purpose.';
const LEFT_PLAN = [
  { key: 'edit', title: 'Implement the library' },
  { key: 'after', title: 'Note the rehearsal', after: ['edit'] },
];

/**
 * Each scenario: the arm it runs, its scripted attempts per task (by the key
 * a task's prompt carries, or `A` for arm A's one task), and what its
 * result.json must hold. `ctx` is { src, tests, longSec }.
 */
export const SCENARIOS = Object.freeze({
  'a-done': {
    arm: 'A',
    about: 'arm A: its one task makes the edits and reports done; `ordewell run` returns by itself',
    attempts: (ctx) => ({ A: [[...editSteps(ctx), done('Implement the library')]] }),
    expect: { valid: true, runExit: 0, truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 1 } },
    playedOut: ['A'],
  },
  'a-failed': {
    arm: 'A',
    about: 'arm A: one shell command outlasts the settle window, then the edits, then the task reports failed; scored from its unlanded worktree',
    attempts: (ctx) => ({ A: [[longStep(ctx.longSec), ...editSteps(ctx), failed('The rehearsal fails this task on purpose.')]] }),
    expect: {
      valid: true, scoredFrom: 'task-worktree', truncated: true, truncatedWhy: /^settled with 1 task open: 1 nothing ready/,
      stoppedWhy: null, passedAboveBaseline: true, testExcluded: true, tasks: { failed: 1 },
    },
    playedOut: ['A'],
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
    expect: { valid: true, scoredFrom: 'merged', truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 2 } },
    playedOut: ['edit', 'after'],
    supervised: ['retry_task', 'answer_checkpoint'],
  },
  'b-leave': {
    arm: 'B',
    about: 'arm B: task 1 fails while task 2 waits on it; the supervisor at Act leaves it, so the run is held and ends by the stall rule, never complete',
    plan: () => rehearsalPlan(LEFT_PLAN),
    attempts: (ctx) => ({ edit: [[...editSteps(ctx), failed(FAILS_ON_PURPOSE)]], after: [[note('commit0-rehearsal-note.md'), done('Note the rehearsal')]] }),
    supervisor: [],
    // Nothing landed: arm B scores merged work, which the failed task's never became.
    expect: {
      scoredFrom: 'merged', truncated: true, truncatedWhy: /^settled with 2 tasks open/, stoppedWhy: null, stalled: true, heldOpen: 2,
      notComplete: true, passedAtBaseline: true, tasks: { failed: 1, completed: 0 },
    },
    playedOut: ['edit'],
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
  const t = r.truncated?.truncated ? `truncated (${r.truncated.why})` : 'not truncated';
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
  const scripts = s.attempts(ctx);
  const f = [];
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
  for (const tool of s.supervised ?? []) {
    if (!turns.some((t) => t.role === 'supervisor' && t.toolCall?.name === tool)) f.push(`the supervisor never played ${tool}`);
  }
  return f;
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
  if (record.keyBeforeUsd !== null || record.keyAfterUsd !== null) f.push('the batch read the key\'s usage: a rehearsal has no key to read');
  const runs = (record.runs ?? []).filter((r) => r.lib === lib && r.arm === arm);
  if (runs.length !== 1 || record.runs.length !== 1) return [...f, `batch.json wants 1 run of ${lib} ${arm}, not ${runs.length} (of ${record.runs?.length ?? 0} in all)`];
  if (runs[0].skipped) f.push(`the batch skipped its run: ${runs[0].skipped}`);
  if (!runs[0].resultDir) f.push('the batch found no result directory for its run');
  return f;
}

/** The failures of one scenario's result.json against its expectations; empty when it passed. */
export function judgeRehearsal(name, result) {
  const e = scenario(name).expect;
  const f = [];
  const want = (ok, what) => { if (!ok) f.push(what); };
  if (!result) return ['no result.json'];
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
  if (e.testExcluded) {
    want((result.excluded ?? []).some((x) => /test/.test(x.path ?? '') && /test/.test(x.reason ?? '')), `no test file in excluded (${JSON.stringify(result.excluded ?? null)}): the edited test was scored`);
  }
  return f;
}
