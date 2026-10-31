#!/usr/bin/env node
/** What a load the orchestrator refuses leaves on disk and what the next Execute runs. */
import fs from 'node:fs';
import path from 'node:path';
import { core, hostSession, planOf, tempWorkspace } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function task(id, order, over = {}) {
  return core.createTask({
    id, order, title: `Task ${order}`, description: 'd', prompt: 'do it', type: 'ai',
    status: 'pending', dependencies: [], assignedRunner: 'claude-code',
    assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium' },
    taskMode: 'bypassPermissions', sliceType: 'AFK', ...over,
  });
}

function files(workspace) {
  const dir = path.join(workspace, '.ordewell', 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return `${f} => id=${data.meta?.id} goal="${data.meta?.goal}" tasks=${(data.plan?.tasks ?? []).map((t) => t.id).join(',')}`;
  });
}

async function run() {
  const workspace = tempWorkspace();
  const spawned = [];
  const runner = {
    spawn: async ({ taskId }) => { spawned.push(taskId); return new core.FakeRunnerSession(`s-${taskId}`, taskId); },
    stop: async () => {}, stopAll: async () => {}, activeCount: 0,
  };
  const { session } = hostSession({ runner, workspace });
  session.loadPlan(planOf([task('alpha-1', 1)]), 'alpha', workspace, { sessionId: 'session-alpha' });
  await sleep(50);
  console.log('before the refused load:');
  for (const line of files(workspace)) console.log(`  ${line}`);

  const bad = planOf([task('beta-1', 1, { assignedRunner: 'gemini' })]);
  bad.runners = ['claude-code'];
  let threw = null;
  try { session.loadPlan(bad, 'beta', workspace, { sessionId: 'session-beta' }); } catch (err) { threw = err.message; }
  await sleep(50);
  console.log(`\nrefused load threw: ${threw}`);
  console.log(`planState: ${session.planState?.tasks.map((t) => t.id).join(',')}`);
  console.log(`store:     ${session.planTasks.map((t) => t.id).join(',')}`);
  console.log(`id:        ${session.sessionId}`);
  console.log('files just after the refusal:');
  for (const line of files(workspace)) console.log(`  ${line}`);

  // A save that follows: the next Execute, which is what the user does next.
  let answer = null;
  try { answer = await session.execute({ command: 'run_plan' }, { kind: 'user' }); } catch (err) { answer = { error: err.message }; }
  await sleep(150);
  console.log(`\nafter run_plan: ${JSON.stringify(answer)} spawned=[${spawned.join(',')}]`);
  console.log(`planState: ${session.planState?.tasks.map((t) => t.id).join(',')}`);
  console.log(`store:     ${session.planTasks.map((t) => t.id).join(',')}`);
  console.log('files after the next save:');
  for (const line of files(workspace)) console.log(`  ${line}`);
  session.destroy();
  fs.rmSync(workspace, { recursive: true, force: true });
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
