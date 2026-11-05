#!/usr/bin/env node
/**
 * Drive the webview harness with a real `ConversationViewHost` (ADR-0017) and
 * capture screenshots of every state packages/ui/src/chat draws,
 * asserting the DOM at each one:
 *
 *   - a reply streams in place as message text, settles, then loses its cursor
 *   - each run of activity between two messages is one collapsed line that
 *     says what it did, and draws none of its rows until opened (ADR-0017 X1)
 *   - opening it shows its rows as their collapsed previews: thinking one
 *     line, a command row's preview exactly 3 lines with a "+N lines" hint
 *   - a row opens on its own from its header (Enter and Space included),
 *     and a subagent opens to its steps as previews, each opening on its own
 *   - the summary recounts as calls settle, and never counts an approval
 *     beside the call it was about
 *   - "building plan" becomes a plan marker chip once the plan commits
 *   - the approval card shows Allow/Deny while pending, then settles
 *   - the token line is pinned below the conversation, not inside it
 *   - a retracted attempt's text never reaches the screen
 *   - a prompt typed while a turn is live is held, with its own × unsend;
 *     Esc takes it back, and Esc Esc (nothing queued) arms then stops the turn
 *   - held prompts stack above the composer, each with Send now; with a draft
 *     typed mid-turn the composer has one button and a key hint
 *   - the task log (/tasklog) stacks its pending messages the same way, one in
 *     each state, Send now on all but the forced one, × only on the queued one
 *   - the task log folds a runner's activity the same way, a waiting request
 *     left outside where it is answered, a run with a failure in it coloured
 *     apart, and an attempt switch opens nothing
 *   - a runner's command the user denied reads as denied, counted once
 *   - a script task's log folds nothing: each step's whole output and exit,
 *     its command once, in its head
 *   - a plan's task cards carry their own fill, distinct from the plan behind
 *     them, with the expanded card and its subtasks each a step apart
 *   - the first screen is a hero, an autorun note and a repositories card: the
 *     card has a surface of its own, `/settings` is a command token, and the
 *     whole column keeps its edge with long paths in it
 *   - every colour that carries a state or a word is measured, not eyeballed:
 *     body text is held to 4.5:1, a state cue to 3:1, and a decorative surface
 *     step to being visible at all (see paintRatio/checkCue/checkSurface)
 *
 * Runs at 420px (the sidebar width) and 900px, under a dark, a light and a
 * light high-contrast VS Code theme (bench/live/webview-harness.mjs's
 * `?theme=`) — the full state tour at 420/dark, a representative subset at the
 * other combinations.
 *
 * Usage:
 *   node bench/live/webview-harness.mjs &
 *   node bench/live/webview-screenshot.mjs [--out DIR]
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from './load-playwright.mjs';
import { createDriver } from './host-driver.mjs';
import { MAIN_SCENARIO, FIRST_SCREEN, FIRST_SCREEN_AUTORUN_OFF, FIRST_SCREEN_LONG_PATHS, RELOAD_FIXTURE, RELOAD_PLAN, SCRIPT_TASK_LOG, SIGNED_OUT_PLANNERS, SIGNED_OUT_SETUP, TASK_CARDS_PLAN, TASK_LOG_ACTIVITY, TASK_LOG_DENIED, TASK_LOG_PENDING } from './scenarios.mjs';
import { EMPTY_TASK_LOG_FOLLOW, replayTaskLog, taskLogHeaderView } from '../../packages/core/dist/plan-utils.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OUT = arg('out', 'bench/live/screenshots');
const BASE = arg('url', 'http://127.0.0.1:3798');
/** `--only planner-auth` for one section while iterating on it. */
const ONLY = arg('only', '');
const runs = (section) => !ONLY || ONLY === section;
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
// A disclosure's chevron turns over 120ms; a screenshot taken sooner catches it mid-turn.
const settle = (page) => page.waitForTimeout(200);
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures.push(msg);
};

const executablePath = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});

/**
 * What the task log tab is sent for one attempt: its header read through
 * core's one header view, as TaskLogPanel builds it, so the tab draws what a
 * live task's would.
 */
function taskLogStatus(view, { awaitingApproval = 0, attempts = [1], attempt = 1, script = false } = {}) {
  const follow = { ...EMPTY_TASK_LOG_FOLLOW, view, attempts, attempt };
  return {
    taskId: 't2', order: 2, title: 'Add a JSON parser', runner: 'claude-code',
    header: taskLogHeaderView({ status: 'in_progress', resumeAt: null, continuable: false, attemptUsage: [] }, follow, awaitingApproval, attempt),
    queued: view.queued, attempts, attempt, ...(script ? { script } : {}),
  };
}

async function send(page, msg) {
  await page.evaluate((m) => window.__send(m), msg);
}
async function sendAll(page, msgs) {
  if (msgs.length) await page.evaluate((arr) => arr.forEach((m) => window.__send(m)), msgs);
}

/**
 * Walk up from `selector` to the nearest element with a real background, and
 * blend a translucent foreground over it — this codebase's muted text
 * (`--text-muted`, `color-mix(in srgb, ... transparent)`) is exactly the kind
 * of low-contrast choice worth checking, and Chrome serializes it as
 * `color(srgb r g b / a)` rather than `rgb()`, so both need parsing.
 */
async function contrastRatio(page, selector) {
  return page.evaluate((sel) => {
    const toRgba = (s) => {
      const rgb = s.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const [r, g, b, a = 1] = rgb[1].split(',').map((n) => parseFloat(n));
        return [r, g, b, a];
      }
      const fn = s.match(/color\(srgb\s+([^)]+)\)/);
      if (fn) {
        const parts = fn[1].split('/');
        const [r, g, b] = parts[0].trim().split(/\s+/).map((n) => parseFloat(n) * 255);
        const a = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
        return [r, g, b, a];
      }
      return null;
    };
    const blend = ([r, g, b, a], [br, bg, bb]) => [
      r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a),
    ];
    const luminance = ([r, g, b]) => {
      const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const el = document.querySelector(sel);
    if (!el) return null;
    const fg = toRgba(getComputedStyle(el).color);
    // Badges and tints are translucent, so composite every background up to
    // the first opaque one rather than reading the nearest as if it were solid.
    const layers = [];
    let node = el;
    while (node && !(layers.length && layers[layers.length - 1][3] >= 1)) {
      const rgba = toRgba(getComputedStyle(node).backgroundColor);
      if (rgba && rgba[3] > 0) layers.push(rgba);
      node = node.parentElement;
    }
    if (!fg || !layers.length || fg[3] === 0) return null;
    const bg = layers.reverse().reduce((under, layer) => blend(layer, under), [255, 255, 255]);
    const blended = fg[3] < 1 ? blend(fg, bg) : fg;
    const [l1, l2] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
  }, selector);
}

/**
 * The painted colours of two surfaces and the WCAG ratio between them. `fg` is
 * an element property (`{ selector, prop }`) or a raw colour (`{ css }`), and is
 * composited over the surface `bg` paints; that surface is itself composited
 * from its translucent layers down to the first opaque one. A border sits on
 * its own element's fill, so `prop: 'borderTopColor'` measures the edge the eye
 * sees rather than the declared alpha.
 */
