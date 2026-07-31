// Stage-1 chat reliability verification against the webview harness.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3798';
let failures = 0;
const ok = (cond, name) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
await page.goto(BASE);
await page.waitForSelector('.chat-container');

const send = (msg) => page.evaluate((m) => window.__send(m), msg);
const timelineKinds = () => page.evaluate(() => {
  return [...document.querySelectorAll('.message-list > *')]
    .map((el) => el.className || el.tagName)
    .filter((c) => typeof c === 'string');
});
const messageRoles = () => page.evaluate(() =>
  [...document.querySelectorAll('.message-list [class*="message"]')].map((e) => e.className).slice(0, 50));
const inputDisabled = () => page.evaluate(() => {
  const ta = document.querySelector('textarea');
  return ta ? ta.disabled : null;
});
const bodyText = () => page.evaluate(() => document.querySelector('.message-list')?.innerText ?? '');

console.log('1) restoreChat rebuilds timeline with plan anchor at marker');
const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Restored Task', description: 'd', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build', completionMarker: 'x', prompt: 'p' }],
  generatedAt: new Date().toISOString(), status: 'draft', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
};
await send({
  type: 'restoreChat',
  hasPlan: true,
  history: [
    { role: 'user', content: 'restore me a parser', timestamp: '2026-01-01T00:00:00Z' },
    { role: 'assistant', content: 'Which formats do you need?', timestamp: '2026-01-01T00:00:01Z' },
    { role: 'user', content: 'JSON please', timestamp: '2026-01-01T00:00:02Z' },
    { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:03Z', kind: 'plan_generated' },
    { role: 'assistant', content: 'Anything else you want tweaked?', timestamp: '2026-01-01T00:00:04Z' },
  ],
});
await send({ type: 'planUpdated', plan });
await page.waitForTimeout(300);
let text = await bodyText();
ok(text.includes('restore me a parser'), 'restored user bubble visible');
ok(text.includes('Which formats do you need?'), 'restored planner bubble visible');
ok(text.includes('Anything else you want tweaked?'), 'post-plan planner bubble visible');
ok(text.includes('Restored Task'), 'plan card rendered from marker anchor');
ok(await inputDisabled() === false, 'input enabled after restore');
// plan card must sit BEFORE the trailing planner message (marker position honored)
const planIdx = text.indexOf('Restored Task');
const trailingIdx = text.indexOf('Anything else you want tweaked?');
ok(planIdx !== -1 && trailingIdx !== -1 && planIdx < trailingIdx, 'plan card anchored at marker position (before trailing message)');

console.log('2) legacy history (no marker) appends plan card at end');
await send({ type: 'restoreChat', hasPlan: true, history: [
  { role: 'user', content: 'legacy goal', timestamp: '2026-01-01T00:00:00Z' },
  { role: 'assistant', content: 'legacy planner reply', timestamp: '2026-01-01T00:00:01Z' },
] });
await page.waitForTimeout(200);
text = await bodyText();
const legacyPlanIdx = text.indexOf('Restored Task');
const legacyReplyIdx = text.indexOf('legacy planner reply');
ok(legacyReplyIdx !== -1 && legacyPlanIdx > legacyReplyIdx, 'plan card appended after legacy transcript');

console.log('3) showWarnings unlocks input and shows system message');
// simulate a busy turn first
await send({ type: 'streamToken', token: 'thinking about the modify…' });
await page.waitForTimeout(100);
ok(await inputDisabled() === true, 'input locked while streaming');
await send({ type: 'showWarnings', warnings: 'Completed tasks deleted: Foo', pendingTasks: [] });
await page.waitForTimeout(200);
ok(await inputDisabled() === false, 'input unlocked after showWarnings');
text = await bodyText();
ok(text.includes('Plan modification warnings'), 'warnings surfaced as system message');

console.log('4) messages after a user Stop + interrupt terminal still render (stop-gate reset)');
// enter a processing state, press the real Stop control (sets the stop-gate),
// then deliver the host's terminal interrupt and a subsequent plan update.
await send({ type: 'streamToken', token: 'about to be stopped' });
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector('.send-btn.processing')?.click());
await page.waitForTimeout(100);
await send({ type: 'plannerInterrupted', message: { role: 'planner', content: '', timestamp: new Date().toISOString() } });
await page.waitForTimeout(100);
const planAfterStop = { ...plan, tasks: [{ ...plan.tasks[0], id: 't2', title: 'Post-Stop Task' }] };
await send({ type: 'planUpdated', plan: planAfterStop });
await page.waitForTimeout(250);
text = await bodyText();
ok(text.includes('Post-Stop Task'), 'gated planUpdated renders after interrupt terminal (stoppedRef reset)');

console.log('5) restoreChat clears a stuck stopped state');
// Force the stopped state through the real path: type a message then press stop.
await send({ type: 'newMessage', message: { role: 'assistant', content: 'turn done', timestamp: new Date().toISOString() } });
await page.evaluate(() => window.__typeUser('/new'));       // sets stoppedRef via handleNewSession (no confirm when idle)
await page.waitForTimeout(150);
await send({ type: 'restoreChat', hasPlan: false, history: [
  { role: 'user', content: 'post-stop reload goal', timestamp: '2026-01-01T00:00:00Z' },
] });
await send({ type: 'planUpdated', plan });
await page.waitForTimeout(250);
text = await bodyText();
ok(text.includes('post-stop reload goal'), 'timeline restored after /new stop-gate');
ok(text.includes('Restored Task'), 'planUpdated renders after restore (stop-gate cleared)');

console.log('6) watchdog re-enables input after silence (fake clock)');
await send({ type: 'restoreChat', hasPlan: false, history: [] });
await page.waitForTimeout(100);
await send({ type: 'streamToken', token: 'about to stall…' });
await page.waitForTimeout(100);
ok(await inputDisabled() === true, 'input locked during stalled turn');
// shift Date.now 130s forward; the 5s interval then sees >120s of silence
await page.evaluate(() => {
  const skew = 130_000;
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + skew;
});
await page.waitForTimeout(6_000);
ok(await inputDisabled() === false, 'watchdog unlocked the input');
text = await bodyText();
ok(text.includes('stopped responding'), 'watchdog posted a visible notice');

await page.screenshot({ path: 'bench/live/screenshots/5-stage1-restore.png', fullPage: true });
await browser.close();
console.log(failures === 0 ? '\nall stage-1 assertions passed' : `\n${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
