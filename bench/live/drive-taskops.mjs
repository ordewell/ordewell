// Live Stage-2 check: resume a "loaded" session and exercise post-plan chat
// (question → prose reply; modification → task_ops applied) against a real
// cheap model on OpenRouter.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const core = await import(
  pathToFileURL(path.join(REPO, 'packages/core/dist/index.mjs')).href);
const { Session, RunnerRegistry, createTask } = core;

const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash';
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY required'); process.exit(2); }

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-taskops-'));
fs.writeFileSync(path.join(sandbox, 'README.md'), '# Demo\nTiny demo app.\n');

const config = {
  aiProvider: 'openrouter', apiKey: KEY, planningModel: MODEL,
  enabledRunners: ['claude-code'], maxParallelSessions: 3,
  researchEnabled: false, researchMaxSteps: 6, researchMaxFileSize: 100_000,
  openAiBaseUrl: 'https://openrouter.ai/api/v1', openAiApiKey: KEY, sttModel: '',
  orchestratorModel: MODEL, geminiModel: '',
  planMapEnabled: true, openrouterKey: KEY, geminiKey: '',
  autonomousMode: true, setProviderModelLists: () => {},
};
const ok = (output) => ({ success: true, output, truncated: false });
const fsAdapter = {
  readFile: async () => ok('# Demo\n'),
  readFiles: async () => ok('# Demo\n'),
  listDir: async () => ok('README.md\nsrc/'),
  glob: async () => ok('README.md'),
  grep: async () => ok(''),
  bash: async () => ok(''),
  getWorkspaceRoot: () => sandbox,
};
const events = [];
const session = new Session({
  config,
  notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
  runner: { spawn: async () => ({ id: 's', taskId: '', onOutput() {}, onExit() {}, kill() {}, getOutput: () => '', write() {} }), stopAll() {}, activeCount: 0 },
  registry: new RunnerRegistry(),
  workspaceRoot: () => sandbox,
  fsAdapter,
  broadcast: (m) => { events.push(m.type); if (m.type === 'planner_message') console.log(`\n[planner] ${m.content.slice(0, 400)}`); },
  modelResolver: { modelsForRunners: async () => ({}) },
  settings: () => ({ tddEnabled: false, grillingEnabled: false }),
});

// Simulate a session loaded from disk: 3 tasks + prior dialogue, no live AI conversation.
const plan = {
  tasks: [
    createTask({ id: 'a', order: 1, title: 'Set up project scaffolding', prompt: 'Set up scaffolding', description: 'Set up scaffolding', assignedRunner: 'claude-code' }),
    createTask({ id: 'b', order: 2, title: 'Build parser', prompt: 'Build the parser', description: 'Build the parser', dependencies: ['a'], assignedRunner: 'claude-code' }),
    createTask({ id: 'c', order: 3, title: 'Add tests', prompt: 'Add tests', description: 'Add tests', dependencies: ['b'], assignedRunner: 'claude-code' }),
  ],
  generatedAt: new Date().toISOString(), status: 'draft', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
  conversationHistory: [
    { role: 'user', content: 'Build a small config parser library', timestamp: new Date().toISOString() },
    { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: new Date().toISOString(), kind: 'plan_generated' },
  ],
};
session.loadPlan(plan, 'Build a small config parser library', sandbox, { persist: false });

let pass = 0, fail = 0;
const check = (cond, name) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); cond ? pass++ : fail++; };

console.log(`model: ${MODEL}`);
console.log('\n--- turn 1: post-plan QUESTION (expect prose, no task change) ---');
const before = JSON.stringify(session.planTasks.map((t) => t.title));
await session.continueConversation('Quick question: which task handles testing, and what does it depend on? Do not change anything.');
check(JSON.stringify(session.planTasks.map((t) => t.title)) === before, 'tasks unchanged after a question');
check(events.includes('planner_message'), 'question got a conversational reply');

console.log('\n--- turn 2: post-plan MODIFICATION (expect task_ops applied) ---');
events.length = 0;
await session.continueConversation('Rename task 2 to "Build core parser module", and add a new task titled "Write documentation" that depends on the tests task.');
const titles = session.planTasks.map((t) => t.title);
console.log('  tasks now:', titles.join(' | '));
const renamed = titles.some((t) => /core parser/i.test(t));
const docsTask = session.planTasks.find((t) => /documentation/i.test(t.title));
check(renamed, 'task 2 renamed via task_ops');
check(!!docsTask, 'documentation task added');
if (docsTask) {
  const testsTask = session.planTasks.find((t) => /test/i.test(t.title) && t.id !== docsTask.id);
  check(testsTask && docsTask.dependencies.includes(testsTask.id), 'new task depends on the tests task (refs resolved)');
}
check(session.planTasks.length === 4, `task count is 4 (got ${session.planTasks.length})`);
check(events.includes('plan_generated'), 'plan re-broadcast after edits');

console.log('\n--- turn 3: INVALID request (expect rejection or self-correction, plan consistent) ---');
await session.continueConversation('Make task 1 depend on the documentation task and the documentation task depend on task 1.');
const flat = session.planTasks;
const byId = new Map(flat.map((t) => [t.id, t]));
let cyclic = false;
for (const t of flat) {
  const seen = new Set([t.id]);
  const stack = [...t.dependencies];
  while (stack.length) {
    const d = stack.pop();
    if (seen.has(d)) { cyclic = true; break; }
    seen.add(d);
    stack.push(...(byId.get(d)?.dependencies ?? []));
  }
}
check(!cyclic, 'no dependency cycle exists after adversarial request');

console.log(`\n${fail === 0 ? 'ALL LIVE CHECKS PASSED' : `${fail} LIVE CHECK(S) FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