async function paintRatio(page, fg, bgSelector) {
  return page.evaluate(([spec, bgSel]) => {
    const toRgba = (s) => {
      const rgb = s.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const [r, g, b, a = 1] = rgb[1].split(',').map((n) => parseFloat(n));
        return [r, g, b, a];
      }
      const fn = s.match(/color\(srgb\s+([^)]+)\)/);
      if (fn) {
        const parts = fn[1].split('/');
        const [r, g, b] = parts[0].trim().split(/\s+/).map((n) => parseFloat(n) * 255);
        const a = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
        return [r, g, b, a];
      }
      return null;
    };
    const blend = ([r, g, b, a], [br, bg, bb]) => [
      r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a),
    ];
    const luminance = ([r, g, b]) => {
      const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const hex = ([r, g, b]) => `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
    // Every background the element shows, floor to ceiling, as one colour.
    const painted = (el) => {
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const rgba = toRgba(getComputedStyle(node).backgroundColor);
        if (rgba && rgba[3] > 0) layers.push(rgba);
        if (rgba && rgba[3] >= 1) break;
      }
      return layers.reverse().reduce((under, layer) => blend(layer, under), [255, 255, 255]);
    };
    const fgEl = spec.selector ? document.querySelector(spec.selector) : null;
    const bgEl = document.querySelector(bgSel);
    if (!bgEl || (spec.selector && !fgEl)) return null;
    const bg = painted(bgEl);
    const declared = spec.css ? toRgba(spec.css) : toRgba(getComputedStyle(fgEl)[spec.prop ?? 'color']);
    if (!declared) return null;
    const fg = declared[3] < 1 ? blend(declared, fgEl ? painted(fgEl) : bg) : declared;
    const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return { ratio: (l1 + 0.05) / (l2 + 0.05), fg: hex(fg), bg: hex(bg) };
  }, [fg, bgSelector]);
}

/**
 * A cue that carries a state — a dot, a selected fill, a warning rule, the only
 * edge of a tintless high-contrast card: WCAG 1.4.11 asks 3:1 of it.
 */
async function checkCue(page, label, what, fg, bgSelector) {
  const painted = await paintRatio(page, fg, bgSelector);
  if (!painted) return;
  check(painted.ratio >= 3,
    `contrast ${label} ${what}: ${painted.ratio.toFixed(2)}:1 ${painted.fg} on ${painted.bg} (WCAG 1.4.11 needs 3:1)`);
}

/**
 * A decorative surface step — the tint inside a capsule, the rule of a quiet
 * note, a card's hairline: it has to be a visible step, but it is not the only
 * thing identifying a control, so 1.4.11's 3:1 does not apply to it.
 */
async function checkSurface(page, label, what, fg, bgSelector, min = 1.1) {
  const painted = await paintRatio(page, fg, bgSelector);
  if (!painted) return;
  check(painted.ratio >= min,
    `surface ${label} ${what}: ${painted.ratio.toFixed(2)}:1 ${painted.fg} on ${painted.bg} (needs ${min}:1 to read as a step)`);
}

async function assertMark(page, mark) {
  switch (mark) {
    case 'empty':
      check(await page.locator('.empty-state').count() === 1, 'empty: no-conversation state shown before anything streams');
      break;
    case 'reply-streaming':
      check(await page.locator('.chat-msg-user').count() === 1, 'reply-streaming: the user bubble rendered first');
      check((await page.locator('.chat-msg-planner.streaming .chat-msg-content').innerText()).includes('Which'), 'reply-streaming: reply text streams in place as message text');
      check(await page.locator('.chat-msg-planner.streaming .chat-msg-cursor').count() === 1, 'reply-streaming: the streaming cursor is shown');
      check(await page.locator('.send-btn.processing').count() === 1, 'reply-streaming: the stop control lives in the chat input');
      break;
    case 'reply-settled': {
      const text = await page.locator('.chat-msg-planner').last().innerText();
      check(text.includes('Which store: SQLite or Postgres?'), 'reply-settled: the settled message replaces the streamed text');
      check(await page.locator('.chat-msg-planner.streaming').count() === 0, 'reply-settled: no bubble is still marked streaming');
      check(await page.locator('.send-btn.processing').count() === 0, 'reply-settled: input back to send state');
      break;
    }
    case 'thinking-collapsed': {
      const group = page.locator('.activity-group-toggle').last();
      check((await group.innerText()) === 'Thinking…', `thinking-collapsed: the run reads as live thinking (got "${await group.innerText()}")`);
      check(await group.getAttribute('aria-expanded') === 'false', 'thinking-collapsed: the run is collapsed by default');
      check(await page.locator('.activity-think').count() === 0, 'thinking-collapsed: none of its rows is drawn while collapsed');
      await group.click();
      check(await page.locator('.activity-think').count() === 1, 'thinking-open: opening the run draws its thinking row');
      check(await page.locator('.activity-think.expanded').count() === 0, 'thinking-open: the row itself stays a one-line preview');
      await settle(page);
  await page.screenshot({ path: path.join(OUT, 'thinking-group-open.png') });
      break;
    }
    case 'command-row': {
      check((await page.locator('.activity-group-toggle').last().innerText()) === 'Listed a directory', 'command-row: the summary recounts as the call settles');
      const preview = await page.locator('.cmd-row-preview').innerText();
      check(preview.split('\n').length === 3, `command-row: preview is exactly 3 lines (got ${preview.split('\n').length})`);
      check((await page.locator('.cmd-row-more').innerText()).includes('+3 line'), 'command-row: hidden-line count shown');
      check(await page.locator('.cmd-row.expanded').count() === 0, 'command-row: collapsed by default');
      const head = page.locator('.cmd-row-toggle').last();
      await head.focus();
      await page.keyboard.press('Enter');
      check(await page.locator('.cmd-row.expanded').count() === 1, 'command-row: Enter on its header opens that row alone');
      check(await page.locator('.cmd-row-output').innerText() === 'index.ts\nstore/\nstore/sqlite.ts\nstore/postgres.ts\nutils.ts\ntypes.ts', 'command-row: open, it shows the whole output');
      check(await page.locator('.activity-think.expanded').count() === 0, 'command-row: its neighbour stays as it was');
      await settle(page);
  await page.screenshot({ path: path.join(OUT, 'command-row-open.png') });
      await page.keyboard.press('Space');
      check(await page.locator('.cmd-row.expanded').count() === 0, 'command-row: Space closes it again');
      break;
    }
    case 'building-plan':
      check((await page.locator('.plan-revision-chip').innerText()) === 'Building plan…', 'building-plan: chip reads "Building plan…"');
      check(await page.locator('.plan-revision-chip').isDisabled(), 'building-plan: chip is not clickable while building');
      break;
    case 'plan-marker':
      check((await page.locator('.plan-revision-chip').innerText()).includes('Plan generated'), 'plan-marker: chip settles to "Plan generated"');
      check((await page.locator('.plan-revision-chip').innerText()).includes('2 tasks'), 'plan-marker: task count shown');
      check(await page.locator('.plan-dock .task-card').count() === 2, 'plan-marker: the plan dock shows both task cards');
      break;
    case 'subagent-collapsed': {
      const group = page.locator('.activity-group-toggle').last();
      check((await group.innerText()) === 'Delegated to 2 agents', `subagent-collapsed: the run counts each agent once, not its steps (got "${await group.innerText()}")`);
      check(await page.locator('.subagent-card').count() === 0, 'subagent-collapsed: no card drawn while the run is collapsed');
      await group.click();
      check(await page.locator('.subagent-card').count() === 2, 'subagent-collapsed: both subagents rendered once opened');
      check(await page.locator('.subagent-card.expanded').count() === 0, 'subagent-collapsed: each card collapsed by default');
      check((await page.locator('.subagent-card-status').first().innerText()).length > 0, 'subagent-collapsed: status label shown collapsed');
      break;
    }
    case 'approval-pending':
      check(await page.locator('.conversation > .approval-card.pending').count() === 1, 'approval-pending: the waiting card stands outside any group');
      check(await page.locator('.approval-card.pending .approval-card-allow').count() === 1, 'approval-pending: Allow button shown');
      check(await page.locator('.approval-card.pending .approval-card-deny').count() === 1, 'approval-pending: Deny button shown');
      check((await page.locator('.activity-group-toggle').last().innerText()) === 'Running a command', 'approval-pending: the call it asks about reads as still running');
      break;
    case 'approval-settled': {
      const group = page.locator('.activity-group-toggle').last();
      check(await page.locator('.conversation > .approval-card').count() === 0, 'approval-settled: answered, the card folds into the run it belongs to');
      check((await group.innerText()) === 'Running a command', `approval-settled: the answer is not counted beside its call (got "${await group.innerText()}")`);
      await group.click();
      check(await page.locator('.approval-card.granted').count() === 1, 'approval-settled: card settles to granted');
      check(await page.locator('.approval-card.pending').count() === 0, 'approval-settled: no pending card left for this request');
      check(await page.locator('.approval-card.granted .approval-card-allow').count() === 0, 'approval-settled: settled card has no action buttons');
      await settle(page);
  await page.screenshot({ path: path.join(OUT, 'approval-settled-open.png') });
      break;
    }
    case 'usage-line': {
      const usage = await page.locator('.usage-line').innerText();
      check(usage.includes('ctx 1.6k (<1%)'), 'usage-line: context meter shown');
      check(usage.includes('$0.01'), 'usage-line: reported cost shown');
      check(!/\bin\b|\bout\b|cached/.test(usage), 'usage-line: no token counts drawn');
      check(usage.includes('subagent'), 'usage-line: subagent count shown');
      check(await page.locator('.message-list .usage-line').count() === 0, 'usage-line: pinned outside the scrolling message list');
      break;
    }
    case 'retracted-attempt': {
      const text = await page.locator('.message-list').innerText();
      check(!text.includes('taskOps'), 'retracted-attempt: the retracted JSON attempt never reached the screen');
      check(!text.includes('Split it'), 'retracted-attempt: the retracted prose attempt never reached the screen');
      check(text.includes('Task 3 splits cleanly into 3a and 3b.'), 'retracted-attempt: the settled reply is shown');
      break;
    }
    case 'turn-open':
      check(await page.locator('.send-btn.processing').count() === 1, 'turn-open: input shows the turn is live');
      break;
  }
}

/** A subagent opens to its steps as previews, and a step opens on its own: no level opens the next. */
async function independentDisclosures(page) {
  check(await page.locator('.detail-toggle, .chat-header').count() === 0, 'disclosures: no expand-all control, and no header kept for one');
  const first = page.locator('.subagent-card-header').first();
  await first.click();
  check(await page.locator('.subagent-card.expanded').count() === 1, 'disclosures: one subagent opens, not every one together');
  check(await page.locator('.subagent-card-steps .cmd-row').count() === 1, 'disclosures: its steps show as rows');
  check(await page.locator('.subagent-card-steps .cmd-row.expanded, .subagent-card-steps .activity-think.expanded').count() === 0, 'disclosures: opening the agent opens none of its steps');
  await page.locator('.subagent-card-steps .cmd-row-toggle').first().click();
  check(await page.locator('.subagent-card-steps .cmd-row.expanded').count() === 1, 'disclosures: a step opens on its own');
  check(await first.getAttribute('aria-expanded') === 'true', 'disclosures: the agent stays open around it');
  await settle(page);
  await page.screenshot({ path: path.join(OUT, 'subagent-step-open.png') });
  await first.click();
  check(await page.locator('.subagent-card.expanded').count() === 0, 'disclosures: the agent closes again');
}

const PENDING_CONTRAST = ['.pending-message-text', '.pending-message-state', '.send-key-hint'];

async function checkContrast(page, label, selectors) {
  for (const sel of selectors) {
    const ratio = await contrastRatio(page, sel);
    // Several scenarios pass a superset of the selectors they draw, so an
    // absent one is skipped rather than failed.
    if (ratio === null) continue;
    check(ratio >= 4.5, `contrast ${label} ${sel}: ${ratio.toFixed(2)}:1 (WCAG AA text needs 4.5:1)`);
  }
}

/**
 * Held prompts above the composer with a draft typed mid-turn, the first
 * hovered so its actions show. Posted straight to the page and cleared after,
 * so the host-driven tour that follows sees no difference.
 */
async function pendingPlanner(page, label, file) {
  await send(page, { type: 'heldPrompts', prompts: ['also cover caching', 'and keep the public routes stable: no breaking changes to the API'] });
  await page.fill('.chat-input-row textarea', 'use Postgres, not SQLite');
  await page.hover('.pending-message >> nth=0');
  await page.waitForTimeout(200); // the actions fade in
  check(await page.locator('.pending-messages .pending-message').count() === 2, `pending-planner ${label}: both held prompts stacked`);
  check(await page.locator('.message-list .pending-messages').count() === 0, `pending-planner ${label}: the stack sits outside the conversation`);
  check(await page.evaluate(() => document.querySelector('.pending-messages')?.nextElementSibling?.classList.contains('chat-input')), `pending-planner ${label}: directly above the composer`);
  check(await page.locator('.pending-message-now').count() === 2, `pending-planner ${label}: Send now on each`);
  check(await page.locator('.pending-message-remove').count() === 1, `pending-planner ${label}: only the newest carries the ×`);
  check(await page.locator('.chat-input-row button').count() === 1, `pending-planner ${label}: one button in the composer`);
  check((await page.locator('.send-key-hint').innerText()).includes('send now'), `pending-planner ${label}: the key hint names send now`);
  await checkContrast(page, `pending-planner ${label}`, PENDING_CONTRAST);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.mouse.move(0, 0);
  await page.fill('.chat-input-row textarea', '');
  await send(page, { type: 'heldPrompts', prompts: [] });
}

async function pendingTaskLog(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 640 } });
  await page.goto(`${BASE}/tasklog?theme=${theme}`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  const view = replayTaskLog(TASK_LOG_PENDING);
  await send(page, { type: 'init', blocks: view.blocks, status: taskLogStatus(view) });
  await page.fill('.task-log-input', 'and log every parse error');
  await page.hover('.pending-message >> nth=1');
  await page.waitForTimeout(200);
  const states = await page.locator('.pending-message-state').allInnerTexts();
  check(JSON.stringify(states) === JSON.stringify(['sending now…', 'waiting for the current step', 'queued']), `tasklog ${label}: each pending message says where it stands (${states.join(' | ')})`);
  check(await page.locator('.pending-message-now').count() === 2, `tasklog ${label}: Send now on the handed-over and queued ones, not the forced one`);
  check(await page.locator('.pending-message-remove').count() === 1, `tasklog ${label}: × only on the one still queued`);
  check(await page.getByText(/^Queued \(/).count() === 0, `tasklog ${label}: no Queued (n) heading`);
  check(await page.locator('.task-log-composer button').count() === 1, `tasklog ${label}: one button in the composer`);
  check((await page.locator('.send-key-hint').innerText()).includes('send now'), `tasklog ${label}: the key hint names send now`);
  await checkContrast(page, `tasklog ${label}`, PENDING_CONTRAST);
  await page.screenshot({ path: path.join(OUT, `tasklog-pending-${width}-${theme}.png`) });
  await page.close();
}

const ACTIVITY_CONTRAST = ['.activity-group-summary', '.cmd-row-head', '.activity-think-label', '.subagent-card-brief', '.cmd-row-outcome', '.cmd-row-more'];

/**
 * A runner's turn in the task log, folded: what each run did, the agent's
 * words between, the write it is waiting on left outside; then both
 * disclosure levels, and an attempt switch that opens nothing.
 */
async function taskLogActivity(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/tasklog?theme=${theme}`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  const view = replayTaskLog(TASK_LOG_ACTIVITY);
  const status = (attempt) => taskLogStatus(view, { awaitingApproval: 1, attempts: [1, 2], attempt });
  await send(page, { type: 'init', blocks: view.blocks, status: status(2) });
  const groups = page.locator('.activity-group-toggle');
  const summaries = await groups.allInnerTexts();
  check(JSON.stringify(summaries) === JSON.stringify(['Ran a command, read a file, fetched a page (1 failed), delegated to an agent', 'Making an edit']),
    `tasklog-activity ${label}: each run says what it did (${summaries.join(' | ')})`);
  check(await page.locator('.conversation > .approval-card.pending .approval-card-allow').count() === 1, `tasklog-activity ${label}: the waiting write stays outside, answerable`);
  check(await page.locator('.cmd-row, .subagent-card, .activity-think').count() === 0, `tasklog-activity ${label}: collapsed runs draw none of their rows`);
  const colours = await page.locator('.activity-group-summary').evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  check(await page.locator('.activity-group').first().getAttribute('data-state') === 'failed' && colours[0] !== colours[1],
    `tasklog-activity ${label}: the run with a failure in it reads apart from one without (${colours.join(' vs ')})`);
  await checkContrast(page, `tasklog-activity ${label}`, ['.activity-group-summary']);
  await page.screenshot({ path: path.join(OUT, `tasklog-activity-collapsed-${width}-${theme}.png`) });

  await groups.first().click();
  check(await page.locator('.cmd-row').count() === 3, `tasklog-activity ${label}: open, the run shows its calls as previews`);
  check(await page.locator('.subagent-card').count() === 1 && await page.locator('.subagent-card-steps').count() === 0, `tasklog-activity ${label}: the agent shows as one card, its steps folded`);
  check(await page.locator('.cmd-row.expanded, .activity-think.expanded').count() === 0, `tasklog-activity ${label}: no row opens with the run`);
  await page.locator('.subagent-card-header').click();
  await page.locator('.subagent-card-steps .cmd-row-toggle').last().click();
  check(await page.locator('.subagent-card-steps .cmd-row.expanded').count() === 1 && await page.locator('.subagent-card-steps .cmd-row').count() === 2, `tasklog-activity ${label}: one step of the agent opens on its own`);
  await page.locator('.activity-group-body > .activity-think .activity-think-head').click();
  check(await page.locator('.activity-think-pre').count() === 1, `tasklog-activity ${label}: the thinking opens on its own`);
  await checkContrast(page, `tasklog-activity ${label}`, ACTIVITY_CONTRAST);
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `tasklog-activity-open-${width}-${theme}.png`), fullPage: true });

  await send(page, { type: 'init', blocks: view.blocks, status: status(1) });
  const after = await groups.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')));
  check(after.every((v) => v === 'false'), `tasklog-activity ${label}: another attempt opens with nothing open (${after.join(',')})`);

  const denied = replayTaskLog(TASK_LOG_DENIED);
  await send(page, { type: 'init', blocks: denied.blocks, status: taskLogStatus(denied) });
  const deniedSummaries = await groups.allInnerTexts();
  check(JSON.stringify(deniedSummaries) === JSON.stringify(['1 command denied']),
    `tasklog-activity ${label}: a denied command is told once, as denied (${deniedSummaries.join(' | ')})`);
  await groups.first().click();
  check(await page.locator('.activity-group-body .approval-card.denied').count() === 1, `tasklog-activity ${label}: the denial stays in its run, open`);
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `tasklog-denied-${width}-${theme}.png`), fullPage: true });
  await page.close();
}

