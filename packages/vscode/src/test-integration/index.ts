import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { RunnerRegistry, StructuredRunner, TaskOrchestrator, createTask, type Task } from '@ordewell/core';
import { fakeConfig } from '@ordewell/core/testing';

const PROBE_FILE = 'integration-probe.txt';
const REAL_AGENT_TIMEOUT_MS = 240_000;
const FAKE_AGENT_TIMEOUT_MS = 30_000;

// runTest.ts puts this folder first on the host's PATH, so Ordewell's own
// claude-code connector spawns the fake `claude` exactly as it would the real one.
const FAKE_CLAUDE_DIR = path.resolve(__dirname, '../../../bench/pipeline/fake-claude');

/** Runs a plan to its end on the structured runner every host hands the orchestrator, and returns its execution log. */
async function runPlan(tasks: Task[], runner: string, timeoutMs: number) {
  const workspace = process.env.ORDEWELL_TEST_WORKSPACE!;
  const structured = new StructuredRunner();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ enabledRunners: [runner] }),
    notifications: { info: () => {}, warn: () => {}, error: () => {}, confirm: async () => undefined },
    terminalRunner: structured,
    registry: new RunnerRegistry(),
    workspaceRoot: () => workspace,
  });

  let complete = false;
  orchestrator.subscribe({ onExecutionComplete: () => { complete = true; } });
  orchestrator.loadPlan(tasks, [runner]);
  try {
    await orchestrator.approveReview();
    await waitFor(() => complete, timeoutMs, 'the plan to finish');
  } finally {
    structured.stopAll();
  }
  return orchestrator.storeInstance.getExecutionLog();
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (predicate()) { clearInterval(tick); resolve(); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(tick); reject(new Error(`timed out waiting for ${what}`)); }
    }, 200);
  });
}

async function fakeClaudeCompletesThroughTheTool(): Promise<void> {
  assert.ok(
    process.env.PATH?.split(path.delimiter)[0] === FAKE_CLAUDE_DIR,
    `${FAKE_CLAUDE_DIR} is not first on the host's PATH; the real claude would run`,
  );

  const task = createTask({
    title: 'Integration probe (fake claude)',
    prompt: `Create a file called ${PROBE_FILE}.<fake-claude>${JSON.stringify({ write: { [PROBE_FILE]: 'ok' } })}</fake-claude>`,
    assignedRunner: 'claude-code',
    assignedModel: { modelId: 'fake-claude', modelLabel: 'Fake Claude' },
    taskMode: 'build',
  });

  const log = await runPlan([task], 'claude-code', FAKE_AGENT_TIMEOUT_MS);
  const verdict = log.find((entry) => entry.id === task.id)?.verdict;
  assert.strictEqual(verdict?.outcome, 'pass', `expected a pass verdict, got: ${JSON.stringify(verdict)}`);
  assert.ok(verdict?.reason.includes('task_complete'), `the pass did not come from task_complete: ${verdict?.reason}`);
  assert.ok(fs.existsSync(path.join(process.env.ORDEWELL_TEST_WORKSPACE!, PROBE_FILE)), `${PROBE_FILE} was never created`);
  console.log(`  ✓ fake claude did the work and the tool call reached a pass verdict — ${verdict?.reason}`);
}

async function realAgentReachesAPassVerdict(): Promise<void> {
  const model = process.env.ORDEWELL_TEST_MODEL;
  if (!model || !process.env.OPENROUTER_API_KEY) {
    console.log('  – skipped (no ORDEWELL_TEST_MODEL / OPENROUTER_API_KEY)');
    return;
  }

  const task = createTask({
    title: 'Integration probe',
    prompt: `Create a file called ${PROBE_FILE} containing the single word "ok". Do not ask any questions.`,
    assignedRunner: 'opencode',
    assignedModel: { modelId: model, modelLabel: model },
    taskMode: 'build',
  });

  const log = await runPlan([task], 'opencode', REAL_AGENT_TIMEOUT_MS);
  const verdict = log.find((entry) => entry.id === task.id)?.verdict;
  assert.strictEqual(verdict?.outcome, 'pass', `expected a pass verdict, got: ${JSON.stringify(verdict)}`);
  // The file is what proves the agent actually ran rather than only claiming it.
  assert.ok(fs.existsSync(path.join(process.env.ORDEWELL_TEST_WORKSPACE!, PROBE_FILE)), `${PROBE_FILE} was never created — the verdict did not come from the agent's work`);
  console.log(`  ✓ real agent did the work and reached a pass verdict — ${verdict?.reason}`);
}

export async function run(): Promise<void> {
  const scenarios: Array<[string, () => Promise<void>]> = [
    ['a fake claude on PATH completes through task_complete', fakeClaudeCompletesThroughTheTool],
    ['a real agent reaches a pass verdict', realAgentReachesAPassVerdict],
  ];

  for (const [name, scenario] of scenarios) {
    console.log(`\n=== ${name} ===`);
    await scenario();
  }
  console.log('\nall integration scenarios passed');
}
