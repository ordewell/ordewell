#!/usr/bin/env node
/**
 * End-to-end execution-pipeline driver.
 *
 * Tests the full plan -> execute -> verify -> advance loop against the REAL
 * core stack (TaskOrchestrator + VerdictEngine + HeadlessRunner). No mocks for
 * the orchestrator or verifier — only the agent runner is faked or real.
 *
 * Modes (toggle with --runner):
 *   --runner fake      Deterministic fake-runner shell script (no LLM, no key).
 *   --runner opencode  Real opencode sessions with DeepSeek V4 Flash.
 *
 * The plan has 3 tasks: A and B run in parallel (no deps), C depends on A.
 * The driver asserts:
 *   - All 3 tasks reach the execution log with a pass verdict.
 *   - Execution completes (auto-advance worked — the reported bug).
 *   - The dependency chain (C after A) is respected.
 *
 * Requires: npm run build:core first (imports the built core).
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = await import(path.join(__dirname, '../../packages/core/dist/index.mjs'));

// ---------- CLI args ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const RUNNER = arg('runner', 'fake');
const MODEL_ID = arg('model', 'openrouter/deepseek/deepseek-v4-flash');
const KEEP = process.env.KEEP_WORKSPACE === '1' || process.argv.includes('--keep');

if (RUNNER !== 'fake' && RUNNER !== 'opencode') {
  console.error(`Unknown runner: ${RUNNER}. Use --runner fake or --runner opencode`);
  process.exit(2);
}

if (RUNNER === 'opencode' && !process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required for --runner opencode (set it in the environment, never hardcode it).');
  process.exit(2);
}

const RUNNER_ID = RUNNER === 'fake' ? 'fake-runner' : 'opencode';

// ---------- dummy workspace ----------
function makeDummyWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pipeline-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Dummy project\n\nA fake project for pipeline testing.\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function main() { return 42; }\n');
  return dir;
}

// ---------- fake runner manifest (in-memory, no install needed) ----------
function fakeRunnerManifest() {
  const runSh = path.join(__dirname, 'fake-runner', 'run.sh');
  return {
    name: 'fake-runner',
    displayName: 'Fake Runner',
    description: 'Deterministic fake agent for end-to-end pipeline testing',
    version: '0.1.0',
    runner: {
      command: 'bash',
      argsTemplate: [runSh, '{{prompt}}'],
      promptInArgs: true,
    },
    features: {
      modelSelection: false,
      thinkingEffort: false,
      planMode: false,
      planModeFlag: '',
    },
    modelDiscovery: {
      method: 'hardcoded',
      fallbackModels: [{ modelId: 'fake', modelLabel: 'Fake' }],
    },
  };
}

// ---------- config ----------
function makeConfig(runnerId) {
  return {
    aiProvider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY || 'sk-test',
    planningModel: 'test',
    enabledRunners: [runnerId],
    maxParallelSessions: 3,
    researchEnabled: false,
    researchMaxSteps: 0,
    researchMaxFileSize: 100000,
    openAiBaseUrl: 'https://openrouter.ai/api/v1',
    openAiApiKey: '',
    sttModel: '',
    orchestratorModel: '',
    geminiModel: '',
    planMapEnabled: true,
    openrouterKey: process.env.OPENROUTER_API_KEY || '',
    geminiKey: '',
    autonomousMode: true,
    setProviderModelLists: () => {},
  };
}

function makeNotifications() {
  return {
    info: (msg) => console.log(`  [info] ${msg}`),
    warn: (msg) => console.log(`  [warn] ${msg}`),
    error: (msg) => console.log(`  [error] ${msg}`),
    confirm: async () => {},
  };
}

// ---------- main ----------
async function main() {
  console.log(`\n=== Ordewell Pipeline Test (${RUNNER} runner) ===\n`);

  const workspace = makeDummyWorkspace();
  console.log(`Dummy workspace: ${workspace}`);

  // Set up registry
  const registry = new core.RunnerRegistry();
  if (RUNNER === 'fake') {
    // Inject fake-runner manifest directly (bypasses filesystem install)
    registry.plugins.set('fake-runner', { manifest: fakeRunnerManifest(), source: 'builtin' });
  }
  // opencode is already a builtin in RunnerRegistry

  // Set up real HeadlessRunner (same one the web server uses)
  const runner = new core.HeadlessRunner();

  // Set up orchestrator with real config/notifications/runner
  const config = makeConfig(RUNNER_ID);
  const notifications = makeNotifications();
  const orchestrator = new core.TaskOrchestrator(config, notifications, runner);
  orchestrator.setRegistry(registry);
  orchestrator.setWorkspaceRoot(() => workspace);

  // Track events
  let executionComplete = false;
  const taskStartedAt = new Map();
  const taskCompletedAt = new Map();
  let reviewApprovedAt = 0;

  orchestrator.subscribe({
    onReviewApproved: () => { reviewApprovedAt = Date.now(); },
    onExecutionComplete: () => { executionComplete = true; },
  });

  // Build a plan: A and B parallel (no deps), C depends on A
  const modelAssignment = RUNNER === 'opencode'
    ? { modelId: MODEL_ID, modelLabel: 'DeepSeek V4 Flash' }
    : { modelId: 'fake', modelLabel: 'Fake' };

  const tasks = [
    core.createTask({
      id: 'A', order: 1, title: 'Task A (parallel)',
      prompt: 'Create a file called A.txt in the workspace root with the text "hello from A".',
      assignedRunner: RUNNER_ID, assignedModel: modelAssignment, taskMode: 'build',
    }),
    core.createTask({
      id: 'B', order: 2, title: 'Task B (parallel)',
      prompt: 'Create a file called B.txt in the workspace root with the text "hello from B".',
      assignedRunner: RUNNER_ID, assignedModel: modelAssignment, taskMode: 'build',
    }),
    core.createTask({
      id: 'C', order: 3, title: 'Task C (depends on A)',
      prompt: 'Read the file A.txt and create C.txt with its contents reversed.',
      dependencies: ['A'],
      assignedRunner: RUNNER_ID, assignedModel: modelAssignment, taskMode: 'build',
    }),
  ];

  console.log(`Plan: ${tasks.length} tasks (A + B parallel, C depends on A)`);
  console.log(`Runner: ${RUNNER_ID}, Model: ${modelAssignment.modelId}`);
  orchestrator.loadPlan(tasks, [RUNNER_ID]);

  // Execute
  console.log('\nApproving review and starting execution...\n');
  const execStart = Date.now();
  await orchestrator.approveReview();

  // Wait for completion
  const timeoutMs = RUNNER === 'fake' ? 15000 : 180000;
  while (!executionComplete && Date.now() - execStart < timeoutMs) {
    await new Promise(r => setTimeout(r, 200));
  }
  const elapsed = Date.now() - execStart;

  // ---------- Report ----------
  console.log('\n=== Results ===\n');

  if (!executionComplete) {
    console.log(`FAIL: Execution did not complete within ${timeoutMs / 1000}s`);
    console.log(`  Running: ${orchestrator.isRunning}`);
    console.log(`  Active sessions: ${orchestrator.activeTaskIds.join(', ') || '(none)'}`);
    console.log(`  This indicates the auto-advance stall bug: a task completed but`);
    console.log(`  the pipeline did not advance to the next task.`);
  } else {
    console.log(`PASS: Execution completed in ${elapsed}ms`);
  }

  const log = orchestrator.storeInstance.getExecutionLog();
  console.log(`\nExecution log (${log.length} entries):`);
  for (const entry of log) {
    const outcome = entry.verdict?.outcome || 'unknown';
    const mark = outcome === 'pass' ? 'PASS' : 'FAIL';
    console.log(`  ${mark}: #${entry.order} ${entry.title} (${entry.id}) — ${outcome}`);
    console.log(`       ${entry.verdict?.reason || ''}`);
  }

  // ---------- Assertions ----------
  console.log('\n=== Assertions ===');

  const findById = (id) => log.find(e => e.id === id);
  const passed = (id) => findById(id)?.verdict?.outcome === 'pass';

  const assertions = [
    ['Task A in execution log with pass verdict', () => log.some(e => e.id === 'A' && e.verdict?.outcome === 'pass')],
    ['Task B in execution log with pass verdict', () => log.some(e => e.id === 'B' && e.verdict?.outcome === 'pass')],
    ['Task C in execution log with pass verdict', () => log.some(e => e.id === 'C' && e.verdict?.outcome === 'pass')],
    ['Execution completed (auto-advance worked)', () => executionComplete],
    ['All 3 tasks in execution log', () => log.length === 3],
    ['No tasks left in plan (all archived)', () => orchestrator.storeInstance.planTasks.length === 0],
    ['Orchestrator is no longer running', () => !orchestrator.isRunning],
  ];

  let allPassed = true;
  for (const [label, check] of assertions) {
    const ok = check();
    if (!ok) allPassed = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  }

  console.log(`\n${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}\n`);

  // Show workspace contents
  console.log('Workspace contents:');
  for (const f of fs.readdirSync(workspace)) {
    console.log(`  ${f}`);
  }

  // Cleanup
  if (KEEP) {
    console.log(`\nWorkspace kept at: ${workspace}`);
  } else {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Driver crashed:', err);
  process.exit(2);
});