/**
 * A script task's log (ADR-0035): each step as run, its whole output and its
 * exit in view, with nothing folded and nothing to open.
 */
async function scriptTaskLog(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/tasklog?theme=${theme}`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  const view = replayTaskLog(SCRIPT_TASK_LOG);
  await send(page, { type: 'init', blocks: view.blocks, status: taskLogStatus(view, { script: true }) });
  check(await page.locator('.activity-group').count() === 0, `tasklog-script ${label}: nothing folds`);
  const heads = await page.locator('.conversation > .cmd-row .cmd-row-head').allTextContents();
  check(JSON.stringify(heads) === JSON.stringify(['Run(npm ci)', 'Run(npm test)', 'Run(npm run lint)']), `tasklog-script ${label}: every step in view (${heads.join(' | ')})`);
  const besides = await page.locator('.conversation > .cmd-row').evaluateAll((rows) => rows.every((row) => {
    const icon = row.querySelector('.cmd-row-icon').getBoundingClientRect();
    const head = row.querySelector('.cmd-row-head').getBoundingClientRect();
    return Math.abs(icon.top - head.top) < icon.height && icon.right <= head.left;
  }));
  check(besides, `tasklog-script ${label}: each step's glyph sits beside its command`);
  const failing = await page.locator('.conversation > .cmd-row').nth(1).innerText();
  check(failing.includes('Tests  1 failed') && failing.includes('exited 1 after'), `tasklog-script ${label}: the failing step's whole output and exit in view`);
  check(await page.locator('.conversation [aria-expanded]').count() === 0, `tasklog-script ${label}: nothing to open`);
  check(await page.locator('.conversation .cmd-row-args').count() === 0, `tasklog-script ${label}: each command once, in its head, with no arguments block`);
  await checkContrast(page, `tasklog-script ${label}`, ['.cmd-row-head', '.cmd-row-outcome', '.cmd-row-output']);
  await page.screenshot({ path: path.join(OUT, `tasklog-script-${width}-${theme}.png`), fullPage: true });
  await page.close();
}

const CARD_CONTRAST = [
  '.task-card.expanded .task-description', '.task-card.expanded .task-order', '.task-card.expanded .task-type-badge',
  '.task-card.expanded .task-status-badge', '.subtask-card .task-status-badge', '.subtask-title-text',
  '.task-card:not(.expanded) .task-status-badge.status-pending', '.task-card:not(.expanded) .task-status-badge.status-completed',
  '.task-card:not(.expanded) .task-status-badge.status-failed', '.task-message-box .send-key-hint',
  '.task-card.expanded .task-deps', '.task-card.expanded .task-log-open-btn', '.task-card.expanded .task-dep-badge.dep-in',
  '.task-card.expanded .task-dep-badge.dep-out', '.subtask-prompt', '.subtask-order', '.task-card.user .task-type-badge',
];

/** The fill an element actually shows, translucent layers composited as in contrastRatio. */
function fillOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null;
  }, selector);
}

async function taskCards(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 1300 } });
  await page.goto(`${BASE}/?theme=${theme}`);
  await page.waitForSelector('.chat-container');
  await sendAll(page, MAIN_SCENARIO.filter((s) => s.post?.type?.startsWith('set')).map((s) => s.post));
  await send(page, { type: 'planUpdated', plan: TASK_CARDS_PLAN });
  await page.locator('.setup-panel-toggle-label').click(); // the plan, not the settings, is the subject here
  // As if dragged all the way up: the empty conversation above has nothing to show.
  await page.evaluate(() => { const body = document.querySelector('.plan-dock-body'); if (body) body.style.maxHeight = 'none'; });
  await page.locator('.plan-dock .task-card-header').first().click();
  await page.locator('.subtask-card-header').first().click();
  await page.hover('.plan-dock .task-card >> nth=2');
  await page.evaluate(() => document.querySelector('.plan-dock-body')?.scrollTo(0, 0));
  await page.waitForTimeout(250); // the card transitions settle
  check(await page.locator('.plan-dock .task-card').count() === 4, `task-cards ${label}: all four cards shown`);
  check(await page.locator('.task-card.expanded .subtask-card').count() === 2, `task-cards ${label}: the expanded card shows its subtasks`);
  const [dock, rest, hover, expanded, subtask] = await Promise.all([
    fillOf(page, '.plan-dock-body'), fillOf(page, '.task-card:not(.expanded):not(:hover)'),
    fillOf(page, '.task-card:hover'), fillOf(page, '.task-card.expanded'), fillOf(page, '.subtask-card'),
  ]);
  console.log(`    fills: dock ${dock} · card ${rest} · hover ${hover} · expanded ${expanded} · subtask ${subtask}`);
  if (theme.startsWith('high-contrast')) {
    // High contrast draws a card as its edge alone (docs/desktop/design.md, Surfaces).
    const edge = await page.locator('.task-card:not(.expanded):not(:hover)').first().evaluate((el) => getComputedStyle(el).borderTopColor);
    check(edge === await resolvedColour(page, 'var(--vscode-contrastBorder)'), `task-cards ${label}: a tintless card keeps the theme's contrast border (${edge})`);
  } else {
    check(rest !== dock, `task-cards ${label}: a resting card is filled apart from the plan behind it`);
    check(expanded !== rest && hover !== rest, `task-cards ${label}: hover and expanded are a step beyond the resting card`);
    check(subtask !== expanded, `task-cards ${label}: a subtask separates from its expanded parent`);
    // The surface ladder's lift: each step stands off what it sits on.
    for (const [what, selector, behind] of [
      ['a resting card on the plan', '.task-card:not(.expanded):not(:hover)', '.plan-dock-body'],
      ['the open card on the plan', '.task-card.expanded', '.plan-dock-body'],
      ['a subtask in its open card', '.subtask-card', '.task-card.expanded'],
    ]) await checkSurface(page, `task-cards ${label}`, what, { selector, prop: 'backgroundColor' }, behind, 1.05);
  }
  await checkContrast(page, `task-cards ${label}`, CARD_CONTRAST);
  await page.screenshot({ path: path.join(OUT, `task-cards-${width}-${theme}.png`) });
  await page.close();
}

async function queuedPromptAndEscape(page) {
  // Someone typing a follow-up while a turn streams is watching it, i.e. at
  // the bottom already — App's own scroll-pin only follows new content while
  // `userPinnedToBottomRef` is true, which a scripted mid-conversation jump
  // (rather than a real user's scroll) may otherwise leave unset.
  await page.evaluate(() => document.querySelector('.message-list')?.scrollTo(0, 1e6));
  await page.waitForTimeout(60); // let the scroll listener record the pin before typing races it
  await page.evaluate(() => window.__typeUser('add caching too'));
  // The scroll-into-view on a newly queued prompt is `behavior: 'smooth'`;
  // a short wait here would screenshot mid-animation with the bubble still
  // clipped below the fold.
  await page.waitForTimeout(500);
  check(await page.locator('.pending-message').count() === 1, 'queued-prompt: held while the turn is live');
  check((await page.locator('.pending-message-text').innerText()) === 'add caching too', 'queued-prompt: shows the held text');
  check(await page.locator('.pending-message-remove').count() === 1, 'queued-prompt: the newest carries the × unsend');
  await page.screenshot({ path: path.join(OUT, 'queued-prompt.png') });

  await page.evaluate(() => window.__pressEscape());
  await page.waitForTimeout(60);
  check(await page.locator('.pending-message').count() === 0, 'esc-unsend: Esc takes back the queued prompt');
  check(await page.locator('.chat-input-row textarea').inputValue() === 'add caching too', 'esc-unsend: the text lands back in the input');

  await page.evaluate(() => window.__pressEscape());
  await page.waitForTimeout(60);
  check(await page.locator('.stop-hint').count() === 1, 'esc-arm: first Esc (nothing queued) arms the stop hint');
  await page.screenshot({ path: path.join(OUT, 'esc-armed.png') });

  await page.evaluate(() => window.__pressEscape());
  await page.waitForTimeout(60);
  const posted = await page.evaluate(() => window.__posted.some((m) => m.type === 'stopResearch'));
  check(posted, 'esc-esc: second Esc sends stopResearch');
  check(await page.locator('.send-btn.processing').count() === 0, 'esc-esc: the turn stops on screen');
  check(await page.locator('.stop-hint').count() === 0, 'esc-esc: the stop hint clears once stopped');
}

async function reloadScenario(page) {
  const driver = createDriver();
  await page.evaluate(() => window.__posted.length = 0);
  await send(page, { type: 'restoreChat' });
  driver.host.reload(RELOAD_FIXTURE);
  await sendAll(page, driver.take());
  await send(page, { type: 'planUpdated', plan: RELOAD_PLAN });
  await page.waitForTimeout(60);

  const groups = page.locator('.activity-group-toggle');
  const expanded = await groups.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')));
  check(expanded.length > 0 && expanded.every((v) => v === 'false'), `reload: every run is rebuilt collapsed, nothing opened before carried over (${expanded.join(',')})`);
  const summaries = await groups.allInnerTexts();
  check(JSON.stringify(summaries) === JSON.stringify(['Delegated to an agent', 'Read a file']), `reload: each saved run says what it did, in the order it ran (${summaries.join(' | ')})`);
  await settle(page);
  await page.screenshot({ path: path.join(OUT, 'reload-collapsed.png') });
  for (const group of await groups.all()) await group.click();

  const text = await page.locator('.message-list').innerText();
  check(text.includes('add a parser'), 'reload: the user goal is restored');
  check(text.includes('Which formats do you need?'), 'reload: the planner reply before the plan is restored');
  check(text.includes('Anything else you want tweaked?'), 'reload: the planner reply after the plan is restored');
  check(await page.locator('.plan-revision-chip').count() === 1, 'reload: the plan marker is restored');
  check(await page.locator('.cmd-row').count() === 1, 'reload: a tool row survives reload (R1)');
  check(await page.locator('.subagent-card').count() === 1, 'reload: a subagent (with its digest) survives reload (R1)');
  check(await page.locator('.subagent-card-digest').innerText() === 'No parser exists yet.', 'reload: the subagent digest is shown even collapsed');
  check(await page.locator('.activity-think').count() === 0, 'reload: thinking is deliberately NOT reconstructed (R1)');
  check(await page.locator('.usage-line').count() === 1, 'reload: the token line survives reload (R1)');
  check(await page.locator('.plan-dock .task-card').count() === 1, 'reload: the plan dock repopulates from the reload');

  // Anchor position: the plan marker sits before the trailing planner message.
  const order = await page.evaluate(() => [...document.querySelectorAll('.message-list .conversation > *')]
    .map((el) => (el.classList.contains('plan-revision-chip-row') ? 'plan' : el.className.includes('chat-msg-planner') ? 'planner' : el.className)));
  const planIdx = order.indexOf('plan');
  check(planIdx > 0 && planIdx < order.length - 1, `reload: plan marker anchored before the trailing message (order: ${order.join(',')})`);

  await page.screenshot({ path: path.join(OUT, 'reload-from-transcript.png') });
}

