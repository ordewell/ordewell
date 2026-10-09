import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { RunnerRegistry, StructuredRunner, VerdictEngine, composeAugmentedPrompt, createTask } from '@ordewell/core';

const MARKER = 'INTEGRATION0001';
const PROBE_FILE = 'integration-probe.txt';
const REAL_AGENT_TIMEOUT_MS = 240_000;

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (predicate()) { clearInterval(tick); resolve(); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(tick); reject(new Error(`timed out waiting for ${what}`)); }
    }, 200);
  });
}

async function realAgentReachesAPassVerdict(): Promise<void> {
  const model = process.env.ORDEWELL_TEST_MODEL;
  if (!model || !process.env.OPENROUTER_API_KEY) {
    console.log('  – skipped (no ORDEWELL_TEST_MODEL / OPENROUTER_API_KEY)');
    return;
  }

  const workspace = process.env.ORDEWELL_TEST_WORKSPACE!;
  const registry = new RunnerRegistry();
  const runner = new StructuredRunner();
  const verifier = new VerdictEngine();

  const task = createTask({
    title: 'Integration probe',
    prompt: `Create a file called ${PROBE_FILE} containing the single word "ok". Do not ask any questions.`,
    assignedRunner: 'opencode',
    completionMarker: MARKER,
  });

  // The production prompt, not a hand-written one: it splits the marker into two
  // halves precisely so a TUI echoing the prompt cannot satisfy the watcher. A
  // literal token here passes the moment the session paints its first frame.
  const prompt = composeAugmentedPrompt(task, [task], { planMapEnabled: false });
  assert.ok(!prompt.includes(`<<<ORDEWELL_DONE_${MARKER}>>>`), 'the assembled marker leaked into the prompt');

  const verdicts: Array<{ outcome: string; reason: string }> = [];
  verifier.onVerdict((_taskId, v) => { verdicts.push(v); });

  const session = await runner.spawn({
    taskId: task.id,
    runner: 'opencode',
    prompt,
    modelId: model,
    mode: 'build',
    cwd: workspace,
    registry,
  });
  verifier.watch(task, session);

  try {
    await waitFor(() => verdicts.length > 0, REAL_AGENT_TIMEOUT_MS, 'a verdict from the real agent');
  } finally {
    const tail = session.getOutput().slice(-2000);
    console.log(`  … agent output tail:\n${tail.replace(/^/gm, '    | ')}`);
    runner.stopAll();
  }

  const verdict = verdicts[0];
  assert.strictEqual(verdict.outcome, 'pass', `expected a pass verdict, got: ${JSON.stringify(verdict)}`);
  // The verdict alone would also be satisfied by an echo of the marker; the file
  // is what proves the agent actually ran and that its own output was captured.
  assert.ok(fs.existsSync(path.join(workspace, PROBE_FILE)), `${PROBE_FILE} was never created — the marker did not come from the agent's work`);
  console.log(`  ✓ real agent did the work and reached a pass verdict — ${verdict.reason}`);
}

export async function run(): Promise<void> {
  const scenarios: Array<[string, () => Promise<void>]> = [
    ['a real agent reaches a pass verdict', realAgentReachesAPassVerdict],
  ];

  for (const [name, scenario] of scenarios) {
    console.log(`\n=== ${name} ===`);
    await scenario();
  }
  console.log('\nall integration scenarios passed');
}
