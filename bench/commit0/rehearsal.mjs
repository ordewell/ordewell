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

// Not a `sleep`: the built-in runner's shell refuses a change task's long sleep as a wait (core's waitGuard), and this stands for work that takes time.
export const longStep = (sec) => shell(`timeout ${sec} tail -f /dev/null; echo slept ${sec}s`, { timeout: (sec + 120) * 1000 });

const done = (subject, extra = {}) => ({ tool: 'task_complete', args: { status: 'done', summary: `${subject}.`, commit: { subject }, ...extra } });
const failed = (why) => ({ tool: 'task_complete', args: { status: 'failed', summary: why, reason: why } });

const checkpoint = (question) => ({ tool: 'checkpoint', args: { question } });
/** The call that parks a change task on a sibling's unlanded work (core's wait_for, ADR-0074). */
const waitFor = (tasks, reason) => ({ tool: 'wait_for', args: { tasks, reason } });
/** A turn the model ends in prose: how a granted wait_for's attempt ends, and where the continuation picks up. */
const say = (content) => ({ say: content });
/** A shell step the built-in runner's guard must refuse before it runs (core's waitRefusal): the reply names wait_for. */
const refused = (command) => ({ ...shell(command), refused: true });
export const WAIT_REFUSAL = /Not run: this command sleeps for 300 seconds\./;
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
const FIX_FILE = 'commit0-rehearsal-fix.md';
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
/** The line a wake holds for a blocker reported in landed work (core's landedBlockerLine), as it reads for one reporter. */
const LANDED_BLOCKER_LINE = /task #1 "Implement the library" has landed, and 1 task reports a blocker in its work/i;
/** The start of the one line of guidance that line carries (core's LANDED_BLOCKER_ADVICE). */
const LANDED_BLOCKER_ADVICE = /A blocker reported in landed work is fixed once, by one task/;
/**
 * The supervisor's answer to that wake: one edit that adds the one fix task
 * (beside the opening, which landed) and makes the closing check wait on it
 * too. Its prompt carries the key the fake routes by.
 */