const loginBox = (page, selector) => page.locator(selector).boundingBox();

/** A colour expression as the page's current theme resolves it. */
function resolvedColour(page, css) {
  return page.evaluate((value) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = value;
    document.body.appendChild(probe);
    const out = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return out;
  }, css);
}

/** The first non-empty text node inside `selector`, as one client rect. */
function firstTextRect(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = null;
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue?.trim()) { node = walker.currentNode; break; }
    }
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    return rect ? { x: rect.x, y: rect.y, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
  }, selector);
}

/**
 * One segmented capsule's geometry and paint: the group's one border and fill,
 * the name and login segments' own boxes (which may own no border at all), the
 * dot, and the divider the login segment draws between them.
 */
function segmented(page, groupSel, nameSel, loginSel) {
  return page.evaluate(([g, n, l]) => {
    const group = document.querySelector(g);
    if (!group) return null;
    const name = group.querySelector(n);
    const login = group.querySelector(l);
    const dot = group.querySelector('.planner-auth-dot');
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const paint = (el) => {
      const s = getComputedStyle(el);
      return { fill: s.backgroundColor, color: s.color, border: s.borderTopWidth, borderColour: s.borderTopColor, shadow: s.boxShadow };
    };
    const gs = getComputedStyle(group);
    const divider = login ? getComputedStyle(login, '::before') : null;
    return {
      group: { ...box(group), ...paint(group), borderStyle: gs.borderTopStyle },
      name: name ? { ...box(name), ...paint(name) } : null,
      login: login ? { ...box(login), ...paint(login) } : null,
      dot: dot ? { ...box(dot), ...paint(dot) } : null,
      divider: divider
        ? { width: divider.width, background: divider.backgroundColor, top: divider.top, bottom: divider.bottom }
        : null,
    };
  }, [groupSel, nameSel, loginSel]);
}

/** The paint both login variants must share: one action in two places. */
function loginLook(page, selector) {
  return page.evaluate((sel) => {
    const s = getComputedStyle(document.querySelector(sel));
    return { colour: s.color, weight: s.fontWeight, fill: s.backgroundColor };
  }, selector);
}

const solid = (value) => value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent';

/**
 * The signed-out agent treatment: one capsule per agent, its name and its own
 * login segments of the same border, the empty state's one status row per
 * agent with the same action, pending and failed states, then the same actions
 * once the first screen is gone. Each state is checked for the reflow a pending
 * label is most likely to cause, and every theme for its focus ring.
 */
