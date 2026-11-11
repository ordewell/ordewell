#!/usr/bin/env node
/**
 * Drive the REAL planner conversation loop (OpenAiService.startConversation /
 * continueConversation from @ordewell/core) end-to-end against either:
 *
 *   - the local cheap-model simulator (default; start it first:
 *       node bench/live/mock-provider.mjs
 *     then:
 *       node bench/live/drive-conversation.mjs
 *     runs the full scripted scenario suite with assertions), or
 *
 *   - a REAL model over OpenRouter (no assertions — prints the transcripts and
 *     writes a behavioural report):
 *       OPENROUTER_API_KEY=sk-or-... node bench/live/drive-conversation.mjs \
 *         --real --model deepseek/deepseek-v4-flash [--out DIR]
 *     (`MODEL` in the environment works too, as in drive-taskops.mjs.)
 *
 * The mock suite includes one scenario per kind of goal the strategy step
 * teaches (#108): a question, a small effect, a build, a failure to explain and
 * an open problem. Their personas reply with that kind's plumbing, and the
 * driver asserts the real Session accepts it: a plan committed with vertical
 * slices, a `run_script` call that adds and runs a script task, research tasks
 * approved and started, and a loop whose check is the reproduction. `--real`
 * replays the same five goals and reports the strategy each one was given —
 * observed, never graded, and with no cost or performance claim.
 *
 * `--real --goal "..."` still runs one goal, with `--replies a::b` answered in
 * turn, as before.
 *
 * The API key is always taken from the environment — never hardcoded.
 * Requires `npm run build:core` first (imports the built core).
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GOAL_SCENARIOS } from './scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(path.join(__dirname, '../../packages/core/dist/index.mjs')).href);
const { OpenAiService, extractPrdBlock } = core;

// ---------- CLI args ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const REAL = process.argv.includes('--real');
const GRILLING = process.argv.includes('--grilling');
const PRD = process.argv.includes('--prd');
const MODEL = arg('model', REAL ? (process.env.MODEL || '') : 'mock/interviewer');
const GOAL = arg('goal', 'make this project better');
const REPLIES = (arg('replies', '') || '').split('::').filter(Boolean);
const BASE_URL = REAL ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') : `http://127.0.0.1:${arg('port', '3799')}/v1`;
const API_KEY = REAL ? process.env.OPENROUTER_API_KEY : 'mock-key';

if (REAL && !API_KEY) {
  console.error('OPENROUTER_API_KEY is required for --real runs (pass it via the environment, never hardcode it).');
  process.exit(2);
}
if (REAL && !MODEL) {
  console.error('--real needs --model (or MODEL in the environment): there is no mock persona to pick a real model by.');
  process.exit(2);
}

// ---------- sandbox workspace ----------
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-live-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo project\n\nA tiny demo app. TODO: add tests.\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function main() {\n  console.log("demo");\n}\n');
  return dir;
}

/** Minimal IFileSystem over the sandbox — same contract the surfaces implement. */
function makeFs(root) {
  const exec = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ success: !err, output: (stdout || '') + (err ? String(stderr || err.message) : ''), truncated: false });
    });
  });
  const read = async (p, opts = {}) => {
    try {
      const full = path.resolve(root, p);
      let text = fs.readFileSync(full, 'utf8');
      const max = opts.maxBytes ?? 100_000;
      const truncated = text.length > max;
      if (truncated) text = text.slice(0, max);
      return { success: true, output: text, truncated };
    } catch (err) {
      return { success: false, output: String(err.message), truncated: false };
    }
  };
  return {
    readFile: read,
    readFiles: async (paths) => {
      const parts = [];
      for (const p of paths) parts.push(`=== ${p} ===\n${(await read(p)).output}`);
      return { success: true, output: parts.join('\n\n'), truncated: false };
    },
    glob: (pattern) => exec('sh', ['-c', `find . -path './node_modules' -prune -o -name ${JSON.stringify(pattern.replace(/^.*\//, ''))} -print | head -50`]),
    grep: (pattern, include) => exec('sh', ['-c', `grep -rn ${JSON.stringify(pattern)} . ${include ? `--include=${JSON.stringify(include)}` : ''} | head -50`]),
    listDir: (p) => exec('sh', ['-c', `find ${JSON.stringify(p || '.')} -maxdepth 3 -not -path '*/node_modules*' | head -100`]),
    bash: (command) => exec('sh', ['-c', command]),
    getWorkspaceRoot: () => root,
  };
}

// ---------- progress trace ----------
function makeTrace() {
  const events = [];
  let thinkingChars = 0;
  let firstThinkingAt = null;
  const started = Date.now();
  const onProgress = (p) => {
    if (p.type === 'thinking') {
      thinkingChars += (p.text ?? '').length;
      if (firstThinkingAt === null) firstThinkingAt = Date.now() - started;
      return;
    }
    if (p.type === 'tool_call') events.push({ t: 'tool_call', tool: p.tool, args: p.toolArgs });
    if (p.type === 'tool_result') events.push({ t: 'tool_result', tool: p.step?.tool });
    if (p.type === 'plan_token') {
      const last = events[events.length - 1];
      if (last?.t === 'stream') last.chars += (p.planToken ?? '').length;
      else events.push({ t: 'stream', chars: (p.planToken ?? '').length });
    }
  };
  return { events, onProgress, stats: () => ({ thinkingChars, firstThinkingAt, events }) };
}