const FIX_REPLY = `The rehearsal adds one fix task for the opening task's defect.\n\`\`\`json\n${JSON.stringify({
  taskOps: [
    {
      op: 'add', handle: 'fix',
      task: {
        title: 'Fix the opening task\'s defect', description: 'Fix the defect two slices report in the opening task\'s landed work.',
        prompt: 'Fix the defect two slices report in the opening task\'s landed work (#2/F1, #3/F1). [rehearsal:fix]',
        dependencies: ['#1'], assignedRunner: 'openrouter',
        assignedModel: { modelId: 'openrouter:deepseek/deepseek-v4.1-flash', modelLabel: 'DeepSeek V4.1 Flash' },
      },
    },
    { op: 'update', taskId: '#6', changes: { dependencies: ['#2', '#3', '#4', '#5', 'fix'] } },
  ],
}, null, 2)}\n\`\`\``;
const FAILS_ON_PURPOSE ='The rehearsal fails this task on purpose.';
const GIVES_UP_EARLY = 'The rehearsal gives up early on purpose: the agent reports failed long before a cap.';
/** A shell step that the provider prices at `usd`, as a long attempt's spending mounts. */
const spends = (usd) => ({ ...shell('echo spending'), costUsd: usd });
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
const SCENARIO_TABLE = {
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
    // The first step sleeps for five minutes, as a model waiting on work does: the built-in shell refuses it before it runs, and the reply names wait_for.
    attempts: (ctx) => ({ A: [[refused('sleep 300; echo slept'), ...editSteps(ctx), done('Implement the library')]] }),
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
  'a-continued': {
    arm: 'A-continued',
    about: 'the control arm: its one task reports failed after one step and ends its attempt, is continued in its saved session with the fixed message, makes the edits and reports done; each continuation after that is idle (an attempt ending in prose with no report, answered as the reply its task waits on, then a report and a word, twice), so after three the harness gives up; scored on its final tree',
    // One session, so one script: a continuation goes on from the step after the last one the session played (the rounds of its history).
    attempts: (ctx) => ({
      A: [[
        note('commit0-rehearsal-note.md'),
        failed(GIVES_UP_EARLY),
        say('I could not finish this.'),
        // The first continuation: the edits, a report, a closing word. An attempt ends when the model stops calling tools, whatever it reported.
        ...editSteps(ctx),
        done('Implement the library'),
        say('Finished.'),
        // The three idle ones. First an attempt that ends in prose with no report: the runner reminds it once, it answers in prose again, and the task waits on input for a reply (the harness's message); then a report and a closing word, twice.
        say('I believe that is everything.'),
        say('There is nothing to report.'),
        done('Nothing more to do'),
        say('Nothing more to add.'),
        done('Nothing more to do'),
        say('Nothing more to add.'),
      ]],
    }),
    ending: { by: 'continuation', why: 'gave-up', calls: true },
    expect: { valid: true, truncated: false, stoppedWhy: null, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 1 } },
    playedOut: ['A'],
    // Each continuation: the verdict of the attempt before it, and whether its own attempt did anything (calls above two, or a changed tree).
    continued: { verdicts: ['failed', 'done', 'no report', 'done'], vias: ['continue', 'continue', 'message', 'continue'], busy: [true, false, false, false], stop: 'gave-up' },
  },
  'a-continued-cap': {
    arm: 'A-continued',
    about: 'the control arm up to the spend cap: its task reports failed after spending, is continued, makes the edits and reports done, and is continued again, and that attempt reports usage past --cap-usd mid-attempt: the stop, the merge and the scoring all happen, the caps winning across the continuations',
    capUsd: 0.5,
    attempts: (ctx) => ({
      A: [[
        spends(0.2),
        failed(GIVES_UP_EARLY),
        say('I could not finish this.'),
        ...editSteps(ctx),
        done('Implement the library'),
        say('Finished.'),
        spends(1),
        longStep(ctx.longSec),
        done('Spend past the cap'),
      ]],
    }),
    ending: { by: 'cap', cap: 'spend', calls: true },
    // `ordewell run` returned by itself when the first attempt ended: the continued attempts run under the daemon, which the driver's stop ends.
    expect: { valid: true, truncated: true, truncatedWhy: /^cap: spend/, stoppedWhy: 'spend', mergeExit: 0, passedAboveBaseline: true, testExcluded: true },
    playedOut: [],
    cutShort: ['A'],
    continued: { verdicts: ['failed', 'done'], busy: [true], stop: null },
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
  'b-wait': {
    arm: 'B',
    about: 'arm B at two at once: the consumer calls wait_for on the producer, which is still at work, and parks; its slot goes to a third task queued behind the limit; once the producer lands the consumer continues, told what landed, and lands too',
    windows: { parallel: 2 },
    plan: () => rehearsalPlan([
      { key: 'producer', title: 'Implement the library' },
      { key: 'consumer', title: 'Build on the library' },
      { key: 'small', title: 'Note the rehearsal' },
    ]),
    attempts: (ctx) => {
      // What the consumer does once it goes on, with the work it waited for in its worktree.
      const after = [
        note(CONSUMER_NOTE),
        { ...shell(`test -f ${ctx.src}/${REHEARSAL_MODULE}.py && echo taken in`), exit0: true },
        done('Build on the library'),
      ];
      return {
        // The long step keeps the producer at work while the consumer parks and the third task takes the slot.
        producer: [[longStep(ctx.longSec), ...editSteps(ctx), done('Implement the library')]],
        // Its session resumes, so the continuation is round 2 of the same attempt; a runner that could not resume would start attempt 2, which has no wait of its own.
        consumer: [[waitFor(['#1'], 'My tests import the library the producer is still writing.'), say('Waiting for the producer.'), ...after], after],
        small: [[note('commit0-rehearsal-small.md'), done('Note the rehearsal')]],
      };
    },
    ending: { by: 'completion', status: 'done', reason: null },
    expect: { valid: true, scoredFrom: 'merged', truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 3 }, parallel: 2,
      // The harness's ledger reads the park as an attempt that ended with no verdict, and the continuation as the next.
      parkedAttempts: { order: 2, ended: ['ended without task_complete', 'done'] } },
    playedOut: ['producer', 'small'],
    wait: { parker: 'consumer', awaited: 'producer', other: 'small', landed: 'Implement the library' },
  },
  'b-blocker': {
    arm: 'B',
    about: 'arm B: the opening task lands a defect and two slices report a blocker citing it; the supervisor\'s wake holds the landed-blocker line, it adds one fix task, and the fix lands before the task that checks the whole starts',
    plan: () => rehearsalPlan([
      { key: 'edit', title: 'Implement the library' },
      { key: 'slice-a', title: 'Slice A', after: ['edit'] },
      { key: 'slice-b', title: 'Slice B', after: ['edit'] },
      { key: 'slice-c', title: 'Slice C', after: ['edit'] },
      { key: 'slice-d', title: 'Slice D', after: ['edit'] },
      // Four slices make the plan a fan-out, the only shape whose landed-blocker line names a closing check (core's FAN_OUT_MIN).
      { key: 'check', title: 'Check the whole', after: ['slice-a', 'slice-b', 'slice-c', 'slice-d'] },
    ]),
    attempts: (ctx) => {
      const blocker = (what) => ({
        findings: [{
          severity: 'blocker', title: `The opening task's landed module breaks ${what}`,
          detail: 'Its module is imported by the package and the import fails: the slice cannot finish its own checks.',
          evidence: [{ kind: 'task', task: '#1' }],
        }],
      });
      return {
        edit: [[...editSteps(ctx), done('Implement the library')]],
        // The first slice reports at once, so the wake comes while the second is at work and the closing check cannot start.
        'slice-a': [[note('commit0-rehearsal-slice-a.md'), done('Do slice A', blocker('slice A'))]],
        'slice-b': [[longStep(ctx.longSec), note('commit0-rehearsal-slice-b.md'), done('Do slice B', blocker('slice B'))]],
        // Two slices report; the other two have nothing to say, as most of a recorded run's did.
        'slice-c': [[note('commit0-rehearsal-slice-c.md'), done('Do slice C')]],
        'slice-d': [[note('commit0-rehearsal-slice-d.md'), done('Do slice D')]],
        fix: [[note(FIX_FILE), done('Fix the opening task\'s defect')]],
        // The fix's file is in the tree the check starts from only if the fix landed first.
        check: [[{ ...shell(`test -f ${FIX_FILE} && echo fixed`), exit0: true }, note('commit0-rehearsal-check.md'), done('Check the whole')]],
      };
    },
    supervisor: [{ when: LANDED_BLOCKER_LINE, say: FIX_REPLY }],
    ending: { by: 'completion', status: 'done', reason: null },
    expect: { valid: true, scoredFrom: 'merged', truncated: false, passedAboveBaseline: true, testExcluded: true, tasks: { completed: 7 } },
    playedOut: ['edit', 'slice-a', 'slice-b', 'slice-c', 'slice-d', 'fix', 'check'],
    spoke: [/adds one fix task/],
    // One reply, three entries in the plan's log: the fix is added, the closing check updated, and core puts the new task ahead of the ones not started.
    supervision: { acts: ['plan_edit', 'plan_edit', 'plan_edit'], ops: ['added', 'updated', 'reordered'], closingWakes: 0 },
    blocker: { closing: '#6', fix: 'Fix the opening task\'s defect', closingTitle: 'Check the whole', check: 'check', fixKey: 'fix', tasks: 7 },
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
};