async function signedOutPlanner(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 720 } });
  await page.goto(`${BASE}/?theme=${theme}`);
  await page.waitForSelector('.chat-container');
  await sendAll(page, SIGNED_OUT_SETUP.map((s) => s.post));
  await page.waitForSelector('.planner-auth-rows');
  await settle(page);

  const row = (runner) => `.planner-auth-row[data-runner="${runner}"]`;
  const plannerLogin = (runner) => page.locator(`.planner-pill-item[data-runner="${runner}"] .planner-pill-login`);

  check(await page.locator('.planner-pill.signed-out').count() === 2, `planner-auth ${label}: both signed-out agents carry the pill flag`);
  const rows = await page.locator('.planner-auth-row').evaluateAll((els) => els.map((el) => ({
    runner: el.dataset.runner,
    text: el.querySelector('.planner-auth-warning-text')?.textContent,
    login: el.querySelector('.planner-login-btn')?.getAttribute('aria-label'),
  })));
  check(JSON.stringify(rows) === JSON.stringify([
    { runner: 'claude-code', text: 'Claude Code not logged in.', login: 'Log in to Claude Code' },
    { runner: 'codex', text: 'Codex not logged in.', login: 'Log in to Codex' },
  ]), `planner-auth ${label}: one row per agent, each naming its own login (${rows.map((r) => r.text).join(' | ')})`);
  check(await page.locator('.planner-backends .planner-pill-login').count() === 2,
    `planner-auth ${label}: each signed-out pill carries its login in the menu while the empty state shows`);
  check(await plannerLogin('claude-code').getAttribute('aria-label') === 'Log in to Claude Code'
    && await plannerLogin('codex').getAttribute('aria-label') === 'Log in to Codex',
  `planner-auth ${label}: each menu login names its agent`);

  check(await page.locator('.runner-pill.signed-out').count() === 2, `planner-auth ${label}: both signed-out runners carry the flag too`);
  const runnerLogins = await page.locator('.runner-pill-login').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  check(JSON.stringify(runnerLogins) === JSON.stringify(['Log in to Claude Code', 'Log in to Codex']),
    `planner-auth ${label}: each signed-out runner carries its own login (${runnerLogins.join(' | ')})`);

  // The one capsule look, resolved by this theme rather than assumed: the
  // group paints the red tint and boundary, neither segment owns a border, and
  // the dot, fill and text are the same tokens everywhere.
  const highContrast = theme.startsWith('high-contrast');
  const red = await resolvedColour(page, 'var(--red)');
  const tint = await resolvedColour(page, 'color-mix(in srgb, var(--red) 10%, transparent)');
  const weakerTint = await resolvedColour(page, 'color-mix(in srgb, var(--red) 4%, transparent)');
  const border = highContrast
    ? await resolvedColour(page, 'var(--vscode-contrastBorder)')
    : await resolvedColour(page, 'var(--red-boundary)');
  const loginTint = await resolvedColour(page, highContrast
    ? 'color-mix(in srgb, var(--red) 20%, transparent)'
    : 'color-mix(in srgb, var(--red) 16%, transparent)');
  const selectedTint = await resolvedColour(page, 'color-mix(in srgb, var(--red) 30%, transparent)');
  const textPrimary = await resolvedColour(page, 'var(--text-primary)');
  const textSecondary = await resolvedColour(page, 'var(--text-secondary)');

  for (const runner of ['claude-code', 'codex']) {
    const planner = await segmented(page,
      `.planner-pill-item[data-runner="${runner}"] .planner-pill-group`,
      '.planner-pill', '.planner-pill-login');
    check(!!planner?.name && !!planner.login, `planner-auth ${label}: ${runner}'s planner capsule has both segments`);
    if (!planner?.name || !planner.login) continue;
    check(planner.group.border === '1px' && planner.group.borderStyle === 'solid'
      && planner.name.border === '0px' && planner.login.border === '0px',
    `planner-auth ${label}: ${runner}'s planner capsule owns the one border, not either segment (${planner.group.border} ${planner.group.borderStyle}; ${planner.name.border}, ${planner.login.border})`);
    check(planner.group.fill === tint && planner.group.borderColour === border,
      `planner-auth ${label}: ${runner}'s planner capsule is the signed-out tint and boundary (${planner.group.fill} / ${planner.group.borderColour})`);
    check(planner.dot?.fill === red, `planner-auth ${label}: ${runner}'s planner dot is the theme's red (${planner.dot?.fill})`);
    check(planner.login.fill === loginTint, `planner-auth ${label}: ${runner}'s login segment has the one login fill (${planner.login.fill})`);
    check(planner.name.color === textPrimary, `planner-auth ${label}: ${runner}'s signed-out name is text-primary (${planner.name.color})`);
    const plannerLoginText = await firstTextRect(page, `.planner-pill-item[data-runner="${runner}"] .planner-pill-login`);
    check(!!plannerLoginText && planner.login.w < planner.name.w && planner.login.w <= plannerLoginText.width + 20,
      `planner-auth ${label}: ${runner}'s login segment reserves only "Log in", not the wider pending words (${planner.login.w} beside name ${planner.name.w}, text ${plannerLoginText?.width})`);
    check(Math.abs(planner.name.h - planner.login.h) <= 0.5
      && Math.abs(planner.name.x + planner.name.w - planner.login.x) <= 0.5,
    `planner-auth ${label}: ${runner}'s planner segments are equal height and flush (${planner.name.h} vs ${planner.login.h}; ${planner.name.x + planner.name.w} → ${planner.login.x})`);
    check(planner.divider?.width === '1px' && solid(planner.divider.background)
      && parseFloat(planner.divider.top) > 0 && parseFloat(planner.divider.bottom) > 0,
    `planner-auth ${label}: ${runner}'s divider is one inset line between the segments (${JSON.stringify(planner.divider)})`);

    const runnerCapsule = await segmented(page,
      `.runner-pill-item[data-runner="${runner}"] .runner-pill-group`,
      '.runner-pill', '.runner-pill-login');
    check(!!runnerCapsule?.name && !!runnerCapsule.login, `planner-auth ${label}: ${runner}'s runner capsule has both segments`);
    if (!runnerCapsule?.name || !runnerCapsule.login) continue;
    check(runnerCapsule.group.border === '1px' && runnerCapsule.name.border === '0px' && runnerCapsule.login.border === '0px',
      `planner-auth ${label}: ${runner}'s runner capsule owns the one border too`);
    const switchedOn = await page.locator(`.runner-pill-item[data-runner="${runner}"] .runner-pill`).getAttribute('aria-pressed') === 'true';
    check(runnerCapsule.group.fill === (switchedOn ? tint : weakerTint) && runnerCapsule.group.borderColour === border
      && runnerCapsule.group.borderStyle === (switchedOn ? 'solid' : 'dashed'),
    `planner-auth ${label}: ${runner}'s signed-out runner keeps its ${switchedOn ? 'on (solid, stronger)' : 'off (dashed, weaker)'} shape (${runnerCapsule.group.borderStyle}, ${runnerCapsule.group.fill})`);
    check(runnerCapsule.dot?.fill === (switchedOn ? red : 'rgba(0, 0, 0, 0)'),
      `planner-auth ${label}: ${runner}'s runner dot is ${switchedOn ? 'filled red on' : 'a hollow red ring off'} (${runnerCapsule.dot?.fill})`);
    check(runnerCapsule.name.color === (switchedOn ? textPrimary : textSecondary),
      `planner-auth ${label}: ${runner}'s signed-out runner name is ${switchedOn ? 'text-primary' : 'text-secondary'} (${runnerCapsule.name.color})`);
    check(Math.abs(runnerCapsule.name.h - runnerCapsule.login.h) <= 0.5
      && Math.abs(runnerCapsule.name.x + runnerCapsule.name.w - runnerCapsule.login.x) <= 0.5,
    `planner-auth ${label}: ${runner}'s runner segments are equal height and flush`);
    check(runnerCapsule.divider?.width === '1px' && solid(runnerCapsule.divider.background)
      && parseFloat(runnerCapsule.divider.top) > 0 && parseFloat(runnerCapsule.divider.bottom) > 0,
    `planner-auth ${label}: ${runner}'s runner divider is one inset line`);

    const runnerLoginText = await firstTextRect(page, `.runner-pill-item[data-runner="${runner}"] .runner-pill-login`);
    check(!!runnerLoginText && runnerCapsule.login.w < runnerCapsule.name.w && runnerCapsule.login.w <= runnerLoginText.width + 20,
      `planner-auth ${label}: ${runner}'s runner login reserves only "Log in", not the wider pending words (${runnerCapsule.login.w} beside name ${runnerCapsule.name.w}, text ${runnerLoginText?.width})`);

    // The red, measured as painted: the capsule's edge and its divider are
    // reinforcement (a surface step), the dot is the cue that carries the state
    // and must clear 3:1 against the tint it sits on. On a white page the edge
    // itself is also held to 3:1, which is what the light themes' stronger mix
    // buys; dark keeps its quieter 45% because the dot already carries it.
    await checkSurface(page, `planner-auth ${label}`, `${runner}'s capsule edge`,
      { selector: `.planner-pill-item[data-runner="${runner}"] .planner-pill-group`, prop: 'borderTopColor' }, 'body', 1.5);
    if (theme.endsWith('light')) {
      await checkCue(page, `planner-auth ${label}`, `${runner}'s capsule boundary`,
        { selector: `.planner-pill-item[data-runner="${runner}"] .planner-pill-group`, prop: 'borderTopColor' }, 'body');
    }
    await checkSurface(page, `planner-auth ${label}`, `${runner}'s login divider`,
      { css: planner.divider.background }, `.planner-pill-item[data-runner="${runner}"] .planner-pill-login`, 1.3);
    await checkCue(page, `planner-auth ${label}`, `${runner}'s signed-out dot`,
      { selector: `.planner-pill-item[data-runner="${runner}"] .planner-auth-dot`, prop: 'backgroundColor' },
      `.planner-pill-item[data-runner="${runner}"] .planner-pill-group`);
    if (runnerCapsule.dot?.fill === 'rgba(0, 0, 0, 0)') {
      check(runnerCapsule.dot.shadow.includes(red),
        `planner-auth ${label}: ${runner}'s hollow off dot is a ring in the theme's red (${runnerCapsule.dot.shadow})`);
      await checkCue(page, `planner-auth ${label}`, `${runner}'s hollow off ring`, { css: red }, `.runner-pill-item[data-runner="${runner}"] .runner-pill-group`);
    } else {
      await checkCue(page, `planner-auth ${label}`, `${runner}'s runner dot`,
        { selector: `.runner-pill-item[data-runner="${runner}"] .runner-dot`, prop: 'backgroundColor' },
        `.runner-pill-item[data-runner="${runner}"] .runner-pill-group`);
    }
  }

  // An item with no login reserves no failure line, so the top edge is the
  // only baseline every capsule can share.
  const capsuleTops = await page.evaluate(() => [...document.querySelectorAll('.runner-pill-item')].map((item) => ({
    runner: item.dataset.runner,
    y: item.querySelector('.runner-pill-group')?.getBoundingClientRect().y,
  })));
  check(capsuleTops.length === 3 && capsuleTops.every((c) => Math.abs(c.y - capsuleTops[0].y) <= 0.5),
    `planner-auth ${label}: on, off and login-free runner capsules start on the same top edge (${capsuleTops.map((c) => `${c.runner} ${c.y}`).join(', ')})`);

  // Only the active agent's name takes the stronger tint; the login beside it
  // is the same fill as every other login, never a second selection.
  const activePlannerCapsule = await segmented(page,
    '.planner-pill-item[data-runner="claude-code"] .planner-pill-group', '.planner-pill', '.planner-pill-login');
  const idlePlannerCapsule = await segmented(page,
    '.planner-pill-item[data-runner="codex"] .planner-pill-group', '.planner-pill', '.planner-pill-login');
  check(activePlannerCapsule?.name?.fill === selectedTint,
    `planner-auth ${label}: the active signed-out name carries the stronger red tint (${activePlannerCapsule?.name?.fill})`);
  check(idlePlannerCapsule?.name?.fill === 'rgba(0, 0, 0, 0)',
    `planner-auth ${label}: an unselected signed-out name is not filled (${idlePlannerCapsule?.name?.fill})`);
  check(activePlannerCapsule?.login?.fill === loginTint && idlePlannerCapsule?.login?.fill === loginTint,
    `planner-auth ${label}: both menu logins use the one fill, selected planner or not`);

  // Keyboard order follows the eye: the name selects, then its login.
  const tabOrder = await page.locator('.planner-pill-item[data-runner="claude-code"] .planner-pill-group').evaluate((group) =>
    [...group.querySelectorAll('button')].map((b) => b.className.includes('planner-pill-login') ? 'login' : 'name'));
  check(JSON.stringify(tabOrder) === JSON.stringify(['name', 'login']),
    `planner-auth ${label}: the capsule's keyboard order is the name then its login (${tabOrder.join(' → ')})`);
  const runnerTabOrder = await page.locator('.runner-pill-item[data-runner="claude-code"] .runner-pill-group').evaluate((group) =>
    [...group.querySelectorAll('button')].map((b) => b.className.includes('runner-pill-login') ? 'login' : 'name'));
  check(JSON.stringify(runnerTabOrder) === JSON.stringify(['name', 'login']),
    `planner-auth ${label}: the runner capsule's keyboard order is the name then its login (${runnerTabOrder.join(' → ')})`);

  // Hover belongs to the segment under the pointer: the capsule's boundary is
  // not a hover surface of its own.
  const boundaryBefore = await page.locator('.planner-pill-item[data-runner="claude-code"] .planner-pill-group')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  await plannerLogin('claude-code').hover();
  await settle(page);
  const boundaryOnLoginHover = await page.locator('.planner-pill-item[data-runner="claude-code"] .planner-pill-group')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  check(boundaryOnLoginHover === boundaryBefore,
    `planner-auth ${label}: hovering the login leaves the capsule boundary alone (${boundaryBefore})`);
  await page.mouse.move(0, 0);
  await settle(page);

  // The row carries the same two-part sentence, with the label's own weight
  // and the explanation in the secondary colour.
  const rowLabel = await page.locator(`${row('claude-code')} .planner-auth-warning-agent`).evaluate((el) => {
    const s = getComputedStyle(el);
    return { colour: s.color, weight: s.fontWeight };
  });
  const rowSentence = await page.locator(`${row('claude-code')} .planner-auth-warning-text`).evaluate((el) => getComputedStyle(el).color);
  check(rowLabel.colour === textPrimary && rowLabel.weight === '500' && rowSentence === textSecondary,
    `planner-auth ${label}: the row names the agent in text-primary 500 and explains it in text-secondary (${JSON.stringify(rowLabel)}, ${rowSentence})`);

  const region = await page.locator('.planner-auth-rows').evaluate((el) => ({ role: el.getAttribute('role'), live: el.getAttribute('aria-live') }));
  check(region.role === 'status' && region.live === 'polite',
    `planner-auth ${label}: the rows are one polite live region (${JSON.stringify(region)})`);
  await checkCue(page, `planner-auth ${label}`, 'the first-screen row dot',
    { selector: '.planner-auth-row .planner-auth-dot', prop: 'backgroundColor' }, '.empty-state');

  check(await page.locator('.planner-pill.active[title="Not logged in — sign in from this chat"]').count() === 1,
    `planner-auth ${label}: the active pill's title says why`);
  for (const runner of ['claude-code', 'codex']) {
    const dot = await loginBox(page, `${row(runner)} .planner-auth-dot`);
    const sentence = await loginBox(page, `${row(runner)} .planner-auth-warning-text`);
    check(dot?.width === 6 && dot?.height === 6, `planner-auth ${label}: ${runner}'s row dot is 6×6 (got ${dot?.width}×${dot?.height})`);
    check(!!dot && !!sentence && dot.x + dot.width <= sentence.x
      && dot.y + dot.height / 2 >= sentence.y && dot.y + dot.height / 2 <= sentence.y + sentence.height,
    `planner-auth ${label}: ${runner}'s row dot sits before its sentence, on its first line`);

    const pillDot = await loginBox(page, `.planner-pill-item[data-runner="${runner}"] .planner-auth-dot`);
    const pillLabel = await firstTextRect(page, `.planner-pill-item[data-runner="${runner}"] .planner-pill`);
    check(pillDot?.width === 6 && pillDot?.height === 6, `planner-auth ${label}: ${runner}'s planner dot is 6×6`);
    check(!!pillDot && !!pillLabel && pillDot.x + pillDot.width <= pillLabel.x
      && pillDot.y + pillDot.height / 2 >= pillLabel.top && pillDot.y + pillDot.height / 2 <= pillLabel.bottom,
    `planner-auth ${label}: ${runner}'s planner dot leads its label on the first line`);

    const runnerDot = await loginBox(page, `.runner-pill-item[data-runner="${runner}"] .runner-dot`);
    const runnerLabel = await firstTextRect(page, `.runner-pill-item[data-runner="${runner}"] .runner-pill`);
    check(runnerDot?.width === 6 && runnerDot?.height === 6, `planner-auth ${label}: ${runner}'s runner dot is 6×6`);
    check(!!runnerDot && !!runnerLabel && runnerDot.x + runnerDot.width <= runnerLabel.x
      && runnerDot.y + runnerDot.height / 2 >= runnerLabel.top && runnerDot.y + runnerDot.height / 2 <= runnerLabel.bottom,
    `planner-auth ${label}: ${runner}'s runner dot leads its label on the first line`);
  }

  const ringOf = (locator) => locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { visible: el.matches(':focus-visible'), width: s.outlineWidth, style: s.outlineStyle, offset: s.outlineOffset };
  });

  await page.locator('.planner-pill').first().evaluate((el) => el.focus({ focusVisible: true }));
  const pillFocus = await ringOf(page.locator('.planner-pill').first());
  check(pillFocus.visible && pillFocus.width === '2px' && pillFocus.style === 'solid' && pillFocus.offset === '-2px',
    `planner-auth ${label}: the planner name has an inset focus ring (${JSON.stringify(pillFocus)})`);
  await checkCue(page, `planner-auth ${label}`, 'the planner focus ring', { selector: '.planner-pill', prop: 'outlineColor' }, '.empty-state');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  await plannerLogin('claude-code').evaluate((el) => el.focus({ focusVisible: true }));
  const menuRing = await ringOf(plannerLogin('claude-code'));
  check(menuRing.visible && menuRing.width === '2px' && menuRing.style === 'solid' && menuRing.offset === '-2px',
    `planner-auth ${label}: the menu login has its own inset focus ring (${JSON.stringify(menuRing)})`);
  await checkCue(page, `planner-auth ${label}`, 'the login focus ring', { selector: '.planner-pill-login', prop: 'outlineColor' }, '.empty-state');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  await page.locator('.runner-pill').first().evaluate((el) => el.focus({ focusVisible: true }));
  const runnerRing = await ringOf(page.locator('.runner-pill').first());
  check(runnerRing.visible && runnerRing.width === '2px' && runnerRing.style === 'solid' && runnerRing.offset === '-2px',
    `planner-auth ${label}: a runner name has the same inset focus ring (${JSON.stringify(runnerRing)})`);
  await checkCue(page, `planner-auth ${label}`, 'the runner focus ring', { selector: '.runner-pill', prop: 'outlineColor' }, '.empty-state');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  // The same control in two places: the row's action and the menu segment
  // share colour, weight and fill; only their sizes differ.
  const rowLook = await loginLook(page, `${row('claude-code')} .planner-login-btn`);
  const menuLook = await loginLook(page, '.planner-pill-item[data-runner="claude-code"] .planner-pill-login');
  check(rowLook.colour === menuLook.colour && rowLook.weight === menuLook.weight && rowLook.fill === menuLook.fill,
    `planner-auth ${label}: the row action and the menu segment are recognisably one login (${JSON.stringify({ rowLook, menuLook })})`);

  // Right-aligned on the row's edge, its text on the sentence's baseline.
  const rowsBox = await loginBox(page, '.planner-auth-rows');
  const rowButtonBox = await loginBox(page, `${row('claude-code')} .planner-login-btn`);
  check(!!rowsBox && !!rowButtonBox
    && Math.abs((rowButtonBox.x + rowButtonBox.width) - (rowsBox.x + rowsBox.width)) <= 0.5,
  `planner-auth ${label}: the row action is right-aligned to the row`);
  const rowBaseline = await page.evaluate((sel) => {
    const rowEl = document.querySelector(sel);
    const firstRect = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()][0] ?? null;
    };
    const sentence = firstRect(rowEl.querySelector('.planner-auth-warning-text'));
    const action = firstRect(rowEl.querySelector('.planner-login-state'));
    return sentence && action ? { sentence: sentence.bottom, action: action.bottom } : null;
  }, row('claude-code'));
  check(!!rowBaseline && Math.abs(rowBaseline.sentence - rowBaseline.action) <= 2,
    `planner-auth ${label}: the action sits on the sentence's baseline (${JSON.stringify(rowBaseline)})`);

  const rowStyle = await page.locator(row('claude-code')).evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, borderColour: s.borderTopColor, background: s.backgroundColor };
  });
  check(rowStyle.border === '0px' && rowStyle.background === 'rgba(0, 0, 0, 0)',
    `planner-auth ${label}: the row is a line, not a tinted banner (${rowStyle.border} ${rowStyle.borderColour}, ${rowStyle.background})`);
  await checkContrast(page, `planner-auth ${label}`, ['.planner-auth-warning-text', '.planner-login-btn']);
  await page.screenshot({ path: path.join(OUT, `planner-auth-empty-${width}-${theme}.png`) });

  const resting = await loginBox(page, `${row('claude-code')} .planner-login-btn`);
  const restingRow = await loginBox(page, row('claude-code'));
  const restingLogo = await loginBox(page, '.empty-state-logo');
  const restingMenu = await segmented(page,
    '.planner-pill-item[data-runner="claude-code"] .planner-pill-group', '.planner-pill', '.planner-pill-login');
  const restingRunnerCapsule = await segmented(page,
    '.runner-pill-item[data-runner="claude-code"] .runner-pill-group', '.runner-pill', '.runner-pill-login');
  check(await page.locator(`${row('claude-code')} .planner-login-btn`).isEnabled(), `planner-auth ${label}: Log in starts enabled`);
  check(await page.locator(`${row('claude-code')} .planner-login-btn`).getAttribute('aria-busy') === null, `planner-auth ${label}: not busy before a login`);
  check(await page.locator(`${row('claude-code')} .planner-login-btn`).getAttribute('aria-label') === 'Log in to Claude Code',
    `planner-auth ${label}: the action names the agent without losing its visible "Log in"`);

  await page.locator(`${row('claude-code')} .planner-login-btn`).evaluate((el) => el.focus({ focusVisible: true }));
  const ring = await page.locator(`${row('claude-code')} .planner-login-btn`).evaluate((el) => {
    const s = getComputedStyle(el);
    return { visible: el.matches(':focus-visible'), width: s.outlineWidth, style: s.outlineStyle, offset: s.outlineOffset };
  });
  check(ring.visible && ring.width === '2px' && ring.style === 'solid' && ring.offset === '2px',
    `planner-auth ${label}: Log in has a 2px focus ring (${JSON.stringify(ring)})`);

  await page.locator(`${row('claude-code')} .planner-login-btn`).click();
  await page.waitForFunction(() => document.querySelector('.planner-auth-row[data-runner="claude-code"] .planner-login-btn')?.getAttribute('aria-busy') === 'true');
  const claudeLogin = page.locator(`${row('claude-code')} .planner-login-btn`);
  check(await claudeLogin.isDisabled(), `planner-auth ${label}: Log in is disabled while signing in`);
  check((await claudeLogin.innerText()).includes('Signing in…'), `planner-auth ${label}: the pending label uses the ellipsis character`);
  check(await claudeLogin.getAttribute('aria-label') === 'Signing in to Claude Code',
    `planner-auth ${label}: the pending action says whose login it is`);
  check(await page.locator(`${row('claude-code')} .planner-login-spinner`).count() === 1, `planner-auth ${label}: a small spinner accompanies the label`);
  check(await page.locator(`${row('claude-code')} .planner-login-spinner`).evaluate((el) => getComputedStyle(el).animationName) === 'planner-login-spin',
    `planner-auth ${label}: the spinner is the only motion`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check(await page.locator(`${row('claude-code')} .planner-login-spinner`).evaluate((el) => getComputedStyle(el).animationName) === 'none',
    `planner-auth ${label}: reduced motion stops the spinner`);
  check((await plannerLogin('claude-code').innerText()).includes('Signing in…'),
    `planner-auth ${label}: reduced motion leaves the capsule's pending words visible (${JSON.stringify(await plannerLogin('claude-code').innerText())})`);
  const paused = await page.evaluate(() => {
    const durations = (sel) => getComputedStyle(document.querySelector(sel)).transitionDuration.split(',').map((d) => d.trim());
    return { group: durations('.planner-pill-group.signed-out'), login: durations('.planner-pill-login') };
  });
  check(paused.group.every((d) => d === '0s') && paused.login.every((d) => d === '0s'),
    `planner-auth ${label}: reduced motion stills the capsule's own transitions (${JSON.stringify(paused)})`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The same pending state is visible on that agent's menu login and nowhere else.
  check(await plannerLogin('claude-code').isDisabled() && await plannerLogin('claude-code').getAttribute('aria-busy') === 'true',
    `planner-auth ${label}: the menu login waits with the row`);
  check(await plannerLogin('codex').isEnabled(), `planner-auth ${label}: another agent's menu login stays usable`);
  check(await page.locator(`${row('codex')} .planner-login-btn`).isEnabled(), `planner-auth ${label}: another agent's row login stays usable`);
  const pending = await loginBox(page, `${row('claude-code')} .planner-login-btn`);
  const pendingRow = await loginBox(page, row('claude-code'));
  check(pendingRow?.height === restingRow?.height, `planner-auth ${label}: the row does not grow between default and pending (${restingRow?.height} → ${pendingRow?.height})`);
  check(pending?.width === resting?.width && pending?.x === resting?.x && pending?.y === resting?.y,
    `planner-auth ${label}: the action keeps its slot while pending`);
  const pendingMenu = await segmented(page,
    '.planner-pill-item[data-runner="claude-code"] .planner-pill-group', '.planner-pill', '.planner-pill-login');
  const pendingRunnerCapsule = await segmented(page,
    '.runner-pill-item[data-runner="claude-code"] .runner-pill-group', '.runner-pill', '.runner-pill-login');
  const sameCapsule = (beforeCapsule, afterCapsule) => !!beforeCapsule?.name && !!afterCapsule?.name
    && ['group', 'name', 'login'].every((part) => afterCapsule[part]
      && ['x', 'y', 'w', 'h'].every((k) => Math.abs(afterCapsule[part][k] - beforeCapsule[part][k]) <= 0.5));
  check(sameCapsule(restingMenu, pendingMenu),
    `planner-auth ${label}: the menu capsule keeps its width through pending (${restingMenu?.group?.w} → ${pendingMenu?.group?.w})`);
  check(sameCapsule(restingRunnerCapsule, pendingRunnerCapsule),
    `planner-auth ${label}: the runner capsule keeps its width through pending (${restingRunnerCapsule?.group?.w} → ${pendingRunnerCapsule?.group?.w})`);
  check((await plannerLogin('claude-code').innerText()).trim() === '',
    `planner-auth ${label}: the pending menu segment is spinner-only, not the wider pending words (${JSON.stringify(await plannerLogin('claude-code').innerText())})`);
  check(await page.locator('.planner-pill-item[data-runner="claude-code"] .planner-login-pending-label')
    .evaluate((el) => getComputedStyle(el).display) === 'none',
  `planner-auth ${label}: the capsule hides its pending words while the row keeps them`);
  check(await plannerLogin('claude-code').getAttribute('title') === 'Signing in to Claude Code',
    `planner-auth ${label}: the spinner-only segment names its agent in the title`);
  check(await page.locator('.planner-pill-item[data-runner="claude-code"] .planner-pill-login .planner-login-spinner').count() === 1,
    `planner-auth ${label}: the pending menu segment carries the one spinner`);
  await checkContrast(page, `planner-auth ${label}`, ['.planner-auth-warning-text', '.planner-login-btn']);
  await page.screenshot({ path: path.join(OUT, `planner-auth-pending-${width}-${theme}.png`) });

  await send(page, { type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The terminal closed before sign-in finished.' });
  await page.waitForSelector(`${row('claude-code')} .planner-auth-failure`);
  check(await page.locator(`${row('claude-code')} .planner-auth-failure`).innerText() === 'The terminal closed before sign-in finished.', `planner-auth ${label}: a failure explains the result in one sentence`);
  check(await page.locator(`${row('claude-code')} .planner-auth-warning-text`).count() === 0, `planner-auth ${label}: the result takes that row's sentence line rather than adding one`);
  check(await page.locator(`${row('codex')} .planner-auth-warning-text`).count() === 1, `planner-auth ${label}: the other agent's row is untouched`);
  check(await claudeLogin.isEnabled() && await claudeLogin.getAttribute('aria-busy') === null,
    `planner-auth ${label}: the row offers the retry once a login ends`);
  check((await claudeLogin.innerText()) === 'Log in', `planner-auth ${label}: the retry says "Log in"`);
  const plannerFailure = page.locator('.planner-pill-item[data-runner="claude-code"] .planner-pill-login-failure');
  check(await plannerFailure.count() === 1 && await plannerFailure.innerText() === 'The terminal closed before sign-in finished.',
    `planner-auth ${label}: the agent's menu login repeats the same failure under its own pill`);
  check(await page.locator('.runner-pill-item[data-runner="claude-code"] .planner-pill-login-failure').innerText() === 'The terminal closed before sign-in finished.',
    `planner-auth ${label}: the runner's login keeps the same failure under that runner`);
  const failed = await loginBox(page, `${row('claude-code')} .planner-login-btn`);
  const failedRow = await loginBox(page, row('claude-code'));
  const failedLogo = await loginBox(page, '.empty-state-logo');
  check(failed?.width === resting?.width && failed?.x === resting?.x && failed?.y === resting?.y,
    `planner-auth ${label}: a failure does not move the action`);
  check(failedRow?.height === restingRow?.height && failedLogo?.y === restingLogo?.y,
    `planner-auth ${label}: a failure does not move the empty state (${restingRow?.height} → ${failedRow?.height})`);
  const failedMenu = await segmented(page,
    '.planner-pill-item[data-runner="claude-code"] .planner-pill-group', '.planner-pill', '.planner-pill-login');
  const failedRunnerCapsule = await segmented(page,
    '.runner-pill-item[data-runner="claude-code"] .runner-pill-group', '.runner-pill', '.runner-pill-login');
  const sameBox = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= 0.5);
  check(sameBox(failedMenu?.group, restingMenu?.group),
    `planner-auth ${label}: the failure's reserved line keeps the menu capsule still`);
  check(sameBox(failedRunnerCapsule?.group, restingRunnerCapsule?.group),
    `planner-auth ${label}: the failure's reserved line keeps the runner capsule still`);
  await checkContrast(page, `planner-auth ${label}`, ['.planner-auth-failure']);
  await page.screenshot({ path: path.join(OUT, `planner-auth-failure-${width}-${theme}.png`) });

  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  check(overflow.scroll <= overflow.client, `planner-auth ${label}: the narrow layout has no horizontal overflow (${overflow.scroll} ≤ ${overflow.client})`);

  await send(page, SIGNED_OUT_PLANNERS.signedIn);
  await page.waitForSelector('.planner-auth-rows', { state: 'detached' });
  check(await page.locator('.planner-pill.signed-out').count() === 0, `planner-auth ${label}: signing in redraws both pills without the flag`);
  check(await page.locator('.planner-backends .planner-pill-login').count() === 0, `planner-auth ${label}: the menu logins leave with the flags`);

  // The same login on a pill: the first screen is gone, and every signed-out
  // agent keeps its own login in the menu. Clear the earlier failure first: the
  // pill section measures the action's own reflow, not a line disappearing from
  // a neighbour.
  await send(page, SIGNED_OUT_PLANNERS.signedOut);
  await send(page, { type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
  await send(page, { type: 'plannerTurn', active: true });
  await page.waitForSelector('.empty-state', { state: 'detached' });
  await settle(page);
  check(await page.locator('.planner-auth-rows').count() === 0, `planner-auth ${label}: the first screen's rows are gone`);
  check(await page.locator('.planner-backends .planner-pill-login').count() === 2, `planner-auth ${label}: each signed-out pill keeps its own login in the menu`);
  check(await page.locator('.runner-pill-login').count() === 2,
    `planner-auth ${label}: each signed-out runner keeps its own login in the menu after the first screen`);
  check(await page.locator('.planner-login-btn').count() === 0,
    `planner-auth ${label}: the row's action is the only thing that left with the first screen`);
  check(await plannerLogin('claude-code').evaluate((el) => getComputedStyle(el).backgroundColor) === loginTint,
    `planner-auth ${label}: the menu login keeps the one fill with the first screen gone`);
  await page.evaluate(() => window.__posted.length = 0);
  const codexLogin = plannerLogin('codex');
  const pillLogin = await codexLogin.boundingBox();
  check(await codexLogin.getAttribute('aria-label') === 'Log in to Codex', `planner-auth ${label}: a pill's login names its agent`);
  await codexLogin.evaluate((el) => el.focus({ focusVisible: true }));
  const pillRing = await ringOf(codexLogin);
  check(pillRing.visible && pillRing.width === '2px' && pillRing.style === 'solid' && pillRing.offset === '-2px',
    `planner-auth ${label}: a pill's login has the same inset focus ring (${JSON.stringify(pillRing)})`);
  await codexLogin.click();
  await page.waitForFunction(() => document.querySelector('.planner-backends .planner-pill-login[aria-label="Signing in to Codex"]')?.getAttribute('aria-busy') === 'true');
  const pillPending = await codexLogin.boundingBox();
  check(await codexLogin.isDisabled(), `planner-auth ${label}: only the clicked pill's login waits`);
  check(await codexLogin.getAttribute('aria-label') === 'Signing in to Codex', `planner-auth ${label}: the pending pill action names its agent`);
  check(await plannerLogin('claude-code').isEnabled(), `planner-auth ${label}: the other pill's login stays usable`);
  check(pillPending?.width === pillLogin?.width && pillPending?.height === pillLogin?.height && pillPending?.x === pillLogin?.x,
    `planner-auth ${label}: the pill action keeps its slot while pending (${pillLogin?.width}×${pillLogin?.height} → ${pillPending?.width}×${pillPending?.height})`);
  const posted = await page.evaluate(() => window.__posted.map((m) => m.type));
  check(posted.includes('loginPlanner') && !posted.includes('setPlanner'), `planner-auth ${label}: a pill login does not switch the planner (${posted.join(',')})`);
  await page.screenshot({ path: path.join(OUT, `planner-auth-pill-${width}-${theme}.png`) });

  await send(page, { type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'Sign-in did not finish in time.' });
  const codexFailure = page.locator('.planner-pill-item[data-runner="codex"] .planner-pill-login-failure');
  await codexFailure.waitFor();
  check(await codexFailure.innerText() === 'Sign-in did not finish in time.', `planner-auth ${label}: a pill's failure stays under that agent`);
  check(await page.locator('.planner-pill-item[data-runner="claude-code"] .planner-pill-login-failure').count() === 0,
    `planner-auth ${label}: another agent's pill does not take that failure`);
  check(await plannerLogin('codex').isEnabled(), `planner-auth ${label}: the failed pill action is a retry, not a dead end`);
  await checkContrast(page, `planner-auth ${label}`, ['.planner-pill-login', '.planner-pill-login-failure']);
  await page.screenshot({ path: path.join(OUT, `planner-auth-pill-failure-${width}-${theme}.png`) });

  await page.close();
}

/**
 * The first screen before a word is typed: the hero, the autorun note and the
 * repositories card, at the width a sidebar gives them and at a full-width
 * window, in both themes. The card is the one block there with a surface of its
 * own, so it is checked for one; `/settings` for being a command token rather
 * than prose; and the column for holding its edge with long paths in it.
 */
async function firstScreen(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/?theme=${theme}`);
  await page.waitForSelector('.chat-container');
  await sendAll(page, FIRST_SCREEN.map((s) => s.post));
  await page.waitForSelector('.isolation-notice[data-status="ready"]');
  await settle(page);

  // The list follows a log's newest line; the first screen's hero is at its top.
  const opening = await page.evaluate(() => {
    const list = document.querySelector('.message-list');
    const logo = document.querySelector('.empty-state-logo').getBoundingClientRect();
    return { scrollTop: list.scrollTop, logoTop: logo.top, logoBottom: logo.bottom, listTop: list.getBoundingClientRect().top, listHeight: list.clientHeight };
  });
  check(opening.scrollTop === 0 && opening.logoTop >= opening.listTop && opening.logoBottom <= opening.listTop + opening.listHeight,
    `first-screen ${label}: the column opens at its wordmark, not at its bottom (scrollTop ${opening.scrollTop}, logo ${opening.logoTop} in ${opening.listTop}–${opening.listTop + opening.listHeight})`);

  const paint = (sel) => page.locator(sel).evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { fill: s.backgroundColor, border: s.borderTopWidth, radius: s.borderTopLeftRadius, w: r.width, h: r.height };
  });
  const pageFill = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const card = await paint('.isolation-notice');
  const cardSurface = await paintRatio(page, { selector: '.isolation-notice', prop: 'backgroundColor' }, '.empty-state');
  const cardEdge = await paintRatio(page, { selector: '.isolation-notice', prop: 'borderTopColor' }, '.empty-state');
  console.log(`    card ${card.fill} on page ${pageFill} · surface ${cardSurface?.ratio.toFixed(2)}:1 · edge ${cardEdge?.ratio.toFixed(2)}:1 · ${card.w}×${card.h}`);
  // A card is a surface, not a control: its fill has to be a step off the page
  // (or, in high contrast, which draws no tints, its edge a full boundary).
  check((cardSurface?.ratio ?? 0) >= 1.08 || (cardEdge?.ratio ?? 0) >= 3,
    `first-screen ${label}: the card reads as a surface off the page (fill ${cardSurface?.ratio.toFixed(2)}:1, edge ${cardEdge?.ratio.toFixed(2)}:1)`);
  check(card.border === '1px' && card.radius === '12px',
    `first-screen ${label}: the card has a 1px border and a 12px radius (${card.border}, ${card.radius})`);

  // One column: the card shares the setup rows' edge, and every row in it starts there.
  const column = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.isolation-repo')];
    const card = document.querySelector('.isolation-notice');
    return {
      card: { x: box(card).x, w: box(card).width, right: box(card).right },
      setup: { x: box(document.querySelector('.empty-state-setup')).x, w: box(document.querySelector('.empty-state-setup')).width },
      rows: rows.map((el) => box(el).x),
      parts: [...document.querySelectorAll('.isolation-repo-name, .isolation-repo-head, .isolation-repo-commit, .isolation-repo-flag')]
        .map((el) => ({ left: box(el).left, right: box(el).right })),
    };
  });
  check(Math.abs(column.card.x - column.setup.x) <= 0.5 && Math.abs(column.card.w - column.setup.w) <= 0.5,
    `first-screen ${label}: the card shares the setup column's edge and width (${column.card.x}/${column.card.w} vs ${column.setup.x}/${column.setup.w})`);
  check(column.rows.length > 0 && column.rows.every((x) => Math.abs(x - column.rows[0]) <= 0.5),
    `first-screen ${label}: every repo row starts on one left edge (${column.rows.join(', ')})`);
  const inside = column.card.right - 15; // the card's 1px border and 14px padding
  check(column.parts.length > 0 && column.parts.every((p) => p.left >= column.card.x + 14 - 0.5 && p.right <= inside + 0.5),
    `first-screen ${label}: every repo part stays inside the card's padding (${column.parts.map((p) => `${p.left}→${p.right}`).join(', ')} in ${column.card.x}→${inside})`);

  const hero = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const style = (sel) => getComputedStyle(document.querySelector(sel));
    const lead = style('.empty-state-lead');
    const support = style('.empty-state-support');
    return {
      width: box('.empty-state-hero').width,
      lead: { size: parseFloat(lead.fontSize), line: parseFloat(lead.lineHeight) / parseFloat(lead.fontSize), width: box('.empty-state-lead').width },
      support: { size: parseFloat(support.fontSize), width: box('.empty-state-support').width },
      h2: parseFloat(style('.empty-state h2').fontSize),
    };
  });
  check(hero.width <= 380.5 && hero.lead.width <= 380.5 && hero.support.width <= 380.5,
    `first-screen ${label}: the hero is held to the column (${hero.width}, ${hero.lead.width}, ${hero.support.width})`);
  check(Math.abs(hero.lead.line - 1.5) < 0.02,
    `first-screen ${label}: the lead line sets a 1.5 line-height (${hero.lead.line.toFixed(2)})`);
  check(hero.h2 === 18 && hero.lead.size === 13 && hero.support.size === 13,
    `first-screen ${label}: the question is 18px over 13px copy (${hero.h2}, ${hero.lead.size}, ${hero.support.size})`);

  const sizes = await page.evaluate(() => [...new Set([...document.querySelectorAll(
    '.empty-state h2, .empty-state p, .empty-state span, .empty-state code, .empty-state button, .empty-state li',
  )].map((el) => getComputedStyle(el).fontSize))].sort());
  check(JSON.stringify(sizes) === JSON.stringify(['12px', '13px', '18px']),
    `first-screen ${label}: the screen uses three type sizes (${sizes.join(', ')})`);

  const token = await page.evaluate(() => {
    const note = getComputedStyle(document.querySelector('.plan-approval-note .command-token'));
    const setup = getComputedStyle(document.querySelector('.empty-state-setup .command-token'));
    return {
      text: document.querySelector('.plan-approval-note .command-token').textContent,
      fill: note.backgroundColor, font: note.fontFamily, radius: note.borderRadius,
      setupFill: setup.backgroundColor, setupFont: setup.fontFamily,
    };
  });
  check(token.text === '/settings' && solid(token.fill) && token.fill === token.setupFill,
    `first-screen ${label}: /settings is a command token, filled like the setup rows' (${token.text} ${token.fill})`);
  check(/mono|Menlo|Monaco|Courier/i.test(token.font) && token.font === token.setupFont && token.radius !== '0px',
    `first-screen ${label}: the token is set in the mono face with a radius (${token.font}, ${token.radius})`);

  const note = await page.locator('.plan-approval-note').evaluate((el) => {
    const s = getComputedStyle(el);
    return { autorun: el.dataset.autorun, rule: s.borderLeftWidth, colour: s.borderLeftColor, text: el.querySelector('.plan-approval-text').textContent };
  });
  const warning = await resolvedColour(page, 'var(--vscode-editorWarning-foreground)');
  check(note.autorun === 'on' && note.rule === '2px' && note.colour === warning,
    `first-screen ${label}: autorun's note carries a 2px warning rule (${note.rule} ${note.colour})`);
  check(note.text.includes('Autorun is on') && note.text.includes('/settings.'),
    `first-screen ${label}: the note keeps core's sentence (${JSON.stringify(note.text)})`);
  await checkCue(page, `first-screen ${label}`, 'the autorun rule', { selector: '.plan-approval-note', prop: 'borderLeftColor' }, '.empty-state');

  await checkContrast(page, `first-screen ${label}`, [
    '.empty-state h2', '.empty-state-lead', '.empty-state-support', '.plan-approval-text', '.command-token',
    '.empty-state-setup-label', '.empty-state-setup .warn',
    '.isolation-notice-title', '.isolation-notice-summary', '.isolation-repo-name',
    '.isolation-repo-head', '.isolation-repo-commit', '.isolation-notice-shared', '.isolation-notice-note',
  ]);
  // The muted caption and footer are small text on the card's own tint, not on
  // the page: measure them against the surface they sit on rather than assume.
  await checkSurface(page, `first-screen ${label}`, 'the card hairline', { selector: '.isolation-notice', prop: 'borderTopColor' }, '.empty-state', 1.1);
  await checkSurface(page, `first-screen ${label}`, 'the card footer hairline', { selector: '.isolation-notice-footer', prop: 'borderTopColor' }, '.isolation-notice', 1.1);
  // The whole column, for the picture: a sidebar taller than the first screen.
  await page.setViewportSize({ width, height: 1200 });
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `first-screen-${width}-${theme}.png`) });

  // The other state of the same row: no warning colour, and nothing to type.
  await send(page, FIRST_SCREEN_AUTORUN_OFF.post);
  await page.waitForFunction(() => document.querySelector('.plan-approval-note')?.dataset.autorun === 'off');
  const quiet = await page.locator('.plan-approval-note').evaluate((el) => ({
    rule: getComputedStyle(el).borderLeftColor,
    token: el.querySelector('.command-token')?.textContent ?? null,
    text: el.textContent,
  }));
  check(quiet.rule !== warning && quiet.token === null && quiet.text.includes('Nothing runs until you approve the plan.'),
    `first-screen ${label}: with autorun off the same row is quiet and promises approval (${quiet.rule}, ${JSON.stringify(quiet.text)})`);
  await checkSurface(page, `first-screen ${label}`, 'the quiet note’s rule', { selector: '.plan-approval-note', prop: 'borderLeftColor' }, '.empty-state', 1.1);
  await checkContrast(page, `first-screen ${label}`, ['.plan-approval-note[data-autorun="off"] .plan-approval-text']);

  // Long paths and branches are the case that clips a card at 420px.
  await send(page, FIRST_SCREEN_LONG_PATHS.post);
  await page.waitForSelector('.isolation-notice[data-status="dirty"]');
  const wrapped = await page.evaluate(() => {
    const card = document.querySelector('.isolation-notice').getBoundingClientRect();
    const parts = [...document.querySelectorAll('.isolation-repo-name, .isolation-repo-head, .isolation-repo-commit')];
    return {
      ok: parts.length > 0 && parts.every((el) => el.getBoundingClientRect().left >= card.left + 14 - 0.5
        && el.getBoundingClientRect().right <= card.right - 15 + 0.5),
      names: [...document.querySelectorAll('.isolation-repo-name')].map((el) => getComputedStyle(el).fontFamily),
    };
  });
  check(wrapped.ok, `first-screen ${label}: long paths and branches wrap inside the card`);
  check(wrapped.names.length > 0 && wrapped.names.every((f) => /mono|Menlo|Monaco|Courier/i.test(f)),
    `first-screen ${label}: a group's repository paths are set in mono (${wrapped.names.join(' | ')})`);
  await checkContrast(page, `first-screen ${label}`, [
    '.isolation-notice[data-status="dirty"] .isolation-notice-summary', '.isolation-repo-flag',
  ]);
  await checkSurface(page, `first-screen ${label}`, 'the card row separator', { selector: '.isolation-repo + .isolation-repo', prop: 'borderTopColor' }, '.isolation-notice', 1.1);

  const overflow = await page.evaluate(() => {
    const card = document.querySelector('.isolation-notice');
    const empty = document.querySelector('.empty-state');
    return {
      page: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      cardRight: card.getBoundingClientRect().right, viewport: window.innerWidth,
      cardScroll: card.scrollWidth, cardClient: card.clientWidth,
      emptyScroll: empty.scrollWidth, emptyClient: empty.clientWidth,
    };
  });
  check(overflow.page <= overflow.client && overflow.cardRight <= overflow.viewport
    && overflow.cardScroll <= overflow.cardClient + 1 && overflow.emptyScroll <= overflow.emptyClient + 1,
  `first-screen ${label}: nothing overflows sideways, long paths included (page ${overflow.page}/${overflow.client}, card ${overflow.cardScroll}/${overflow.cardClient} at ${overflow.cardRight} of ${overflow.viewport})`);

  await page.close();
}

