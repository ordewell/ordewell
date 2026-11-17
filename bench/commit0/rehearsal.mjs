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
export const FAKE_KEY = 'rehearsal-fake';
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

/** Who is asking: the built-in runner, the supervisor or the planner (anything else answers in prose). */
export function roleOf(request) {
  const tools = toolNames(request);
  if (tools.includes('task_complete')) return 'runner';
  if (tools.some((t) => /retry_task|answer_checkpoint|skip_task/.test(t))) return 'supervisor';
  return 'planner';
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
  return { attempts: {} };
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
  const role = roleOf(request);
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
  if (role === 'supervisor' && s.supervisor) return { ...s.supervisor(request, state, ctx), role };
  if (role === 'planner' && s.plan) return { content: fencedPlan(s.plan(ctx)), costUsd: TURN_COST_USD, role };
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

/** The failures of one scenario's result.json against its expectations; empty when it passed. */
export function judgeRehearsal(name, result) {
  const e = scenario(name).expect;
  const f = [];
  const want = (ok, what) => { if (!ok) f.push(what); };
  if (!result) return ['no result.json'];
  want(!result.aborted, `the run aborted: ${result.aborted}`);
  if ('valid' in e) want(result.valid === e.valid, `valid is ${result.valid}, not ${e.valid}${result.invalidReasons?.length ? ` (${result.invalidReasons.join('; ')})` : ''}`);
  if (e.scoredFrom) want(result.scoredFrom === e.scoredFrom, `scored from ${result.scoredFrom}, not ${e.scoredFrom}`);
  if ('runExit' in e) want(result.steps?.run?.exit === e.runExit, `ordewell run exited ${JSON.stringify(result.steps?.run ?? null)}, not ${e.runExit} by itself`);
  if ('truncated' in e) want(Boolean(result.truncated?.truncated) === e.truncated, `truncated is ${JSON.stringify(result.truncated)}, wanted ${e.truncated}`);
  if (e.truncatedWhy) want(e.truncatedWhy.test(result.truncated?.why ?? ''), `truncated because "${result.truncated?.why}", wanted ${e.truncatedWhy}`);
  if ('stoppedWhy' in e) want((result.stopped?.why ?? null) === e.stoppedWhy, `stopped by ${result.stopped?.why ?? 'nothing'}, wanted ${e.stoppedWhy ?? 'nothing'}`);
  if ('stalled' in e) want(Boolean(result.stalled) === e.stalled, `stalled is ${JSON.stringify(result.stalled ?? null)}, wanted ${e.stalled ? 'a record' : 'none'}`);
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
  if (e.testExcluded) {
    want((result.excluded ?? []).some((x) => /test/.test(x.path ?? '') && /test/.test(x.reason ?? '')), `no test file in excluded (${JSON.stringify(result.excluded ?? null)}): the edited test was scored`);
  }
  return f;
}