// The control arm again, asked (--effort-a) to think at a level: what is judged beyond a-continued is that the level reached the model's requests.
SCENARIO_TABLE['a-continued-effort'] = {
  ...SCENARIO_TABLE['a-continued'],
  about: 'the control arm as a-continued, with --effort-a high: the task is planned with that effort and every request of the runner the fake provider hears carries it',
  effortA: 'high',
};

// arm A's one task again, with a task setting passed on the command line: the box must receive it, and every record must say so.
SCENARIO_TABLE['a-done-task-setting'] = {
  ...SCENARIO_TABLE['a-done'],
  about: 'arm A as a-done, with --task-setting taskReasoningKept=3: the box\'s settings file holds it, and result.json and batch.json say it',
  taskSettings: { taskReasoningKept: 3 },
};

export const SCENARIOS = Object.freeze(SCENARIO_TABLE);

export const scenarioNames = () => Object.keys(SCENARIOS);

/** drive.mjs's `--task-setting` options for a scenario. */
export const taskSettingArgs = (s) => Object.entries(s.taskSettings ?? {}).flatMap(([k, v]) => ['--task-setting', `${k}=${v}`]);

/**
 * The failures of a scenario that passes task settings: result.json records
 * them, and the driver's own check that the box received them passed.
 */
export function judgeTaskSettings(name, result) {
  const want = scenario(name).taskSettings ?? {};
  if (Object.keys(want).length === 0) return [];
  const f = [];
  if (JSON.stringify(result?.taskSettings ?? null) !== JSON.stringify(want)) f.push(`result.json records task settings ${JSON.stringify(result?.taskSettings ?? null)}, wanted ${JSON.stringify(want)}`);
  const c = (result?.checks ?? []).find((x) => /task settings in the box$/.test(x.name));
  if (!c) f.push('result.json holds no check that the box received the task settings');
  else if (!c.ok) f.push('the check that the box received the task settings did not pass');
  return f;
}