/**
 * The Settings panel's Run rows: each one segmented control, one border, its
 * dividers between options, and radii that depend only on an option's place.
 */
async function runSettingsSegments(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/?theme=${theme}`);
  await page.waitForSelector('.chat-container');
  await send(page, {
    type: 'setRunSettings',
    autonomous: true,
    run: { supervisorLevel: 'watch', mergeAtGatesAutomatically: false, plannedWithTrailer: true, autorun: false, supervisorRetryLimit: 2, wakeUpReadBudget: 12 },
    maxParallel: 5,
  });
  await page.waitForSelector('.run-settings');
  await page.locator('.run-settings-toggle').click();
  await page.waitForSelector('.run-setting-pills');
  await settle(page);

  const rows = await page.locator('.run-setting').evaluateAll((els) => els.map((el) => {
    const group = el.querySelector('.run-setting-pills');
    if (!group) return null;
    const style = getComputedStyle(group);
    return {
      label: group.getAttribute('aria-label'),
      role: group.getAttribute('role'),
      border: style.borderTopWidth,
      buttons: [...group.querySelectorAll('button')].map((b) => {
        const s = getComputedStyle(b);
        return {
          label: b.textContent,
          pressed: b.getAttribute('aria-pressed'),
          fill: s.backgroundColor,
          topLeft: s.borderTopLeftRadius,
          topRight: s.borderTopRightRadius,
          topBorder: s.borderTopWidth,
        };
      }),
    };
  }));
  const runRows = rows.filter(Boolean);
  const full = '9999px';
  for (const row of runRows) {
    const last = row.buttons.length - 1;
    const expectedRadii = row.buttons.map((_, i) => [i === 0 ? full : '0px', i === last ? full : '0px']);
    check(row.role === 'group' && !!row.label && row.border === '1px',
      `run-settings ${label}: ${row.label} is one bordered group (${row.role} ${row.border})`);
    check(JSON.stringify(row.buttons.map((b) => [b.topLeft, b.topRight])) === JSON.stringify(expectedRadii),
      `run-settings ${label}: ${row.label} rounds only its ends (${row.buttons.map((b) => `${b.topLeft}/${b.topRight}`).join(' ')})`);
    check(row.buttons.every((b) => b.topBorder === '0px'),
      `run-settings ${label}: ${row.label} options own no border of their own`);
    const selected = row.buttons.filter((b) => b.pressed === 'true');
    check(selected.length === 1 && solid(selected[0].fill),
      `run-settings ${label}: ${row.label} fills its selected option (${selected.map((b) => b.label).join(', ')} ${selected[0]?.fill})`);
  }
  const supervisor = runRows.find((r) => r.label === 'Supervisor');
  const watchIndex = supervisor?.buttons.findIndex((b) => b.label === 'Watch') ?? -1;
  check(watchIndex > 0 && watchIndex < (supervisor?.buttons.length ?? 0) - 1
    && supervisor.buttons[watchIndex].topLeft === '0px' && supervisor.buttons[watchIndex].topRight === '0px',
  `run-settings ${label}: Watch is a middle segment, square on both sides (${supervisor?.buttons[watchIndex]?.topLeft}/${supervisor?.buttons[watchIndex]?.topRight})`);
  const offRows = runRows.filter((r) => r.label === 'Automerge' || r.label === 'Autorun');
  check(offRows.length === 2 && offRows.every((r) => r.buttons.at(-1).topLeft === '0px' && r.buttons.at(-1).topRight === full),
    `run-settings ${label}: each On/Off row rounds Off on its right end`);

  // The selected option is the state cue, so its fill has to stand off the
  // group it sits in; its label is then read against that fill and reported.
  await checkCue(page, `run-settings ${label}`, 'the selected segment',
    { selector: '.run-setting-pills > .planner-pill[aria-pressed="true"]', prop: 'backgroundColor' },
    '.run-setting-pills');
  const selectedLabel = await paintRatio(page,
    { selector: '.run-setting-pills > .planner-pill[aria-pressed="true"]', prop: 'color' },
    '.run-setting-pills > .planner-pill[aria-pressed="true"]');
  if (selectedLabel) {
    console.log(`    selected label ${selectedLabel.fg} on ${selectedLabel.bg} · ${selectedLabel.ratio.toFixed(2)}:1`);
    check(selectedLabel.ratio >= 4.5,
      `run-settings ${label}: the selected segment's label clears AA (${selectedLabel.fg} on ${selectedLabel.bg} · ${selectedLabel.ratio.toFixed(2)}:1)`);
  }

  // A selected segment is filled with the accent, so its focus ring must not
  // be the same colour as that fill.
  const selectedRing = await page.locator('.run-setting-pills > .planner-pill.active').first().evaluate((el) => {
    el.focus({ focusVisible: true });
    const s = getComputedStyle(el);
    return { outline: s.outlineColor, fill: s.backgroundColor, width: s.outlineWidth, visible: el.matches(':focus-visible') };
  });
  check(selectedRing.visible && parseFloat(selectedRing.width) >= 2 && selectedRing.outline !== selectedRing.fill,
    `run-settings ${label}: the selected segment's focus ring stands off its fill (${selectedRing.outline} on ${selectedRing.fill})`);

  await page.screenshot({ path: path.join(OUT, `run-settings-${width}-${theme}.png`) });
  await page.close();
}

