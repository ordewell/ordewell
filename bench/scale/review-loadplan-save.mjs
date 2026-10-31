#!/usr/bin/env node
/**
 * What a failed save does to a plan load (task #44, review round 5).
 *
 *   node bench/scale/build.mjs && node bench/scale/review-loadplan-save.mjs
 *
 * A load the disk refuses must leave the Session as it was, its plan, its id
 * and its lease, because a caller reads the throw as "nothing was loaded" (the
 * VS Code command path does). A Session that kept the new plan would run tasks
 * at the next Execute that the user never saw.
 */
import fs from 'node:fs';
import path from 'node:path';
import { core, hostSession, planOf, tempWorkspace } from './lib.mjs';

const workspace = tempWorkspace();
const runner = { spawn: async () => { throw new Error('no runner in this probe'); }, stop: async () => {}, stopAll: async () => {}, activeCount: 0 };
const { session } = hostSession({ runner, workspace, broadcast: () => {} });

const task = (id, order) => core.createTask({
  id, order, title: `Task ${order}`, description: 'd', prompt: 'do it', type: 'ai', status: 'pending', dependencies: [],
  assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium' },
  taskMode: 'bypassPermissions', sliceType: 'AFK',
});
const ids = () => session.planTasks.map((t) => t.id).join(',') || '(none)';

// The plan the window shows, already loaded and saved.
session.loadPlan(planOf([task('shown-1', 1)]), 'the plan on screen', workspace, { sessionId: 'session-on-screen' });
console.log(`on screen: ${ids()}`);

// The disk refuses every save from here, as a full one does.
session.save = () => { const err = new Error('no space left on device'); err.code = 'ENOSPC'; throw err; };
const logged = [];
const real = console.error;
console.error = (...args) => logged.push(args.map(String).join(' '));
let threw = null;
try {
  // What "Load a previous session" does: adopt the picked session and save it.
  session.loadPlan(planOf([task('loaded-1', 1), task('loaded-2', 2)]), 'the session picked', workspace, { sessionId: 'session-picked' });
} catch (err) { threw = err.message; }
console.error = real;

const lease = path.join(workspace, '.ordewell', 'sessions', 'session-picked', 'lease.json');
console.log(`loadPlan threw: ${threw ?? '(did not throw)'}`);
console.log(`logged: ${logged.length === 0 ? '(nothing)' : logged[0]}`);
console.log(`after the throw, the Session holds: ${ids()} (${session.planState?.goal ?? session.goal ?? '?'})`);
console.log(`its id is now: ${session.sessionId}`);
console.log(`the picked session's lease is held: ${fs.existsSync(lease)}`);
console.log(`a surface that kept the old plan would Execute: ${ids()}`);
const unchanged = threw !== null && ids() === 'shown-1' && session.sessionId === 'session-on-screen' && !fs.existsSync(lease);
console.log(unchanged ? 'ok' : 'FAIL: the caller was told the load failed, and the Session did not stay as it was');

session.destroy();
console.log(`lease released on destroy: ${!fs.existsSync(lease)}`);
fs.rmSync(workspace, { recursive: true, force: true });