/** The windows a rehearsal runs under, short enough for minutes; a scenario may set its own. */
export const WINDOWS = Object.freeze({ settleMin: 1, pollSec: 5, noStartMin: 3, stallMin: 2, wallMin: 25 });

/** drive.mjs's options for a scenario's windows and cap. */
export function windowArgs(s) {
  const w = { ...WINDOWS, ...(s.windows ?? {}) };
  return [
    '--settle-min', String(w.settleMin), '--poll-sec', String(w.pollSec), '--no-start-min', String(w.noStartMin),
    '--stall-min', String(w.stallMin), '--wall-min', String(w.wallMin), ...(s.capUsd ? ['--cap-usd', String(s.capUsd)] : []),
    ...(w.parallel ? ['--parallel', String(w.parallel)] : []),
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

/**
 * How many turns of its own the model has had in this attempt: its next
 * step's index. A turn in prose counts as one, so that a session that resumes
 * after a granted wait_for goes on from the step after it.
 */
export const roundsOf = (messages) => (messages ?? []).filter((m) => m.role === 'assistant' && (m.tool_calls?.length || (typeof m.content === 'string' && m.content.length > 0))).length;

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
    // A turn the model ends in prose, as a granted wait_for's attempt does; the round it counts is the one a resumed session replays.
    if (step.say) return { content: step.say, costUsd: TURN_COST_USD, role, key, attempt, round };
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

const runnerTurns = (requests, key) => requests.filter((r) => r.turn?.role === 'runner' && r.turn.key === key);
const atOf = (r) => Date.parse(r.at);
const lastUser = (r) => text([...(r.messages ?? [])].reverse().find((m) => m.role === 'user'));
/** The request that answers a step: the next turn of its attempt. */
const answerTo = (turns, ask) => turns.find((r) => r.turn.attempt === ask.turn.attempt && r.turn.round === ask.turn.round + 1);
/** The script a request's attempt plays, as the fake picks it (the last one serves any later attempt). */
const scriptOf = (s, ctx, key, attempt) => { const all = s.attempts(ctx)[key] ?? []; return all[Math.min(attempt, all.length) - 1] ?? []; };

/**
 * The failures of every step a scenario scripts as `refused`: the built-in
 * shell's guard must answer it, before it runs, with the reason and the call
 * to make instead, so the attempt does not sleep for the time the step names.
 */
export function judgeRefusals(name, requests, ctx) {
  const s = scenario(name);
  const f = [];
  for (const key of Object.keys(s.attempts?.(ctx) ?? {})) {
    scriptOf(s, ctx, key, 1).forEach((step, round) => {
      if (!step.refused) return;
      const mine = runnerTurns(requests, key).filter((r) => r.turn.attempt === 1);
      const asked = mine.find((r) => r.turn.round === round);
      const answered = mine.find((r) => r.turn.round === round + 1);
      const said = text((answered?.messages ?? []).at(-1));
      if (!asked || !answered) f.push(`task ${key}: the step ${JSON.stringify(step.args.command)} was never answered`);
      else if (!WAIT_REFUSAL.test(said)) f.push(`task ${key}: ${JSON.stringify(step.args.command)} was not refused as a wait (the reply: ${said.slice(0, 200)})`);
      else if (!said.includes('`wait_for`')) f.push(`task ${key}: the refusal does not name wait_for: ${said.slice(0, 300)}`);
      else if (atOf(answered) - atOf(asked) > 30_000) f.push(`task ${key}: the refused command took ${Math.round((atOf(answered) - atOf(asked)) / 1000)} s to answer, so something ran`);
    });
  }
  return f;
}

/**
 * The failures of a wait scenario, from the fake's request log (each line
 * { at, messages, turn }) and the session's final plan (its tasks, by order):
 * the parker's wait_for is granted and its attempt ends in prose with no
 * verdict; the plan holds the edge; the slot goes to the third task while the
 * awaited one is still at work; the parker goes on only after the awaited
 * task's last turn, in the same session, told what landed; and it lands.
 */
export function judgeWait(name, requests, ctx, plan) {
  const s = scenario(name);
  if (!s.wait) return [];
  const w = s.wait;
  const f = [];
  const parker = runnerTurns(requests, w.parker);
  const awaited = runnerTurns(requests, w.awaited);
  const other = runnerTurns(requests, w.other);
  const call = parker.find((r) => r.turn.toolCall?.name === 'wait_for');
  if (!call) return [`task ${w.parker} never called wait_for`];
  const reply = text((answerTo(parker, call)?.messages ?? []).at(-1));
  if (!new RegExp(`Waiting for [^"]*"${w.landed}"`).test(reply)) f.push(`wait_for was not granted for "${w.landed}": ${reply.slice(0, 300) || 'no answer reached the fake'}`);
  const ended = awaited.find((r) => r.turn.toolCall?.name === 'task_complete');
  if (!ended) f.push(`task ${w.awaited} never reported`);
  const cont = parker.find((r) => atOf(r) > atOf(call) && (r.turn.attempt > call.turn.attempt || r.turn.round > call.turn.round + 1));
  if (!cont) return [...f, `task ${w.parker} never went on after its wait`];
  // No verdict: the attempt said its last in prose, and nothing it reports counted before it was continued.
  const early = parker.find((r) => r.turn.toolCall?.name === 'task_complete' && atOf(r) < atOf(cont));
  if (early) f.push(`task ${w.parker} reported before it was continued, so its attempt did not end without a verdict`);
  if (ended && !(atOf(cont) > atOf(ended))) f.push(`task ${w.parker} went on (${cont.at}) before task ${w.awaited}'s last turn (${ended.at}): the work had not landed`);
  if (cont.turn.attempt !== call.turn.attempt) f.push(`task ${w.parker} did not continue its session: it started attempt ${cont.turn.attempt} (a fresh one)`);
  const told = (cont.messages ?? []).filter((m) => m.role === 'user').map(text).find((t) => /The work you waited for has landed/.test(t)) ?? '';
  if (!told.includes(`"${w.landed}"`)) f.push(`task ${w.parker}'s request after the wait does not say what landed ("${w.landed}"): ${lastUser(cont).slice(0, 300)}`);
  // The slot: the third task, queued behind the limit, starts after the park and before the awaited task is done.
  const first = other.find((r) => r.turn.attempt === 1 && r.turn.round === 0);
  if (!first) f.push(`task ${w.other} never started`);
  else {
    if (!(atOf(first) > atOf(call))) f.push(`task ${w.other} started (${first.at}) before ${w.parker}'s wait_for (${call.at}): it was never queued behind the limit`);
    if (ended && !(atOf(first) < atOf(ended))) f.push(`task ${w.other} started (${first.at}) only after task ${w.awaited}'s last turn (${ended.at}): the slot was not free while it waited`);
  }
  // It makes its edit and lands: every step it must see exit 0 did, and its last step was played.
  const steps = scriptOf(s, ctx, w.parker, cont.turn.attempt);
  steps.forEach((step, round) => {
    if (!step.exit0) return;
    const mine = parker.filter((r) => r.turn.attempt === cont.turn.attempt);
    const answered = mine.find((r) => r.turn.round === round + 1);
    if (!answered) f.push(`task ${w.parker}: no answer to ${step.args?.command} reached the fake`);
    else if (exitOf((answered.messages ?? []).at(-1)) !== 0) f.push(`task ${w.parker}: ${step.args?.command} exited ${exitOf((answered.messages ?? []).at(-1))}, wanted 0: ${text((answered.messages ?? []).at(-1)).slice(-300)}`);
  });
  if (!parker.some((r) => r.turn.toolCall?.name === 'task_complete' && atOf(r) > atOf(cont))) f.push(`task ${w.parker} never reported after it went on`);
  // The plan: the parker depends on the awaited task, and holds the wait it saved.
  const [first1, second] = [plan?.[0], plan?.[1]];
  if (!first1 || !second) return [...f, 'the session\'s final plan could not be read'];
  if (!(second.dependencies ?? []).includes(first1.id)) f.push(`the plan does not show task #2 depending on #1: its dependencies are ${JSON.stringify(second.dependencies)}`);
  if ((first1.dependencies ?? []).length > 0) f.push(`the awaited task #1 gained dependencies: ${JSON.stringify(first1.dependencies)}`);
  if (!(second.parked?.waitsOn ?? []).includes(first1.id)) f.push(`task #2 holds no park on #1 (parked: ${JSON.stringify(second.parked ?? null)})`);
  return f;
}

/**
 * The failures of the landed-blocker scenario: the first supervisor request
 * whose newest message holds the landed-blocker line also holds the closing
 * check and the advice, and the supervisor answered it; the final plan holds
 * exactly one added fix task that depends on the opening task, which the
 * closing check waits for; and the fix's last turn came before the closing
 * check's first, whose own check of the fix's file saw it.
 */
export function judgeBlocker(name, requests, ctx, plan) {
  const s = scenario(name);
  if (!s.blocker) return [];
  const b = s.blocker;
  const f = [];
  const wake = requests.find((r) => r.turn?.role === 'supervisor' && LANDED_BLOCKER_LINE.test(lastUser(r)));
  if (!wake) f.push('no supervisor request held the landed-blocker line (a wake naming #1 landed and 1 task reporting a blocker)');
  else {
    const said = lastUser(wake);
    if (!said.includes(`the closing check is ${b.closing}`)) f.push(`the wake does not name the closing check ${b.closing}: ${(LANDED_BLOCKER_LINE.exec(said)?.input ?? said).slice(0, 400)}`);
    if (!LANDED_BLOCKER_ADVICE.test(said)) f.push('the wake holds the line but not the guidance (fix it once, by one task)');
    if (wake.turn.rule === undefined) f.push('the supervisor did not answer the wake with the scenario\'s edit');
  }
  const fixes = (plan ?? []).filter((t) => t.title === b.fix);
  const opening = plan?.[0];
  const closing = (plan ?? []).find((t) => t.title === b.closingTitle);
  if (!plan || !opening || !closing) return [...f, 'the session\'s final plan could not be read'];
  if (plan.length !== b.tasks || fixes.length !== 1) f.push(`the plan holds ${plan.length} tasks, ${fixes.length} of them the fix; wanted ${b.tasks} with one`);
  const fix = fixes[0];
  if (fix) {
    if (!(fix.dependencies ?? []).includes(opening.id)) f.push(`the fix does not depend on the opening task: ${JSON.stringify(fix.dependencies)}`);
    if (!(closing.dependencies ?? []).includes(fix.id)) f.push(`the closing check does not wait for the fix: ${JSON.stringify(closing.dependencies)}`);
    if (fix.status !== 'completed') f.push(`the fix is ${fix.status}, not completed`);
  }
  const fixTurns = runnerTurns(requests, b.fixKey);
  const checkTurns = runnerTurns(requests, b.check);
  const fixEnd = fixTurns.find((r) => r.turn.toolCall?.name === 'task_complete');
  const checkStart = checkTurns.find((r) => r.turn.attempt === 1 && r.turn.round === 0);
  if (!fixEnd) f.push('the fix never reported');
  else if (!checkStart) f.push('the closing check never started');
  else if (!(atOf(checkStart) > atOf(fixEnd))) f.push(`the closing check started (${checkStart.at}) before the fix's last turn (${fixEnd.at})`);
  scriptOf(s, ctx, b.check, 1).forEach((step, round) => {
    if (!step.exit0) return;
    const answered = checkTurns.find((r) => r.turn.attempt === 1 && r.turn.round === round + 1);
    if (!answered) f.push(`the closing check: no answer to ${step.args?.command} reached the fake`);
    else if (exitOf((answered.messages ?? []).at(-1)) !== 0) f.push(`the closing check: ${step.args?.command} exited ${exitOf((answered.messages ?? []).at(-1))}, wanted 0: the fix had not landed in its tree`);
  });
  return f;
}

/**
 * The failures of a control-arm scenario: what result.json says of each
 * continuation (the verdict of the attempt before it, in order, the message
 * itself, the calls and spend so far, and what its own attempt did), why the
 * run stopped continuing, and, from the fake's request log, that the one
 * fixed message reached the runner once per continuation in the same
 * session, the task's own first message still the first.
 */
export function judgeContinued(name, result, requests, message) {
  const s = scenario(name);
  if (!s.continued) return [];
  const want = s.continued;
  const f = [];
  if (result?.arm !== 'A-continued') f.push(`the run's arm is ${JSON.stringify(result?.arm)}, not A-continued`);
  const c = result?.continuation;
  if (!c) return [...f, 'result.json holds no continuation record'];
  if (c.message !== message) f.push(`the continuation message is ${JSON.stringify(c.message)}, not the harness's constant`);
  if (!c.margins || !(c.margins.minWallMs > 0) || !(c.margins.minUsd > 0) || !(c.margins.max > 0)) f.push(`the record holds no margins: ${JSON.stringify(c.margins ?? null)}`);
  const records = c.continuations ?? [];
  const verdicts = records.map((r) => r.after?.verdict);
  if (JSON.stringify(verdicts) !== JSON.stringify(want.verdicts)) f.push(`the continuations followed ${JSON.stringify(verdicts)}, wanted ${JSON.stringify(want.verdicts)}`);
  if (c.count !== records.length) f.push(`count is ${c.count} for ${records.length} records`);
  if (c.first?.verdict !== want.verdicts[0]) f.push(`the first attempt ended ${JSON.stringify(c.first?.verdict)}, wanted ${want.verdicts[0]}`);
  let prev = { callsSoFar: 0, spentUsd: 0, at: '' };
  records.forEach((r, i) => {
    const who = `continuation ${i + 1}`;
    if (r.n !== i + 1) f.push(`${who} is numbered ${r.n}`);
    if (r.mode !== 'session' || !['continue', 'message'].includes(r.via)) f.push(`${who} was ${r.mode} (${r.via}), not the saved session continued`);
    if (want.vias && r.via !== want.vias[i]) f.push(`${who} went in by ${JSON.stringify(r.via)}, wanted ${JSON.stringify(want.vias[i])}`);
    if (!r.at || Number.isNaN(Date.parse(r.at)) || r.at < prev.at) f.push(`${who} has no time, or one before the last's (${r.at})`);
    if (!(r.callsSoFar > prev.callsSoFar)) f.push(`${who}: ${r.callsSoFar} calls so far, not more than ${prev.callsSoFar}`);
    if (typeof r.spentUsd !== 'number' || r.spentUsd < prev.spentUsd) f.push(`${who}: spend so far ${r.spentUsd} is under the last's ${prev.spentUsd}`);
    if (['failed', 'done'].includes(r.after?.verdict) && !r.after.summary) f.push(`${who} records no summary of the ${r.after.verdict} attempt before it`);
    // The last record is the one a stop may have cut: only what ended is judged.
    if (r.calls !== null && want.busy[i] !== undefined) {
      const busy = r.calls > (c.margins?.giveUpCalls ?? 2) || r.treeChanged === true;
      if (busy !== want.busy[i]) f.push(`${who}'s attempt made ${r.calls} calls and ${r.treeChanged ? 'changed' : 'left'} the tree: ${busy ? 'busy' : 'idle'}, wanted ${want.busy[i] ? 'busy' : 'idle'}`);
    }
    prev = r;
  });
  if ((c.stop?.why ?? null) !== want.stop) f.push(`the continuation stopped for ${JSON.stringify(c.stop?.why ?? null)}, wanted ${JSON.stringify(want.stop)}`);
  // From the fake: the same attempt of the same session heard the message once per continuation.
  const mine = requests.filter((r) => r.turn?.role === 'runner' && r.turn.key === 'A');
  if (!mine.length) return [...f, 'the fake heard no request of the task'];
  const users = (r) => (r.messages ?? []).filter((m) => m.role === 'user').map(text);
  const most = Math.max(...mine.map((r) => users(r).filter((t) => t.includes(message)).length));
  if (most !== records.length) f.push(`the runner was sent the message ${most} time(s) in its session, wanted ${records.length}`);
  const firstGoal = users(mine[0])[0];
  if (mine.some((r) => users(r)[0] !== firstGoal)) f.push('a request does not open on the task\'s own first message: a continuation started a conversation of its own');
  if (mine.some((r) => r.turn.attempt !== 1)) f.push('the fake counted a second attempt: the saved session was not what was continued');
  return f;
}

/**
 * The failures of a scenario that sets the single agent's reasoning effort
 * (--effort-a): every request the runner made for the task carries it, as
 * OpenRouter takes it, in the body's `reasoning.effort` (core's chat
 * completions dialect), which the fake logs as `reasoning`.
 */
export function judgeEffort(name, requests) {
  const want = scenario(name).effortA;
  if (!want) return [];
  const mine = requests.filter((r) => r.turn?.role === 'runner' && r.turn.key === 'A');
  if (!mine.length) return ['the fake heard no request of the task, so the effort it ran at cannot be read'];
  const carried = mine.filter((r) => r.reasoning?.effort === want).length;
  const seen = [...new Set(mine.map((r) => JSON.stringify(r.reasoning ?? null)))].join(', ');
  return carried === mine.length ? [] : [`${carried} of ${mine.length} requests of the task carried reasoning effort "${want}" (seen: ${seen})`];
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
export function judgeBatch(record, { lib, arm, rehearsal, taskSettings = {} }) {
  if (!record) return ['no batch.json'];
  const f = [];
  if (record.rehearsal !== rehearsal) f.push(`batch.json is not marked as rehearsal ${rehearsal} (${JSON.stringify(record.rehearsal ?? null)})`);
  if (record.keyBeforeUsd !== null || record.keyAfterUsd !== null || record.keyReadings?.length) f.push('the batch read the key\'s usage (a key reading in batch.json): a rehearsal has no key to read');
  if (JSON.stringify(record.taskSettings ?? null) !== JSON.stringify(taskSettings)) f.push(`batch.json records task settings ${JSON.stringify(record.taskSettings ?? null)}, wanted ${JSON.stringify(taskSettings)}`);
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
  if (want.ops) {
    const ops = acts.filter((a) => a.kind === 'plan_edit').map((a) => a.op);
    if (JSON.stringify(ops) !== JSON.stringify(want.ops)) f.push(`the plan edits are ${JSON.stringify(ops)}, wanted ${JSON.stringify(want.ops)}`);
  }
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
  for (const k of ['by', 'status', 'reason', 'cap', 'why']) if (k in want && end[k] !== want[k]) f.push(`ending.${k} is ${JSON.stringify(end[k])}, wanted ${JSON.stringify(want[k])}`);
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
  if (e.parallel !== undefined) want(result.parallel === e.parallel, `the run's parallel limit is ${JSON.stringify(result.parallel)}, wanted ${e.parallel}`);
  if (e.parkedAttempts) {
    const ended = ((result.metrics?.perTask ?? []).find((t) => t.order === e.parkedAttempts.order)?.attempts ?? []).map((x) => x.ended);
    want(JSON.stringify(ended) === JSON.stringify(e.parkedAttempts.ended), `task #${e.parkedAttempts.order}'s attempts ended ${JSON.stringify(ended)}, wanted ${JSON.stringify(e.parkedAttempts.ended)}`);
  }
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
  want(Number.isInteger(result.callBudget) && result.callBudget >= 1 && result.stepLimit === result.callBudget, `callBudget is ${JSON.stringify(result.callBudget)} (stepLimit ${JSON.stringify(result.stepLimit)}): the budget the arm ran with is not recorded`);
  want(typeof result.referenceSpend?.priceTable?.id === 'string' && 'referenceUsd' in result, `result.json holds no spend at the reference price table (referenceSpend ${JSON.stringify(result.referenceSpend ?? null)})`);
  if (scenario(name).supervision) f.push(...judgeSupervision(scenario(name).supervision, result.metrics?.supervisor));
  if (e.testExcluded) {
    want((result.excluded ?? []).some((x) => /test/.test(x.path ?? '') && /test/.test(x.reason ?? '')), `no test file in excluded (${JSON.stringify(result.excluded ?? null)}): the edited test was scored`);
  }
  return f;
}
