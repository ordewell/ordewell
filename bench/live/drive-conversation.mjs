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
 *   - a REAL model over OpenRouter (no assertions — prints the transcript
 *     and a behavioral report):
 *       OPENROUTER_API_KEY=sk-or-... node bench/live/drive-conversation.mjs \
 *         --real --model deepseek/deepseek-v4-flash --grill-me \
 *         --goal "make this project better" \
 *         --replies "focus on code health::node:test please::confirm"
 *
 * The API key is always taken from the environment — never hardcoded.
 * Requires `npm run build:core` first (imports the built core).
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = await import(path.join(__dirname, '../../packages/core/dist/index.mjs'));
const { OpenAiService, extractPrdBlock } = core;

// ---------- CLI args ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const REAL = process.argv.includes('--real');
const GRILL = process.argv.includes('--grill-me');
const PRD = process.argv.includes('--prd');
const SUBAGENTS = process.argv.includes('--subagents');
const MODEL = arg('model', 'mock/interviewer');
const GOAL = arg('goal', 'make this project better');
const REPLIES = (arg('replies', '') || '').split('::').filter(Boolean);
const BASE_URL = REAL ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') : `http://127.0.0.1:${arg('port', '3799')}/v1`;
const API_KEY = REAL ? process.env.OPENROUTER_API_KEY : 'mock-key';

if (REAL && !API_KEY) {
  console.error('OPENROUTER_API_KEY is required for --real runs (pass it via the environment, never hardcode it).');
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
  sttModel: 'openai/whisper-large-v3-turbo',
  orchestratorModel: model,
  geminiModel: '',
  planMapEnabled: true,
  autonomousMode: true,
  approvalMode: 'allow',
  approvalPreApproved: [],
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
    { id: 'plan', label: 'Plan', description: 'Read-only', tags: [] },
  ],
};

async function runConversation({ model, goal, grillMe, prd, replies, label }) {
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
    grillMeEnabled: grillMe,
    prdEnabled: prd,
    researchSubagentsEnabled: SUBAGENTS,
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

  // 1. Grill-me interview: explores first, asks one question at a time with a
  //    recommendation, transitions to outline, commits a fenced+trailing-comma plan.
  {
    const run = await runConversation({
      label: 'grill-me interview (mock/interviewer)',
      model: 'mock/interviewer', goal: 'make this project better',
      grillMe: true, prd: false,
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

  // 2. Eager planner under grill-me: the gate bounces the instant commit ONCE;
  //    when the model insists (this persona always re-emits the plan), the plan
  //    still commits — the model decides transitions, the gate never blocks.
  {
    const run = await runConversation({
      label: 'eager planner ignores grill-me (mock/eager-planner)',
      model: 'mock/eager-planner', goal: 'make this project better',
      grillMe: true, prd: false, replies: [],
    });
    printRun(run);
    assert(run.turn.kind === 'plan', 'an insistently re-emitted valid plan commits after the one gate nudge', failures);
  }

  // 3. Research → preamble + fenced JSON (non grill-me).
  {
    const run = await runConversation({
      label: 'research then fenced plan (mock/fenced-json)',
      model: 'mock/fenced-json', goal: 'add a test harness',
      grillMe: false, prd: false, replies: [],
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
      grillMe: false, prd: true,
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
      grillMe: false, prd: false, replies: [],
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
    label: `REAL ${MODEL}${GRILL ? ' +grill-me' : ''}${PRD ? ' +prd' : ''}`,
    model: MODEL, goal: GOAL, grillMe: GRILL, prd: PRD, replies: [...REPLIES],
  });
  printRun(run);
  console.log('\nBehavioral report:');
  console.log(`  final turn: ${run.turn.kind}`);
  console.log(`  explored before answering: ${run.trace.events.some((e) => e.t === 'tool_call')}`);
  const questionTurns = run.transcript.filter((m) => m.who === 'planner' && m.text.includes('?')).length;
  console.log(`  planner turns containing a question: ${questionTurns}`);
  if (GRILL) {
    const first = run.transcript.find((m) => m.who === 'planner');
    console.log(`  grill-me first turn was a question (heuristic '?'): ${first ? first.text.includes('?') : 'n/a'}`);
  }
  if (PRD) console.log(`  PRD extracted: ${run.prdBlock ? `yes (slug=${run.prdBlock.slug})` : 'no'}`);
}

if (REAL) await realRun();
else await mockSuite();

// ---------- full Session scenario (production wiring incl. PRD save) ----------
async function sessionSuite() {
  const { Session, RunnerRegistry, ModelResolver } = core;
  const failures = [];
  const root = makeSandbox();
  const registry = new RunnerRegistry();
  const config = cfg('mock/prd-flow');
  const fakeExec = () => Promise.reject(new Error('no CLI in harness'));
  const modelResolver = new ModelResolver(registry, config, { execImpl: fakeExec });
  const broadcasts = [];
  const session = new Session({
    config,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
    registry,
    workspaceRoot: () => root,
    fsAdapter: makeFs(root),
    broadcast: (m) => broadcasts.push(m),
    modelResolver,
    settings: () => ({ tddEnabled: true, grillMeEnabled: false, prdEnabled: true }),
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
    const session = new core.Session({
      config,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
      registry: new core.RunnerRegistry(),
      workspaceRoot: () => root,
      fsAdapter,
      broadcast: (m) => broadcasts.push(m),
      modelResolver: new core.ModelResolver(new core.RunnerRegistry(), config, { execImpl: () => Promise.reject(new Error('harness')) }),
      settings: () => ({ tddEnabled: false, grillMeEnabled: false }),
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

  // 2. refuse-tier: never prompts, returns a refusal tool result.
  {
    const { fsAdapter, broadcasts } = makeApprovalSession();
    const result = await fsAdapter.bash('rm -rf build');
    assert(result.success === false, 'refuse-tier rm is denied', failures);
    assert(result.output.includes('refused'), 'refusal is actionable', failures);
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
    assert(req.scope === '/tmp/ordewell-live-external/*', 'scope is the containing directory', failures);
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
  const { Session, RunnerRegistry, ModelResolver, BaseFileSystem, classifyOutcome } = core;
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
  session = new Session({
    config,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    runner: { async createSession() { throw new Error('not used'); }, stopAll() {} },
    registry,
    workspaceRoot: () => root,
    fsAdapter: new SandboxFs(),
    broadcast,
    modelResolver: new ModelResolver(registry, config, { execImpl: () => Promise.reject(new Error('harness')) }),
    settings: () => ({ tddEnabled: false, grillMeEnabled: false }),
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
  assert(
    JSON.stringify(outcomes) === JSON.stringify(['success', 'success', 'refused', 'denied']),
    `outcomes are honest per call: ${JSON.stringify(outcomes)}`,
    failures,
  );

  const refused = byId.get('vc-3');
  assert(refused?.success === false, 'a refused command is not reported as a success', failures);
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
    broadcasts.some((m) => m.type === 'plan_thinking' && m.text.length > 0),
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