const COMBOS = [
  { width: 420, theme: 'dark', primary: true },
  { width: 900, theme: 'dark' },
  { width: 420, theme: 'light' },
  { width: 900, theme: 'light' },
];
/** Cards are where the derived surfaces show, so they also meet the older defaults and both high-contrast themes. */
const CARD_COMBOS = [...COMBOS, { width: 420, theme: 'dark-plus' }, { width: 420, theme: 'light-plus' },
  { width: 420, theme: 'high-contrast' }, { width: 420, theme: 'high-contrast-light' }];
const PLANNER_AUTH_COMBOS = [...COMBOS, { width: 420, theme: 'high-contrast' }, { width: 420, theme: 'high-contrast-light' }];
/** The first screen also gets the light high-contrast theme both widths: its white page is where the light tokens have to hold. */
const FIRST_SCREEN_COMBOS = [...COMBOS, { width: 420, theme: 'high-contrast-light' }, { width: 900, theme: 'high-contrast-light' }];
const REPRESENTATIVE = new Set(['plan-marker', 'approval-pending', 'usage-line', 'subagent-collapsed']);
const CONTRAST_SELECTORS = ['.chat-msg-content', '.cmd-row-head', '.usage-line-measures', '.approval-card-subject', '.plan-revision-chip', '.activity-group-summary'];

