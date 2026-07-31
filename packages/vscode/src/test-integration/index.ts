import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { RunnerRegistry, VerdictEngine, composeAugmentedPrompt, createTask, type RunnerPluginManifest, type RunnerRegistry as Registry } from '@ordewell/core';

import { VsCodeTerminalRunner } from '../adapters/VsCodeTerminalRunner';

const MARKER = 'INTEGRATION0001';
const PROBE_FILE = 'integration-probe.txt';
const REAL_AGENT_TIMEOUT_MS = 240_000;

function syntheticRegistry(): Registry {
  const manifest: RunnerPluginManifest = {
    name: 'synthetic',
    displayName: 'Synthetic',
    description: 'emits a marker and exits',
    version: '1.0.0',
    runner: { command: 'bash', argsTemplate: ['-c', '{{prompt}}'], promptInArgs: true },
    features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
    modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
  } as RunnerPluginManifest;
  return { get: (id: string) => (id === 'synthetic' ? { manifest, source: 'builtin' } : undefined) } as unknown as Registry;
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

/**
 * A development host enables proposed APIs, so their absence cannot be observed
 * here — which is precisely why the original bug survived every run. Simulate a
 * Marketplace install by making `onDidWriteTerminalData` fail the way it
 * effectively does there: any code reaching for it gets nothing usable.
 */
function neutralizeProposedApi(): void {
  const target = vscode.window as unknown as Record<string, unknown>;
  const had = typeof target.onDidWriteTerminalData === 'function';
  Object.defineProperty(target, 'onDidWriteTerminalData', {
    configurable: true,
    get() { throw new Error('onDidWriteTerminalData is a proposed API and does not resolve in a published extension'); },
  });
  console.log(`  ✓ proposed API neutralized (host had it: ${had})`);
}

async function captureThroughPseudoterminal(): Promise<void> {
  const runner = new VsCodeTerminalRunner();
  const streamed: string[] = [];

  const session = await runner.spawn({
    taskId: 'integration-synthetic',
    runner: 'synthetic',
    prompt: `printf 'working\\n'; sleep 1; printf '<<<ORDEWELL_DONE_${MARKER}>>>\\n'`,
    cwd: process.env.ORDEWELL_TEST_WORKSPACE!,
    registry: syntheticRegistry(),
  });
  session.onOutput((text) => streamed.push(text));

  await waitFor(() => session.getOutput().includes(`<<<ORDEWELL_DONE_${MARKER}>>>`), 30_000, 'the marker in getOutput()');
  assert.ok(streamed.join('').includes(MARKER), 'marker never reached the onOutput stream');
  console.log('  ✓ child output reached getOutput() and the onOutput stream');

  runner.stopAll();
}

async function realAgentReachesAPassVerdict(): Promise<void> {
  const model = process.env.ORDEWELL_TEST_MODEL;
  if (!model || !process.env.OPENROUTER_API_KEY) {
    console.log('  – skipped (no ORDEWELL_TEST_MODEL / OPENROUTER_API_KEY)');
    return;
  }

  const workspace = process.env.ORDEWELL_TEST_WORKSPACE!;
  const registry = new RunnerRegistry();
  const runner = new VsCodeTerminalRunner();
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
  console.log('\n=== simulating a Marketplace install ===');
  neutralizeProposedApi();

  const scenarios: Array<[string, () => Promise<void>]> = [
    ['output is captured through the pseudoterminal', captureThroughPseudoterminal],
    ['a real agent reaches a pass verdict', realAgentReachesAPassVerdict],
  ];

  for (const [name, scenario] of scenarios) {
    console.log(`\n=== ${name} ===`);
    await scenario();
  }
  console.log('\nall integration scenarios passed');
}