const cfg = (model) => ({
  aiProvider: 'openrouter',
  apiKey: API_KEY,
  planningModel: model,
  enabledRunners: ['claude-code'],
  maxParallelSessions: 3,
  researchEnabled: true,
  researchMaxSteps: 8,
  researchMaxFileSize: 50_000,
  openAiBaseUrl: BASE_URL,
  openAiApiKey: API_KEY,
  openrouterKey: API_KEY,
  geminiKey: '',
  openaiCompatibleBaseUrl: '',
  openaiCompatibleApiKey: '',
  sttModel: 'openai/whisper-large-v3-turbo',
  orchestratorModel: model,
  geminiModel: '',
  researchSubagentModel: '',
  autonomousMode: true,
  worktreeIsolation: false,
  workspaceRepos: [],
  worktreeLinks: [],
  conflictRepairAttempts: 0,
  approvalMode: 'allow',
  approvalPreApproved: [],
  effectAllowlist: [],
  getProviderBaseUrl: () => BASE_URL,
  getProviderApiKey: () => API_KEY,
  setProviderModelLists: () => {},
});

const MODELS_BY_RUNNER = {
  'claude-code': [
    { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash', variants: [] },
    { modelId: 'anthropic/claude-sonnet-4.5', modelLabel: 'Claude Sonnet 4.5', variants: [] },
  ],
};
const RUNNER_MODES = {
  'claude-code': [
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Edit automatically', tags: ['autonomous'] },
    { id: 'default', label: 'Default', description: 'Ask before edits', tags: ['safe'] },
    // Tagged read-only as the shipped manifest does (ADR-0046), so a plan with
    // research tasks can be submitted here exactly as in the app.
    { id: 'plan', label: 'Read-only', description: 'Reads and sealed commands; lands nothing', readOnly: true, tags: [] },
  ],
};

async function runConversation({ model, goal, grilling, prd, replies, label }) {
  const root = makeSandbox();
  const service = new OpenAiService(cfg(model));
  const trace = makeTrace();
  const transcript = [];
  const findings = [];

  const record = (who, text) => transcript.push({ who, text });

  record('user', goal);
  let turn = await service.startConversation({
    goal,
    runners: ['claude-code'],
    modelsByRunner: MODELS_BY_RUNNER,
    runnerModes: RUNNER_MODES,
    autonomousDefault: true,
    grillingEnabled: grilling,
    prdEnabled: prd,
    fs: makeFs(root),
    onProgress: trace.onProgress,
  });

  let prdBlock = null;
  let turns = 1;
  const MAX_TURNS = 2 + replies.length + 4;

  while (turn.kind === 'message' && turns < MAX_TURNS) {
    record('planner', turn.text);
    if (!turn.text.trim()) findings.push('planner returned an EMPTY message turn — UI would render a blank bubble');
    const maybePrd = extractPrdBlock(turn.text);
    if (maybePrd) prdBlock = maybePrd;

    const reply = replies.shift();
    if (!reply) break;
    record('user', reply);
    turn = await service.continueConversation(reply, trace.onProgress);
    turns++;
  }

  if (turn.kind === 'plan') {
    // The PRD may arrive in the same turn as the plan JSON (core's missing-PRD
    // nudge asks for exactly that), so check the plan turn's text too.
    const maybePrd = extractPrdBlock(turn.text ?? '');
    if (maybePrd) prdBlock = maybePrd;
    record('plan', `${turn.tasks.length} task(s): ${turn.tasks.map((t) => `[${t.type}] ${t.title}`).join(' | ')}`);
  }

  return { label, turn, transcript, findings, trace: trace.stats(), prdBlock, hasActive: service.hasActiveConversation() };
}

function printRun(run) {
  console.log(`\n=== ${run.label} ===`);
  for (const m of run.transcript) {
    const head = m.who === 'user' ? '>> USER' : m.who === 'plan' ? '** PLAN COMMITTED' : '<< PLANNER';
    console.log(`${head}: ${m.text.length > 400 ? m.text.slice(0, 400) + ` …[${m.text.length} chars]` : m.text}`);
  }
  const toolLine = run.trace.events.filter((e) => e.t === 'tool_call').map((e) => e.tool).join(', ');
  console.log(`-- tools: [${toolLine}] thinkingChars=${run.trace.thinkingChars} firstThinkingAt=${run.trace.firstThinkingAt}ms`);
  if (run.findings.length) console.log(`-- findings: ${run.findings.join(' | ')}`);
  // --dump DIR: write the untruncated transcript for offline diagnosis of
  // parse failures the 400-char console preview hides.
  const dumpDir = arg('dump', null);
  if (dumpDir) {
    fs.mkdirSync(dumpDir, { recursive: true });
    const file = path.join(dumpDir, `${run.label.replace(/[^a-z0-9-]+/gi, '_')}.txt`);
    fs.writeFileSync(file, run.transcript.map((m) => `${m.who.toUpperCase()}:\n${m.text}\n`).join('\n----\n'));
    console.log(`-- full transcript: ${file}`);
  }
}

function assert(cond, msg, failures) {
  if (!cond) failures.push(msg);
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
}

async function mockSuite() {
  const failures = [];

  // 1. Grilling interview: explores first, asks one question at a time with a
  //    recommendation, transitions to outline, commits a fenced+trailing-comma plan.
  {
    const run = await runConversation({
      label: 'grilling interview (mock/interviewer)',
      model: 'mock/interviewer', goal: 'make this project better',
      grilling: true, prd: false,
      replies: ['focus on code health', 'node:test please', 'confirm'],
    });
    printRun(run);
    const plannerMsgs = run.transcript.filter((m) => m.who === 'planner');
    assert(run.trace.events.some((e) => e.t === 'tool_call'), 'explored the workspace before asking', failures);
    assert(plannerMsgs.length === 3, `held a 3-message dialogue before committing (got ${plannerMsgs.length})`, failures);
    assert(plannerMsgs[0]?.text.includes('Question'), 'first turn is a question, not a plan', failures);
    assert(run.turn.kind === 'plan', 'committed the plan after outline confirmation', failures);
    assert(run.turn.kind === 'plan' && run.turn.tasks.length === 2, 'fenced JSON with trailing comma parsed into 2 tasks', failures);
    assert(!run.hasActive, 'conversation is closed after the plan commit', failures);
    assert(run.trace.thinkingChars > 0, 'reasoning was streamed to the thinking channel', failures);
  }

  // 2. Eager planner under grilling: the gate bounces the instant commit ONCE;
  //    when the model insists (this persona always re-emits the plan), the plan
  //    still commits — the model decides transitions, the gate never blocks.
  {
    const run = await runConversation({
      label: 'eager planner ignores grilling (mock/eager-planner)',
      model: 'mock/eager-planner', goal: 'make this project better',
      grilling: true, prd: false, replies: [],
    });
    printRun(run);
    assert(run.turn.kind === 'plan', 'an insistently re-emitted valid plan commits after the one gate nudge', failures);
  }

  // 3. Research → preamble + fenced JSON (non grilling).
  {
    const run = await runConversation({
      label: 'research then fenced plan (mock/fenced-json)',
      model: 'mock/fenced-json', goal: 'add a test harness',
      grilling: false, prd: false, replies: [],
    });
    printRun(run);
    assert(run.trace.events.filter((e) => e.t === 'tool_call').length === 2, 'two research tool calls executed', failures);
    assert(run.turn.kind === 'plan', 'plan with prose preamble + fences parsed', failures);
  }

  // 4. PRD flow: preview → marker-wrapped PRD extracted → plan.
  {
    const run = await runConversation({
      label: 'PRD preview, markers, plan (mock/prd-flow)',
      model: 'mock/prd-flow', goal: 'add a widget',
      grilling: false, prd: true,
      replies: ['I agree with the preview', 'confirm, generate the plan'],
    });
    printRun(run);
    assert(run.prdBlock !== null, 'PRD markers detected and extracted', failures);
    assert(run.prdBlock?.slug === 'demo-widget', `PRD slug is the agreed one (got ${run.prdBlock?.slug})`, failures);
    assert(run.prdBlock?.markdown.startsWith('# PRD: Demo Widget'), 'PRD markdown captured without the markers', failures);
    assert(run.turn.kind === 'plan', 'plan committed after PRD + outline confirmation', failures);
  }

  // 5. Empty content turn after tool use — must not crash; surfaces as a finding.
  {
    const run = await runConversation({
      label: 'empty assistant turn (mock/empty-turn)',
      model: 'mock/empty-turn', goal: 'do something',
      grilling: false, prd: false, replies: [],
    });
    printRun(run);
    assert(run.turn.kind === 'message', 'empty turn classified as message (no crash)', failures);
  }

  console.log('\n========================');
  if (failures.length) {
    console.log(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('all scenario assertions passed');
}

async function realRun() {
  const run = await runConversation({
    label: `REAL ${MODEL}${GRILLING ? ' +grilling' : ''}${PRD ? ' +prd' : ''}`,
    model: MODEL, goal: GOAL, grilling: GRILLING, prd: PRD, replies: [...REPLIES],
  });
  printRun(run);
  console.log('\nBehavioral report:');
  console.log(`  final turn: ${run.turn.kind}`);
  console.log(`  explored before answering: ${run.trace.events.some((e) => e.t === 'tool_call')}`);
  const questionTurns = run.transcript.filter((m) => m.who === 'planner' && m.text.includes('?')).length;
  console.log(`  planner turns containing a question: ${questionTurns}`);
  if (GRILLING) {
    const first = run.transcript.find((m) => m.who === 'planner');
    console.log(`  grilling first turn was a question (heuristic '?'): ${first ? first.text.includes('?') : 'n/a'}`);
  }
  if (PRD) console.log(`  PRD extracted: ${run.prdBlock ? `yes (slug=${run.prdBlock.slug})` : 'no'}`);
}

if (REAL) {
  // A single goal with --goal keeps the old one-off behaviour; otherwise the
  // report covers every kind the strategy step teaches.
  if (process.argv.includes('--goal')) await realRun();
  else await realGoalsReport();
} else {
  await mockSuite();
}

// ---------- full Session scenario (production wiring incl. PRD save) ----------
async function sessionSuite() {
  const { createSession, RunnerRegistry, ModelResolver } = core;
  const failures = [];
  const root = makeSandbox();
  const registry = new RunnerRegistry();
  const config = cfg('mock/prd-flow');
  const fakeExec = () => Promise.reject(new Error('no CLI in harness'));
  const modelResolver = new ModelResolver(registry, config, { execImpl: fakeExec });
  const broadcasts = [];
  const session = createSession({
    config,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
    registry,
    workspaceRoot: () => root,
    fsAdapter: makeFs(root),
    broadcast: (m) => broadcasts.push(m),
    modelResolver,
    settings: () => ({ grillingEnabled: false, prdEnabled: true }),
  });

  console.log('\n=== full Session: PRD flow with save-to-disk ===');
  let plan = await session.startPlanning('add a widget', ['claude-code']);
  assert(plan.conversationHistory?.length === 2, 'history holds goal + first planner message', failures);
  assert(session.isConversationActive, 'conversation active while planning', failures);

  plan = await session.continueConversation('I agree with the preview');
  assert(!!plan.prdMarkdown, 'prdMarkdown captured on plan state', failures);
  const prdPath = path.join(root, '.scratch', 'demo-widget', 'PRD.md');
  assert(fs.existsSync(prdPath), `PRD saved to ${path.relative(root, prdPath)}`, failures);

  plan = await session.continueConversation('confirm, generate the plan');
  assert(plan.tasks.length === 2, 'plan committed through Session', failures);
  assert(!session.isConversationActive, 'conversation closed after commit', failures);
  assert(broadcasts.some((m) => m.type === 'planner_message'), 'planner_message broadcasts emitted', failures);
  assert(broadcasts.some((m) => m.type === 'plan_generated'), 'plan_generated broadcast emitted', failures);
  const msgs = broadcasts.filter((m) => m.type === 'planner_message');
  assert(msgs.every((m) => m.content.trim().length > 0), 'no empty planner_message broadcast', failures);

  if (failures.length) {
    console.log(`${failures.length} SESSION FAILURE(S)`);
    process.exit(1);
  }
  console.log('session scenario passed');
}

if (!REAL) await sessionSuite();

// ---------- approval seam: command tiers, path confinement, resolveApproval ----------
// The conversation scenarios above run with approvalMode:'allow' over a
// hand-rolled fs, so the tier classifier, the confinement gate, and the
// PendingApprovals/SessionMessage round-trip are otherwise unexercised by CI.
// This suite drives them directly through a real BaseFileSystem adapter.
async function approvalsSuite() {
  const { BaseFileSystem } = core;
  const failures = [];
  const root = makeSandbox();

  class SandboxFs extends BaseFileSystem {
    constructor() { super(); }
    getWorkspaceRoot() { return root; }
    async readFileImpl(abs) { return { success: true, output: `body of ${abs}`, truncated: false }; }
    async globImpl() { return { success: true, output: '', truncated: false }; }
    async grepImpl() { return { success: true, output: '', truncated: false }; }
    async listDirImpl() { return { success: true, output: '', truncated: false }; }
    async execBashImpl(command) { return { success: true, output: `ran: ${command}`, truncated: false }; }
  }

  function makeApprovalSession(configOverrides = {}) {
    const broadcasts = [];
    const fsAdapter = new SandboxFs();
    const base = cfg('mock/prd-flow');
    const config = { ...base, approvalMode: 'ask', approvalPreApproved: [] };
    const session = core.createSession({
      config,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
      registry: new core.RunnerRegistry(),
      workspaceRoot: () => root,
      fsAdapter,
      broadcast: (m) => broadcasts.push(m),
      modelResolver: new core.ModelResolver(new core.RunnerRegistry(), config, { execImpl: () => Promise.reject(new Error('harness')) }),
      settings: () => ({ grillingEnabled: false }),
      ...configOverrides,
    });
    return { session, fsAdapter, broadcasts };
  }
  const approvalReqs = (b) => b.filter((m) => m.type === 'approval_request');
  const settled = (b) => b.filter((m) => m.type === 'approval_settled');

  // 1. auto-tier command: no prompt, runs silently.
  {
    const { fsAdapter, broadcasts } = makeApprovalSession();
    const result = await fsAdapter.bash('git log --oneline -5');
    assert(result.success === true, 'auto-tier git log runs without asking', failures);
    assert(approvalReqs(broadcasts).length === 0, 'auto-tier emits no approval_request', failures);
  }

  // 2. refuse-tier: never prompts; refused, or run sealed where the host has a
  //    sandbox (ADR-0036) — never in the workspace either way.
  {
    const { fsAdapter, broadcasts } = makeApprovalSession();
    const result = await fsAdapter.bash('rm -rf build');
    const sealed = /^\[Ran sealed/.test(result.output);
    assert(result.success === false || sealed, 'refuse-tier rm is refused, or runs sealed where the host has a sandbox', failures);
    assert(result.output.includes('refused') || sealed, 'the outcome says it was refused without asking', failures);
    assert(approvalReqs(broadcasts).length === 0, 'refuse-tier emits no approval_request', failures);
  }

  // 3. ask-tier command: broadcasts a request, resolveApproval(true) unblocks it.
  {
    const { session, fsAdapter, broadcasts } = makeApprovalSession();
    const pending = fsAdapter.bash('npm test');
    await new Promise((r) => setTimeout(r, 50));
    assert(approvalReqs(broadcasts).length === 1, 'ask-tier broadcasts one approval_request', failures);
    assert(approvalReqs(broadcasts)[0].scope === 'npm test', 'ask-tier scope is the command scope', failures);
    session.resolveApproval(approvalReqs(broadcasts)[0].id, true);
    const result = await pending;
    assert(result.success === true, 'granted ask-tier runs the command', failures);
    assert(result.output === 'ran: npm test', 'grant reaches execBashImpl', failures);
    assert(settled(broadcasts).length === 1 && settled(broadcasts)[0].granted === true, 'settlement broadcast on grant', failures);
  }

  // 4. ask-tier denied: refusal tool result, settlement broadcast.
  {
    const { session, fsAdapter, broadcasts } = makeApprovalSession();
    const pending = fsAdapter.bash('npm test');
    await new Promise((r) => setTimeout(r, 50));
    session.resolveApproval(approvalReqs(broadcasts)[0].id, false);
    const result = await pending;
    assert(result.success === false, 'denied ask-tier returns a failure', failures);
    assert(result.output.includes('not approved'), 'denial is actionable', failures);
    assert(settled(broadcasts)[0].granted === false, 'settlement broadcast on denial', failures);
  }

  // 5. out-of-workspace read: external_path request, scoped to the parent dir.
  {
    const { session, fsAdapter, broadcasts } = makeApprovalSession();
    const pending = fsAdapter.readFile('/tmp/ordewell-live-external/a.log');
    await new Promise((r) => setTimeout(r, 50));
    const req = approvalReqs(broadcasts)[0];
    assert(req && req.kind === 'external_path', 'out-of-workspace read requests external_path', failures);
    // Native: on Windows /tmp resolves onto the workspace's drive, with backslashes.
    assert(req.scope === path.join(path.resolve(root, '/tmp/ordewell-live-external'), '*'), 'scope is the containing directory', failures);
    session.resolveApproval(req.id, true);
    const result = await pending;
    assert(result.success === true, 'granted external read succeeds', failures);
  }

  // 6. remembered grant: a second read in the same dir does not re-prompt.
  {
    const { session, fsAdapter, broadcasts } = makeApprovalSession();
    const first = fsAdapter.readFile('/tmp/ordewell-live-external/a.log');
    await new Promise((r) => setTimeout(r, 50));
    session.resolveApproval(approvalReqs(broadcasts)[0].id, true);
    await first;
    const before = approvalReqs(broadcasts).length;
    await fsAdapter.readFile('/tmp/ordewell-live-external/b.log');
    assert(approvalReqs(broadcasts).length === before, 'remembered scope does not re-prompt', failures);
  }

  // 7. reset clears grants (T7).
  {
    const { session, fsAdapter, broadcasts } = makeApprovalSession();
    const first = fsAdapter.readFile('/tmp/ordewell-live-external/a.log');
    await new Promise((r) => setTimeout(r, 50));
    session.resolveApproval(approvalReqs(broadcasts)[0].id, true);
    await first;
    session.reset();
    const second = fsAdapter.readFile('/tmp/ordewell-live-external/b.log');
    await new Promise((r) => setTimeout(r, 50));
    assert(approvalReqs(broadcasts).length >= 2, 'reset re-prompts for a previously granted scope', failures);
    session.resolveApproval(approvalReqs(broadcasts)[approvalReqs(broadcasts).length - 1].id, false);
    await second;
  }

  if (failures.length) {
    console.log(`${failures.length} APPROVAL FAILURE(S)`);
    process.exit(1);
  }
  console.log('approvals scenario passed');
}

if (!REAL) await approvalsSuite();

// ---------- visibility seam: what the surfaces are actually told ----------
// Every surface renders the planner's exploration from the SessionMessage
// broadcast, so the contract that matters end-to-end is what lands there: one
// tool_call per announced call, one settled step per call carrying its own
// tool_call id and an honest outcome. A parallel round with a refused command
// and an out-of-workspace read exercises all four outcome classes at once.
async function visibilitySuite() {
  const { createSession, RunnerRegistry, ModelResolver, BaseFileSystem, classifyOutcome } = core;
  const failures = [];
  const root = makeSandbox();

  class SandboxFs extends BaseFileSystem {
    getWorkspaceRoot() { return root; }
    async readFileImpl(abs) { return { success: true, output: `body of ${abs}`, truncated: false }; }
    async globImpl() { return { success: true, output: '', truncated: false }; }
    async grepImpl() { return { success: true, output: '', truncated: false }; }
    async listDirImpl() { return { success: true, output: '', truncated: false }; }
    async execBashImpl(command) { return { success: true, output: `ran: ${command}`, truncated: false }; }
  }

  const registry = new RunnerRegistry();
  const config = { ...cfg('mock/visibility'), approvalMode: 'ask', approvalPreApproved: [] };
  const broadcasts = [];
  let session;
  const broadcast = (m) => {
    broadcasts.push(m);
    // Stand in for a user who says no, so the out-of-workspace read reaches a
    // real `denied` through the whole request/settle round trip.
    if (m.type === 'approval_request') queueMicrotask(() => session.resolveApproval(m.id, false));
  };
  session = createSession({
    config,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
    registry,
    workspaceRoot: () => root,
    fsAdapter: new SandboxFs(),
    broadcast,
    modelResolver: new ModelResolver(registry, config, { execImpl: () => Promise.reject(new Error('harness')) }),
    settings: () => ({ grillingEnabled: false }),
  });

  console.log('\n=== visibility: research stream reaches the surfaces intact ===');
  await session.startPlanning('look around', ['claude-code']);

  const calls = broadcasts.filter((m) => m.type === 'research_step');
  const dones = broadcasts.filter((m) => m.type === 'research_step_done');
  const byId = new Map(dones.map((m) => [m.step.toolCallId, m.step]));

  assert(calls.length === 4, `every announced call broadcasts research_step (got ${calls.length})`, failures);
  assert(dones.length === 4, `every call settles with research_step_done (got ${dones.length})`, failures);
  assert(calls.every((m) => !!m.toolCallId), 'research_step carries the tool_call id', failures);
  assert(byId.size === 4, 'each settled step carries its own tool_call id', failures);

  const outcomes = ['vc-1', 'vc-2', 'vc-3', 'vc-4'].map((id) => byId.get(id)?.outcome);
  // On a host with a sandbox, a refused command runs sealed instead (ADR-0036)
  // and honestly reports the run; without one, it is refused.
  const sealedBlocked = /^\[Ran sealed/.test(byId.get('vc-3')?.result ?? '');
  assert(
    JSON.stringify(outcomes.slice(0, 2)) === JSON.stringify(['success', 'success'])
      && (outcomes[2] === 'refused' || (outcomes[2] === 'success' && sealedBlocked))
      && outcomes[3] === 'denied',
    `outcomes are honest per call: ${JSON.stringify(outcomes)}${sealedBlocked ? ' (vc-3 ran sealed)' : ''}`,
    failures,
  );

  const refused = byId.get('vc-3');
  assert(refused?.success === false || sealedBlocked, 'a refused command is not reported as a success outside a sealed run', failures);
  assert((refused?.result ?? '').length > 0, 'the refusal reason reaches the surfaces', failures);
  assert(
    dones.every((m) => classifyOutcome(m.step.success, m.step.result) === m.step.outcome),
    'the shipped outcome matches what classifyOutcome derives from the same result',
    failures,
  );

  // Parallel same-tool calls must be distinguishable — a surface matching by
  // tool name alone would put vc-2's body on vc-1's line.
  assert(byId.get('vc-1')?.result !== byId.get('vc-2')?.result, 'parallel same-tool results stay distinct', failures);
  assert(
    broadcasts.some((m) => m.type === 'planner_thinking_delta' && m.text.length > 0),
    'reasoning is broadcast for the surfaces that render it',
    failures,
  );
  assert(broadcasts.some((m) => m.type === 'approval_request'), 'the out-of-scope read asked before denying', failures);

  if (failures.length) {
    console.log(`${failures.length} VISIBILITY FAILURE(S)`);
    process.exit(1);
  }
  console.log('visibility scenario passed');
}

if (!REAL) await visibilitySuite();

// ---------- task-query read channel: read-then-edit round trip ----------
// Every earlier suite drives generation. This is the one that proves the
// *read* channel (ADR-0012): a planner handed a plan it did not just generate
// can ask to see a task's full prompt — the plan context block deliberately
// omits it — get back exactly that detail, and land an edit derived from what
// it read, all inside one continued conversation over the real Session loop.
async function taskQuerySuite() {
  const { createSession, RunnerRegistry, ModelResolver, createTask } = core;
  const failures = [];
  const root = makeSandbox();
  const registry = new RunnerRegistry();
  const config = cfg('mock/task-query-editor');
  const modelResolver = new ModelResolver(registry, config, { execImpl: () => Promise.reject(new Error('no CLI in harness')) });
  const broadcasts = [];
  const session = createSession({
    config,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
    registry,
    workspaceRoot: () => root,
    fsAdapter: makeFs(root),
    broadcast: (m) => broadcasts.push(m),
    modelResolver,
    settings: () => ({ grillingEnabled: false }),
  });

  // A plan handed to the session already assembled — not one it just
  // generated — the same shape a reloaded session presents, so the read
  // channel is exercised against a cold conversation, not a warm one that
  // happens to still remember what it wrote.
  const scaffolding = createTask({
    id: 'aaaaaaaa-0000-4000-8000-000000000001', order: 1, title: 'Set up project scaffolding',
    description: 'Scaffold the repo', prompt: 'Set up scaffolding.', assignedRunner: 'claude-code',
  });
  const parser = createTask({
    id: 'bbbbbbbb-0000-4000-8000-000000000002', order: 2, title: 'Build parser',
    description: 'Parser task', assignedRunner: 'claude-code', dependencies: [scaffolding.id],
    // The marker lives only in the full prompt, which the per-turn plan
    // context block never sends — so the mock model can only echo it back
    // (in the taskOps edit that follows) if the taskQuery answer actually
    // carried it over the wire.
    prompt: 'Build the parser (MARKER-Q7F3K1). Read this before editing it.',
  });
  const plan = {
    tasks: [scaffolding, parser],
    generatedAt: new Date().toISOString(), status: 'draft', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'Build a small parser library', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: new Date().toISOString(), kind: 'plan_generated' },
    ],
  };
  session.loadPlan(plan, 'Build a small parser library', root, { persist: false });

  console.log('\n=== task-query read channel: read #2\'s prompt, then edit from it ===');
  const before = session.planTasks.find((t) => t.id === parser.id).description;
  const updated = await session.continueConversation('Please double-check task 2 reflects its real prompt before we proceed.');
  const task = updated.tasks.find((t) => t.id === parser.id);

  assert(before === 'Parser task', 'starting description is the unedited fixture value', failures);
  assert(!!task, 'task 2 still present after the round trip', failures);
  assert(task?.description === 'read-confirmed:MARKER-Q7F3K1', `edit carries the marker read off the real prompt (got "${task?.description}")`, failures);
  assert(broadcasts.some((m) => m.type === 'plan_generated'), 'plan re-broadcast once the edit landed', failures);
  // The read itself must never appear as a spurious plan/broadcast event on
  // its own — only the eventual applied edit does.
  const planBroadcasts = broadcasts.filter((m) => m.type === 'plan_generated');
  assert(planBroadcasts.length === 1, `exactly one plan_generated for the whole round trip (got ${planBroadcasts.length})`, failures);

  if (failures.length) {
    console.log(`${failures.length} TASK-QUERY FAILURE(S)`);
    process.exit(1);
  }
  console.log('task-query round trip passed');
}

if (!REAL) await taskQuerySuite();

// ---------- one scenario per kind of goal (#108) ----------
// The strategy step tells the planner what kind of goal it is looking at. These
// scenarios assert the plumbing each kind produces, through a real Session: the
// API planner submits a whole plan as the JSON envelope (the same commit path a
// harness planner's submit_plan reaches), `run_script` goes through the session's
// command seam, and the session validates, adopts and starts what arrives. What
// a real model CHOOSES is not asserted here — that is the --real report below.

/** A session that stays live and silent: research tasks start and wait, as they do while their runner works. */
function silentSession(taskId) {
  return {
    id: `silent-${taskId}`, taskId,
    onOutput() {}, onExit() {}, kill() {},
    async stop() {},
    getOutput: () => '',
    write() {},
    turnState: () => 'working',
    onTurnEnd() {}, onEvent() {},
    sendMessage: () => 'm1', forceSend: () => 'm2',
    forceSendQueued: () => true, removeQueued: () => true,
    queued: () => [], interrupt: async () => {},
    nativeSessionId: () => null,
    commands: () => [], invokeCommand: () => 'c1',
    answerPermission: () => false,
    onTaskComplete() {}, onToolCheckpoint() {}, onScriptExit() {},
  };
}

function silentRunner(spawned) {
  return {
    async spawn({ taskId }) {
      const session = silentSession(taskId);
      spawned.push(session);
      return session;
    },
    async stop() {},
    stopAll() {},
    get activeCount() { return 0; },
  };
}

/**
 * The real Session, over the mock provider, with the same wiring the PRD suite
 * uses. `approveScripts` stands in for a user answering the run_script card:
 * a script runs only on a yes, and this is the bench's yes.
 */
function makeGoalSession({ model, approveScripts = false }) {
  const { createSession, RunnerRegistry, ModelResolver } = core;
  const root = makeSandbox();
  const registry = new RunnerRegistry();
  const config = cfg(model);
  const modelResolver = new ModelResolver(registry, config, { execImpl: () => Promise.reject(new Error('no CLI in harness')) });
  const broadcasts = [];
  const spawned = [];
  let session;
  const broadcast = (m) => {
    broadcasts.push(m);
    if (approveScripts && m.type === 'approval_request') queueMicrotask(() => session.resolveApproval(m.id, true));
  };
  session = createSession({
    config,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    runner: silentRunner(spawned),
    registry,
    workspaceRoot: () => root,
    fsAdapter: makeFs(root),
    broadcast,
    modelResolver,
    settings: () => ({ grillingEnabled: false }),
  });
  return { session, broadcasts, spawned, root };
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)} …[${text.length} chars]` : text;
}

function taskLine(task) {
  const flags = `${task.research ? '+research' : task.taskMode === 'plan' ? '+readonly' : ''}${task.loop ? `+loop(${task.loop.body.length}·${task.loop.maxRounds})` : ''}`;
  return `${task.type}${flags} "${task.title}"`;
}

function printGoal(run) {
  console.log(`\n=== kind of goal: ${run.scenario.kind} (${run.scenario.persona}) ===`);
  for (const m of run.broadcasts.filter((m) => m.type === 'planner_message')) console.log(`<< PLANNER: ${clip(m.content, 300)}`);
  console.log(`-- plan: ${run.active ? 'still open (no commit)' : 'committed'}; tasks: ${run.tasks.length ? run.tasks.map(taskLine).join(' | ') : '(none)'}`);
  const tools = run.broadcasts.filter((m) => m.type === 'research_step_done').map((m) => m.step.toolLabel ?? m.step.tool);
  console.log(`-- tools: [${tools.join(', ')}]`);
  for (const task of run.tasks.filter((t) => t.verdict)) console.log(`-- verdict ${taskLine(task)}: ${task.verdict.outcome}`);
}

/** A read-only task is one a runner's read-only profile is tagged for; the shipped claude-code manifest calls it plan. */
const isReadOnly = (task) => task.taskMode === 'plan';

async function goalsSuite() {
  const failures = [];

  for (const scenario of GOAL_SCENARIOS) {
    const run = await (async () => {
      const parts = makeGoalSession({ model: scenario.persona, approveScripts: !!scenario.expect.script });
      const plan = await parts.session.startPlanning(scenario.goal, ['claude-code']);
      return {
        ...parts, scenario, plan,
        tasks: parts.session.planTasks.map((t) => ({ ...t })),
        active: parts.session.isConversationActive,
      };
    })();

    try {
      printGoal(run);
      const { expect } = scenario;

      if (expect.noPlan) {
        const said = run.broadcasts.filter((m) => m.type === 'planner_message').at(-1)?.content ?? '';
        assert(run.tasks.length === 0, 'no task was planned for a question', failures);
        assert(run.active === true, 'the conversation stays open: the answer is the turn', failures);
        assert(said.trim().length > 0 && /demo/i.test(said), 'the answer reached the user as prose, grounded in the README it read', failures);
        assert(!run.broadcasts.some((m) => m.type === 'plan_generated'), 'no plan_generated broadcast', failures);
      }

      if (expect.script) {
        const call = run.broadcasts.find((m) => m.type === 'research_step_done' && m.step.toolLabel === 'run_script');
        const script = run.tasks.find((t) => t.type === 'script');
        assert(!!call, 'run_script was offered to the planner and its call reached the session', failures);
        assert(call?.step.outcome === 'success', `the session accepted the run_script call (got ${call?.step.outcome})`, failures);
        assert((call?.step.result ?? '').includes(expect.script.output), 'the command\'s output came back to the planner', failures);
        assert(!!script, 'the session holds a script task added by run_script', failures);
        assert(script?.title === expect.script.title, `the script task is the one run_script named (got "${script?.title}")`, failures);
        assert(script?.status === 'completed', `the script ran to an end (status ${script?.status})`, failures);
        assert(script?.verdict?.outcome === 'pass', `its exit status was its verdict (got ${script?.verdict?.outcome})`, failures);
        assert(
          run.broadcasts.some((m) => m.type === 'execution_action' && m.record?.command === 'run_script'),
          'the command seam recorded the run_script execution',
          failures,
        );
      }

      if (expect.tasks !== undefined) {
        const tasks = run.tasks;
        const research = tasks.filter((t) => t.research === true);
        const scripts = tasks.filter((t) => t.type === 'script');
        const loops = tasks.filter((t) => t.loop);
        assert(tasks.length === expect.tasks, `the submitted plan was committed whole (${tasks.length} of ${expect.tasks} tasks)`, failures);
        assert(tasks.filter((t) => t.type === 'ai').length === expect.ai, `AI tasks: ${expect.ai}`, failures);
        assert(research.length === expect.research, `research tasks: ${expect.research}`, failures);
        assert(scripts.length === expect.scripts, `script tasks: ${expect.scripts}`, failures);
        assert(loops.length === expect.loops, `loops: ${expect.loops}`, failures);
        assert(!run.active, 'the conversation closed on the plan commit', failures);
        assert(run.broadcasts.some((m) => m.type === 'plan_generated'), 'the plan was broadcast to the surfaces', failures);

        if (expect.chained) {
          assert(
            tasks.slice(1).every((t, i) => t.dependencies.includes(tasks[i].id)),
            'each vertical slice depends on the one before it',
            failures,
          );
          assert(tasks.every((t) => (t.prompt ?? '').trim().length > 0), 'every slice carries its own prompt', failures);
        }

        if (expect.reproductionCheck) {
          const check = loops[0];
          const fix = check ? tasks.find((t) => check.loop.body.includes(t.id)) : undefined;
          assert(check?.type === 'script', 'the submitted plan took a script task, and its exit status is the loop\'s check', failures);
          assert(research.every((t) => t.type === 'ai' && isReadOnly(t)), 'each hypothesis is a top-level read-only AI task', failures);
          assert(research.every((t) => t.dependencies.length === 0), 'the hypotheses have no dependencies: they run in parallel', failures);
          assert(!!fix && fix.type === 'ai' && fix.dependencies.includes(check.id), 'the fix is the loop body and depends on the reproduction', failures);
          assert(!tasks.some((t) => t !== check && t !== fix && t.dependencies.includes(fix.id)), 'nothing outside the loop depends on its body', failures);
          assert(
            research.every((t) => (run.plan.researchApprovals ?? []).includes(t.id)),
            'the session approved the research tasks as the plan landed',
            failures,
          );
          assert(
            research.every((t) => run.spawned.some((s) => s.taskId === t.id)),
            'both research tasks started, in parallel',
            failures,
          );
        }

        if (expect.research === expect.tasks) {
          assert(research.every((t) => isReadOnly(t)), 'every task in the first round is read-only', failures);
          assert(research.every((t) => t.dependencies.length === 0), 'the first round runs in parallel', failures);
          assert(
            research.every((t) => (run.plan.researchApprovals ?? []).includes(t.id) && run.spawned.some((s) => s.taskId === t.id)),
            'the session approved and started every research task',
            failures,
          );
        }
      }
    } finally {
      run.session.stopExecution?.();
      run.session.destroy();
    }
  }

  console.log('\n========================');
  if (failures.length) {
    console.log(`${failures.length} GOAL FAILURE(S):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('all kind-of-goal scenarios passed');
}

if (!REAL) await goalsSuite();

// ---------- --real: what strategy a real model chooses for each kind ----------
// No assertions and no grade: the report states what happened. A real run may
// ask questions; the scenario's nudge answers instead of scripting a choice.
function observedStrategy(run) {
  if (run.turn.kind !== 'plan') return 'no plan: the turn ended as a message (answered, or still asking)';
  const tasks = run.turn.tasks;
  const research = tasks.filter((t) => t.research === true).length;
  const loops = tasks.filter((t) => t.loop).length;
  if (tasks.length === 1 && tasks[0].type === 'script') return 'small effect: one script task';
  if (research === tasks.length) return 'research only: a first round (an open problem\'s, or a failure\'s hypotheses)';
  if (research > 0 && loops > 0) return 'failure to explain: research tasks and a check-and-fix loop';
  if (research > 0) return 'research first: tasks whose reports come back to the planner';
  if (loops > 0) return 'a plan ending on a check-and-fix loop';
  return 'build: change tasks, no research and no loop observed';
}

function realExcerpt(run) {
  return run.transcript
    .slice(0, 8)
    .map((m) => {
      const who = m.who === 'user' ? 'USER' : m.who === 'plan' ? 'PLAN' : 'PLANNER';
      return `  ${who}: ${clip(m.text, 600).replace(/\n/g, '\n    ')}`;
    })
    .join('\n');
}

function realReport(runs) {
  const rows = runs.map(({ scenario, run }) => {
    const tasks = run.turn.kind === 'plan' ? `${run.turn.tasks.length}` : 'none';
    return `| ${scenario.kind} | ${run.turn.kind} | ${tasks} | ${observedStrategy(run)} |`;
  });
  const sections = runs.map(({ scenario, run }, i) => {
    const shape = run.turn.kind === 'plan'
      ? run.turn.tasks.map((t) => `  - ${taskLine(t)}${t.dependencies?.length ? ` (deps: ${t.dependencies.join(', ')})` : ''}`).join('\n')
      : '  - none';
    const tools = run.trace.events.filter((e) => e.t === 'tool_call').map((e) => e.tool);
    return [
      `## ${i + 1}. ${scenario.kind}`,
      '',
      `- goal: ${scenario.goal}`,
      `- final turn: ${run.turn.kind}`,
      `- tools called: ${tools.length > 0 ? tools.join(', ') : '(none)'}`,
      `- planner messages with a question: ${run.transcript.filter((m) => m.who === 'planner' && m.text.includes('?')).length}`,
      `- plan shape:`,
      shape,
      `- observed strategy: ${observedStrategy(run)}`,
      '',
      'Transcript excerpt:',
      '',
      realExcerpt(run),
      '',
    ].join('\n');
  });
  return [
    '# Planner strategy for five kinds of goal',
    '',
    `- model: \`${MODEL}\``,
    `- run at: ${new Date().toISOString()}`,
    '- where: a throwaway copy of a tiny demo project; no plan was executed and no runner was started',
    '',
    'This report records the strategy the planner chose for each goal and the shape of the',
    'plan it submitted. It is an observation of behaviour, not a pass/fail result, and it',
    'makes no cost or performance claim.',
    '',
    '| kind of goal | final turn | tasks | observed strategy |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    ...sections,
    'The mock suite (this file without --real) asserts the plumbing behind these same five',
    'kinds. This report is about the prompt\'s judgment alone, so it has no thresholds.',
    '',
  ].join('\n');
}

async function realGoalsReport() {
  const runs = [];
  for (const scenario of GOAL_SCENARIOS) {
    const run = await runConversation({
      label: `REAL ${scenario.kind}: ${scenario.goal}`,
      model: MODEL, goal: scenario.goal, grilling: false, prd: false,
      replies: [...(scenario.realReplies ?? [])],
    });
    printRun(run);
    runs.push({ scenario, run });
  }

  const report = realReport(runs);
  const dir = arg('out', path.join(__dirname, '.real-report'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `real-goals-${MODEL.replace(/[^a-z0-9-]+/gi, '_')}-${stamp}.md`);
  fs.writeFileSync(file, report);
  console.log(`\nBehavioral report written to ${file}\n`);
  console.log(report);
}
