#!/usr/bin/env node
/**
 * Drive the webview harness with Playwright and capture screenshots of the
 * chat at key moments: mid-thinking (dropdown collapsed, title streaming),
 * after the planner's question, and after the plan commit. Also asserts the
 * sequential-timeline invariants:
 *
 *   - every item renders top-to-bottom in arrival order
 *   - thinking dropdowns are collapsed by default, even while streaming;
 *     the title opens them and clicking the opened text collapses them
 *   - streamed prose renders as a thinking dropdown, never as bare message text
 *   - there is exactly one stop control (the chat input's), never a second
 *     cancel button next to the thinking block
 *
 * Usage:
 *   node bench/live/webview-harness.mjs &        # serve the bundle
 *   node bench/live/webview-screenshot.mjs [--out DIR]
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OUT = arg('out', 'bench/live/screenshots');
const URL = arg('url', 'http://127.0.0.1:3798/');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failures.push(msg);
};

// Prefer Playwright's own download; fall back to a system/preinstalled
// chromium path (e.g. /opt/pw-browsers/chromium) via CHROMIUM_PATH.
const executablePath = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
await page.goto(URL);
await page.waitForSelector('.chat-container');

const demo = await page.evaluate(() => window.__demo.length);
console.log(`replaying ${demo} scripted events…`);

// 1. Setup + user message + thinking stream (stop mid-thinking).
await page.evaluate(() => window.__replay(window.__demo.slice(0, 7), 40));
await page.screenshot({ path: path.join(OUT, '1-thinking-streaming.png') });

check(await page.locator('.chat-msg-user').count() === 1, 'user request rendered first');
check(await page.locator('.activity-think.expanded').count() === 0, 'thinking dropdown is COLLAPSED while streaming');
check((await page.locator('.activity-think-toggle').first().innerText()).includes('Thinking…'), 'streaming title reads "Thinking…"');
check(await page.locator('.chat-msg-interrupt-btn').count() === 0, 'no extra cancel button next to the thinking block');
check(await page.locator('.send-btn.processing').count() === 1, 'the single stop control lives in the chat input');

// The title opens the live block; clicking the opened text collapses it again.
await page.locator('.activity-think-toggle').first().click();
check(await page.locator('.activity-think.expanded').count() === 1, 'title click opens the streaming thinking block');
check((await page.locator('.activity-think-pre').innerText()).includes('explore the workspace'), 'thinking text visible when opened mid-stream');
await page.locator('.activity-think-body').first().click();
check(await page.locator('.activity-think.expanded').count() === 0, 'clicking the opened text collapses it');

// Narrated prose (content tokens) must render as a thinking dropdown at its
// point in the stream, never as bare message text below the activities.
await page.evaluate(() => window.__replay(window.__demo.slice(7, 8), 40));
check(await page.locator('.chat-msg-planner .chat-msg-content').count() === 0, 'streamed prose is not shown as bare message text');
check(await page.locator('.activity-think').count() === 2, 'streamed prose renders as its own thinking dropdown');

// 2. Narrated prose + tool calls + question message.
await page.evaluate(() => window.__replay(window.__demo.slice(8, 17), 40));
await page.screenshot({ path: path.join(OUT, '2-question-turn.png') });

check(await page.locator('.activity-tool-call').count() >= 2, 'command executions rendered inside the turn');

// Thinking and command executions must interleave in execution order —
// narrated prose folds into thinking dropdowns at its point in the stream,
// never pooling above or below the command list.
const activitySeq = await page.evaluate(() =>
  [...document.querySelectorAll('.chat-msg-activities > *')].map((el) =>
    el.classList.contains('activity-think') ? 'think' : 'tool'),
);
check(
  JSON.stringify(activitySeq) === JSON.stringify(['think', 'tool', 'think', 'tool', 'think']),
  `thinking and commands interleave in execution order (got ${activitySeq.join(',')})`,
);
check((await page.locator('.chat-msg-planner .chat-msg-content').last().innerText()).includes('Question'), 'planner question rendered as chat message');
check(await page.locator('.activity-think.expanded').count() === 0, 'thinking dropdowns collapsed once the turn finished');
check(await page.locator('.send-btn.processing').count() === 0, 'input back to send state after the question');

// Sequential order: user bubble before the planner turn in the DOM.
const order = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.message-list .chat-msg')];
  return nodes.map((n) => (n.classList.contains('chat-msg-user') ? 'user' : 'planner'));
});
check(order[0] === 'user' && order[1] === 'planner', `timeline is user→planner top-to-bottom (got ${order.join(',')})`);

// 3. Answer, outline, confirm, plan commit.
await page.evaluate(() => window.__replay(window.__demo.slice(17), 40));
await page.waitForSelector('.plan-card-group', { timeout: 5000 });
await page.screenshot({ path: path.join(OUT, '3-plan-committed.png'), fullPage: true });

check(await page.locator('.plan-card-group').count() === 1, 'plan cards rendered at the commit point');
const fullOrder = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.message-list > *')];
  return nodes.map((n) => {
    if (n.classList.contains('chat-msg-user')) return 'user';
    if (n.querySelector('.plan-card-group')) return 'plan';
    if (n.classList.contains('chat-msg')) return 'planner';
    return null;
  }).filter(Boolean);
});
console.log(`  timeline: ${fullOrder.join(' → ')}`);
check(fullOrder[fullOrder.length - 1] === 'plan', 'plan block is the final timeline item');
check(
  JSON.stringify(fullOrder.slice(0, 6)) === JSON.stringify(['user', 'planner', 'user', 'planner', 'user', 'planner']),
  'strict user→planner alternation preserved across the whole conversation',
);

// 4. Reopen a collapsed thinking dropdown — the FULL streamed text must be
// there (both the first and the last delta) and nothing visually clipped.
await page.locator('.activity-think-toggle').first().click();
check(await page.locator('.activity-think.expanded').count() === 1, 'collapsed thinking dropdown reopens on click');
const reopened = await page.locator('.activity-think.expanded .activity-think-pre').innerText();
check(
  reopened.includes('The goal is vague')
    && reopened.includes('then read the README.')
    && reopened.trim().endsWith('Let me inspect the repository structure first.'),
  'reopened thinking shows the full streamed text including folded prose (start and end intact)',
);
const clipped = await page.evaluate(() => {
  const el = document.querySelector('.activity-think.expanded .activity-think-pre');
  return el ? el.scrollHeight > el.clientHeight + 1 : true;
});
check(!clipped, 'reopened thinking text is not visually clipped');
await page.screenshot({ path: path.join(OUT, '4-thinking-reopened.png') });

await browser.close();
console.log(`\nscreenshots: ${OUT}/1-thinking-streaming.png, 2-question-turn.png, 3-plan-committed.png, 4-thinking-reopened.png`);
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log('all visual assertions passed');