for (const combo of runs('tour') ? COMBOS : []) {
  console.log(`\n== ${combo.width}px, ${combo.theme} theme ${combo.primary ? '(primary)' : ''} ==`);
  const page = await browser.newPage({ viewport: { width: combo.width, height: 1400 } });
  const driver = createDriver();
  await page.goto(`${BASE}/?theme=${combo.theme}`);
  await page.exposeFunction('__toHost', async (msg) => {
    if (!driver.reply(msg)) return;
    driver.host.flush();
    await sendAll(page, driver.take());
  });
  await page.waitForSelector('.chat-container');

  const suffix = combo.primary ? '' : `-${combo.width}-${combo.theme}`;

  for (const s of MAIN_SCENARIO) {
    if (s.post) {
      await send(page, s.post);
    } else if (s.drive) {
      s.drive(driver.host);
      driver.host.flush();
      await sendAll(page, driver.take());
    } else if (s.mark) {
      const shouldShoot = combo.primary || REPRESENTATIVE.has(s.mark);
      if (shouldShoot) {
        await page.waitForTimeout(30);
        await page.screenshot({ path: path.join(OUT, `${s.mark}${suffix}.png`) });
      }
      if (combo.primary) await assertMark(page, s.mark);
      if (s.mark === 'subagent-collapsed' && combo.primary) await independentDisclosures(page);
      if (s.mark === 'turn-open') {
        await pendingPlanner(page, `${combo.width}/${combo.theme}`, `pending-planner-${combo.width}-${combo.theme}.png`);
        if (combo.primary) await queuedPromptAndEscape(page);
      }
    }
  }

  if (combo.primary) await reloadScenario(page);

  for (const sel of CONTRAST_SELECTORS) {
    const ratio = await contrastRatio(page, sel);
    if (ratio === null) continue; // not present in every combo (e.g. after Esc closed the turn)
    check(ratio >= 4.5, `contrast ${combo.width}/${combo.theme} ${sel}: ${ratio.toFixed(2)}:1 (WCAG AA text needs 4.5:1)`);
  }

  await page.close();
}

for (const combo of runs('tasklog') ? COMBOS : []) {
  console.log(`\n== task log, ${combo.width}px, ${combo.theme} theme ==`);
  await pendingTaskLog(combo.width, combo.theme);
}

for (const combo of runs('activity') ? COMBOS : []) {
  console.log(`\n== task log activity, ${combo.width}px, ${combo.theme} theme ==`);
  await taskLogActivity(combo.width, combo.theme);
}

for (const combo of runs('script') ? COMBOS : []) {
  console.log(`\n== script task log, ${combo.width}px, ${combo.theme} theme ==`);
  await scriptTaskLog(combo.width, combo.theme);
}

for (const combo of runs('cards') ? CARD_COMBOS : []) {
  console.log(`\n== task cards, ${combo.width}px, ${combo.theme} theme ==`);
  await taskCards(combo.width, combo.theme);
}

for (const combo of runs('planner-auth') ? PLANNER_AUTH_COMBOS : []) {
  console.log(`\n== signed-out planner, ${combo.width}px, ${combo.theme} theme ==`);
  await signedOutPlanner(combo.width, combo.theme);
}

for (const combo of runs('first-screen') ? FIRST_SCREEN_COMBOS : []) {
  console.log(`\n== first screen, ${combo.width}px, ${combo.theme} theme ==`);
  await firstScreen(combo.width, combo.theme);
}

for (const combo of runs('run-settings') ? COMBOS : []) {
  console.log(`\n== run settings, ${combo.width}px, ${combo.theme} theme ==`);
  await runSettingsSegments(combo.width, combo.theme);
}

await browser.close();
console.log(`\nscreenshots: ${OUT}/`);
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log('all visual assertions passed');
