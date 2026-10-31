#!/usr/bin/env node
/**
 * A second host opens the picked session while the load's dropPlanScope()
 * saves the old plan. The load holds the picked lease all the while, so that
 * host is refused and the load's next save reaches the picked file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { core, planOf, tempWorkspace, quietNotifications } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const task = (id, order) => core.createTask({ id, order, title: `Task ${order}`, description: 'd', prompt: 'do it', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium' }, taskMode: 'bypassPermissions', sliceType: 'AFK' });
const resolver = { getCachedRunnerModels: () => [], contextWindowFor: () => undefined, modelsForRunners: async () => ({}) };

function make(workspace, host, runner, broadcast = () => {}) {
  const session = core.createSession({
    config: core.fakeConfig({ maxParallelSessions: 3 }),
    notifications: quietNotifications,
    runner,
    registry: new core.RunnerRegistry(),
    workspaceRoot: () => workspace,
    fsAdapter: core.fakeFileSystem(),
    broadcast,
    modelResolver: resolver,
    settings: () => ({ run: { ...core.RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    leaseHost: host,
    sessionId: `session-${Math.random().toString(16).slice(2, 10)}`,
  });
  return session;
}

const workspace = tempWorkspace();
const hostA = new core.LeaseHost({ id: 'host-a', pid: 4343, alive: () => true });
const hostB = new core.LeaseHost({ id: 'host-b', pid: 4242, alive: () => true });
const notices = [];
const runnerA = { spawn: async ({ taskId }) => new core.FakeRunnerSession(`s-${taskId}`, taskId), stop: async () => {}, stopAll: async () => {}, activeCount: 0 };
const a = make(workspace, hostA, runnerA, (m) => { if (m.type === 'notice') notices.push(m.message); else if (m.type === 'status_update') notices.push('status'); });
a.loadPlan(planOf([task('alpha-1', 1)]), 'alpha', workspace, { sessionId: 'session-alpha' });
await a.execute({ command: 'run_plan' }, { kind: 'user' });
await sleep(100);
console.log(`A running: ${a.activity.running}; alpha lease exists: ${fs.existsSync(path.join(workspace, '.ordewell', 'sessions', 'session-alpha', 'lease.json'))}`);
console.log(`beta lease before: ${fs.existsSync(path.join(workspace, '.ordewell', 'sessions', 'session-beta', 'lease.json'))}`);

// Host B, which will open the picked session while A is between the two leases.
let b = null;
const realSave = a.save;
a.save = (plan, goal, ws, id) => {
  if (plan.tasks.some((t) => t.id === 'alpha-1') && b === null) {
    console.log(`  [hook] A is saving the old plan; beta lease exists: ${fs.existsSync(path.join(workspace, '.ordewell', 'sessions', 'session-beta', 'lease.json'))}`);
    b = make(workspace, hostB, { spawn: async () => { throw new Error('no'); }, stop: async () => {}, stopAll: async () => {}, activeCount: 0 });
    try {
      b.loadPlan(planOf([task('beta-from-b', 1)]), 'beta from b', workspace, { sessionId: 'session-beta' });
      console.log(`  [hook] B loaded beta; beta lease now: ${fs.existsSync(path.join(workspace, '.ordewell', 'sessions', 'session-beta', 'lease.json'))}`);
    } catch (err) {
      console.log(`  [hook] B refused: ${err.message}`);
    }
  }
  return realSave(plan, goal, ws, id);
};

a.loadPlan(planOf([task('beta-1', 1)]), 'beta', workspace, { sessionId: 'session-beta' });
await sleep(100);
console.log(`A after load: planState ${a.planState?.tasks.map((t) => t.id)}, id ${a.sessionId}`);
console.log(`A leases: alpha ${fs.existsSync(path.join(workspace, '.ordewell', 'sessions', 'session-alpha', 'lease.json'))}, beta ${fs.existsSync(path.join(workspace, '.ordewell', 'sessions', 'session-beta', 'lease.json'))}`);
console.log(`A notices: ${notices.filter((n) => n !== 'status').join(' | ')}`);
console.log(`B planState: ${b?.planState?.tasks.map((t) => t.id)}`);
// What A does next: any action that saves.
const dir = path.join(workspace, '.ordewell', 'sessions');
const betaFile = fs.readdirSync(dir).find((f) => f.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).meta?.id === 'session-beta');
const before = fs.readFileSync(path.join(dir, betaFile), 'utf8');
try { await a.execute({ command: 'run_task', task: 'beta-1' }, { kind: 'user' }); } catch (err) { console.log(`A run_task: ${err.message}`); }
await sleep(100);
const after = fs.readFileSync(path.join(dir, betaFile), 'utf8');
console.log(`A's next save reached beta's file: ${before !== after}`);
console.log(`beta file still has B's task: ${after.includes('beta-from-b')}, has A's: ${after.includes('beta-1')}`);
a.destroy();
b?.destroy();
fs.rmSync(workspace, { recursive: true, force: true });
