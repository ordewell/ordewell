#!/usr/bin/env node
/**
 * Draw the delegation views of the VS Code chat webview (ADR-0055 D16, D20,
 * D21) against the built bundle, as a real page, and assert what is on it:
 *
 *   - a delegated task's card: its child's tasks, the budget left, and the
 *     Stop still winding it down, on the collapsed card; its goal once opened
 *   - its checkpoint card, which takes the answer's words and a raise of its
 *     budget, and posts both with the approval
 *   - its handoff: the counts of its subtree, what is open for the parent to
 *     decide, and what its subplanner passed up
 *   - none of it where the host does not say delegation is offered
 *
 * The page is told what the host tells it, through `window.__send`.
 *
 * Usage:
 *   npm run build -w packages/core -w packages/vscode
 *   node bench/live/webview-harness.mjs &
 *   node bench/live/webview-delegation.mjs [--out DIR]
 */
import fs from 'node:fs';
import { chromium } from './load-playwright.mjs';
import { RUN_SETTINGS_DEFAULTS } from '../../packages/core/dist/index.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OUT = arg('out', 'bench/live/screenshots');
const BASE = arg('url', 'http://127.0.0.1:3798');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures.push(msg);
};

const executablePath = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});

const now = new Date().toISOString();
const task = (over) => ({ id: 'd', order: 1, title: 'Import the ledger', description: 'A subtree', type: 'delegated', status: 'in_progress', dependencies: [], subtasks: [], goal: 'Move the importer behind the new interface and keep its tests green', budget: { tokens: 2_000_000 }, ...over });
const plan = (t) => ({ tasks: [t], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now });
const view = (t) => ({ tasks: [t], runMerge: null, handoff: null, mergeResult: null });
const subtree = {
  node: 'root/1',
  counts: { done: 3, failed: 1, blocked: 0, skipped: 0, commits: 3, tokens: 1_204_000 },
  findings: { blocker: 0, major: 1, minor: 1, info: 0 },
  open: [{ ref: { kind: 'task', task: 't9', node: 'root/1', label: '#2 "Write b"', attempt: 1, finding: 'F1' }, finding: { id: 'F1', severity: 'major', title: 'The importer drops dates', detail: 'Seen in two fixtures.' } }],
  promoted: [{ finding: { id: 'F1', severity: 'minor', title: 'A flaky timer' } }],
  outsideScope: { paths: ['docs/a.md'], count: 3 },
};

async function open(offered) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => typeof window.__send === 'function');
  const send = (msg) => page.evaluate((m) => window.__send(m), msg);
  await send({ type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, delegationTokens: 5_000_000 }, maxParallel: 5, ...(offered === undefined ? {} : { delegationOffered: offered }) });
  return { page, send, errors };
}
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);

for (const offered of [true, false]) {
  console.log(`delegation ${offered ? 'offered' : 'not offered'} by the host`);
  const { page, send, errors } = await open(offered);

  const live = task({ status: 'in_progress' });
  await send({ type: 'planUpdated', plan: plan(live) });
  await send({ type: 'runView', view: view({ ...live, delegation: { tasks: { completed: 2, running: 1, waiting: 0, pending: 1, failed: 0, skipped: 0 }, tokens: { budget: 2_000_000, left: 1_300_000 } } }) });
  await page.waitForSelector('.task-card');
  const line = await text(page, '.task-delegated-line');
  check(offered ? line === '2 of 4 done, 1 running · 1.3M of 2M tokens left' : line === null, offered ? 'the collapsed card says where its child stands and what is left of its budget' : 'the card says nothing of its child');
  if (offered) await page.screenshot({ path: `${OUT}/delegation-row.png` });

  const stopped = task({ status: 'pending' });
  await send({ type: 'planUpdated', plan: plan(stopped) });
  await send({ type: 'runView', view: view({ ...stopped, delegation: { stopping: true } }) });
  const stopping = await text(page, '.task-delegated-stopping');
  check(offered ? stopping === 'Stopping: its child plan is still winding down.' : stopping === null, offered ? 'a Stop still winding the child down shows on a task that reads as not started' : 'no stopping line');

  await page.click('.task-card-header');
  const goal = await text(page, '.task-delegated-goal');
  check(offered ? goal?.includes('Move the importer behind the new interface') === true : goal === null, offered ? 'the opened card shows its goal' : 'no goal line');

  const asking = task({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  await send({ type: 'planUpdated', plan: plan(asking) });
  await send({ type: 'runView', view: view({ ...asking, checkpoint: 'Round half up or to even?', delegation: { tokens: { budget: 2_000_000, left: 120_000 } } }) });
  await page.waitForSelector('.checkpoint-panel');
  const answer = await page.$('.checkpoint-delegated textarea');
  check(offered ? answer !== null : answer === null, offered ? 'its question takes an answer\'s words and a raise' : 'its question is the plain card');
  if (offered) {
    await page.fill('.checkpoint-delegated textarea', 'Half up.');
    await page.fill('.checkpoint-delegated input', '700000');
    await page.screenshot({ path: `${OUT}/delegation-checkpoint.png` });
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.click('.checkpoint-approve-btn');
    const posted = await page.evaluate(() => window.__posted.filter((m) => m.type === 'answerCheckpoint'));
    check(JSON.stringify(posted) === JSON.stringify([{ type: 'answerCheckpoint', taskId: 'd', approved: true, reason: 'Half up.', raiseTokens: 700000 }]), 'the approval posts the words and the raise');
  }

  const done = task({ status: 'completed', handoff: { summary: 'Both files are written.', findings: [], findingCount: 0, subtree } });
  await send({ type: 'planUpdated', plan: plan(done) });
  await send({ type: 'runView', view: view(done) });
  // The card opened above stays open as the task's status moves on; a card that is not open is opened.
  if (!(await page.$('.task-card.expanded'))) await page.click('.task-card-header');
  await page.waitForTimeout(200);
  const handoff = await text(page, '.task-handoff-subtree');
  if (offered) {
    check(handoff?.includes('3 done, 1 failed · 3 commits · 1.2M tokens') === true, 'the handoff counts what its subtree did');
    check(handoff?.includes('Open, for you to decide') === true && handoff.includes('F1 · Major · The importer drops dates'), 'it lists what the parent must decide');
    check(handoff?.includes('Passed up by its subplanner') === true && handoff.includes('A flaky timer'), 'and what the subplanner passed up');
    await page.screenshot({ path: `${OUT}/delegation-handoff.png` });
  } else {
    check(handoff === null, 'the handoff has no subtree section');
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nall passed');
