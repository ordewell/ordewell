/**
 * Joining a session another Ordewell daemon holds, end to end and offline
 * (ADR-0060 H8, design.md W16).
 *
 * A second daemon, started as a TUI starts its private one (`--watch-parent`),
 * plans a goal and so holds the session's lease. The app, on its own daemon,
 * opens the workspace and that session: it joins the holder rather than
 * showing it read-only, and a planner message sent from the app lands in the
 * holder's session. Then the holder exits, and Continue here carries the
 * session into the app's own daemon.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appEnv, freePort, launchApp, makeSandbox, openFolder, removeSandbox, ROOT, startMock, untilListening, type Sandbox } from './fixtures';

const GOAL = 'Add greeting and farewell modules';
const SESSION = 'session-joined-e2e';
const FROM_APP = 'Keep the greeting to one line, please.';
const AFTER_EXIT = 'Carry on from here.';

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
let holder: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let appPort = 0;
let holderPort = 0;

function box(): Sandbox {
  if (!sandbox) throw new Error('no sandbox');
  return sandbox;
}

async function daemonCall(port: number, method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
  const token = fs.readFileSync(path.join(box().home, '.ordewell', `server-${port}.token`), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

/** The session as `port`'s daemon serves it, as text to look for a message in. */
async function sessionAt(port: number): Promise<string> {
  try {
    return JSON.stringify(await daemonCall(port, 'GET', `/api/sessions/${SESSION}?workspace=${encodeURIComponent(box().repo)}`));
  } catch (error) {
    return String(error);
  }
}

/**
 * The conversation the session's saved file holds, as text. The daemon's
 * GET /api/sessions/:id leaves the transcript out, and the file is written by
 * whichever daemon holds the session, so it says which one took the message.
 */
function savedConversation(): string {
  const dir = path.join(box().repo, '.ordewell', 'sessions');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return ''; }
  for (const name of names) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { meta?: { id?: unknown }; plan?: { conversationHistory?: unknown } };
      if (saved.meta?.id === SESSION) return JSON.stringify(saved.plan?.conversationHistory ?? []);
    } catch {
      // A file mid-write is read again on the next poll.
    }
  }
  return '';
}

/** The pid of the app's own daemon, from the pid file it writes beside its token. */
function appDaemonPid(): number | undefined {
  try {
    const pid = Number(fs.readFileSync(path.join(box().home, '.ordewell', `server-${appPort}.pid`), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The pid the session's lease file names, read the way any host reads it. */
function leasePid(): number | undefined {
  const file = path.join(box().repo, '.ordewell', 'sessions', SESSION, 'lease.json');
  try {
    const pid: unknown = (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
}

test.beforeAll(async () => {
  sandbox = makeSandbox('ordewell-desktop-joined-');
  const started = await startMock();
  mock = started.process;
  holderPort = await freePort();
  appPort = await freePort();
  // A TUI's private daemon is one that watches its parent: the lease then names the TUI as its owner.
  holder = spawn(process.execPath, [
    path.join(ROOT, 'packages/web/dist/server/main.js'),
    '--port', String(holderPort),
    '--pid-file', path.join(sandbox.home, '.ordewell', `server-${holderPort}.pid`),
    '--watch-parent', String(process.pid),
  ], { env: appEnv(sandbox, holderPort, started.port), cwd: sandbox.tmp, stdio: 'ignore' });
  if (!await untilListening(holderPort, true)) throw new Error(`the holder never listened on ${holderPort}`);
  await daemonCall(holderPort, 'POST', `/api/plans/${SESSION}/converse/start?workspace=${encodeURIComponent(sandbox.repo)}`, {
    goal: GOAL,
    workspace: sandbox.repo,
    runners: ['claude-code'],
  });
  app = await launchApp(sandbox, appEnv(sandbox, appPort, started.port));
  await app.context().tracing.start({ screenshots: true, snapshots: true });
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  await app?.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined).catch(() => undefined);
  if (failed) {
    for (const [i, page] of (app?.windows() ?? []).entries()) {
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined);
    }
  }
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  holder?.kill();
  mock?.kill();
  if (appPort) await untilListening(appPort, false);
  if (holderPort) await untilListening(holderPort, false);
  if (sandbox) removeSandbox(sandbox);
});

test('the app joins a session a TUI\'s daemon holds, drives it there, and continues it after the TUI exits', async () => {
  if (!app || !holder?.pid) throw new Error('the app or the holder did not start');
  const electronApp = app;
  const holderPid = holder.pid;
  const welcome = await electronApp.firstWindow();
  let win: Page = welcome;

  await test.step('the holder planned the goal and holds the session', async () => {
    expect(leasePid()).toBe(holderPid);
    expect(await sessionAt(holderPort)).toContain('Add a greeting module');
  });

  await test.step('open the workspace and the held session: the app joins the holder', async () => {
    win = await openFolder(electronApp, welcome, box().repo);
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
    const sidebar = win.getByRole('navigation', { name: 'Sessions' });
    // Clicking the activity already shown collapses its sidebar, so it is clicked only when hidden.
    if (!await sidebar.isVisible()) await win.getByRole('navigation', { name: 'Views' }).getByRole('tab', { name: /^Sessions/ }).click();
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('button', { name: new RegExp(GOAL) }).click({ timeout: 60_000 });
    await expect(win.getByText(`Live in the TUI's daemon on port ${holderPort} (pid ${holderPid}), shared with the TUI.`)).toBeVisible({ timeout: 30_000 });
    await expect(win.getByRole('contentinfo')).toContainText(`joined :${holderPort}`);
    await expect(sidebar.getByRole('button', { name: new RegExp(`${GOAL} Joined · TUI pid ${process.pid}`) })).toBeVisible();
    await expect(win.getByRole('region', { name: /^Held by|^Can't join/ })).toHaveCount(0);
  });

  await test.step('a planner message sent from the app reaches the holder\'s session', async () => {
    const box = win.getByRole('textbox', { name: 'Message the planner' });
    await expect(box).toBeEditable();
    await box.fill(FROM_APP);
    await box.press('Enter');
    await expect.poll(savedConversation, { timeout: 60_000 }).toContain(FROM_APP);
    // The holder's reply comes back over its socket: both clients see the same conversation.
    await expect(win.getByRole('main', { name: 'Centre' })).toContainText('Noted. Nothing to change.', { timeout: 60_000 });
    // Still the holder's session: the app adopted nothing.
    expect(leasePid()).toBe(holderPid);
  });

  await test.step('the holder exits: Continue here carries the session into the app\'s own daemon', async () => {
    holder?.kill('SIGTERM');
    await untilListening(holderPort, false);
    const gone = win.getByRole('region', { name: 'The TUI that held this session has exited.' });
    await expect(gone).toBeVisible({ timeout: 60_000 });
    await gone.getByRole('button', { name: 'Continue here' }).click();
    await expect(gone).toBeHidden({ timeout: 30_000 });
    await expect(win.getByRole('contentinfo')).not.toContainText(`joined :${holderPort}`);
    const box = win.getByRole('textbox', { name: 'Message the planner' });
    await expect(box).toBeEditable();
    await box.fill(AFTER_EXIT);
    await box.press('Enter');
    await expect.poll(savedConversation, { timeout: 60_000 }).toContain(AFTER_EXIT);
    expect(savedConversation()).toContain(FROM_APP);
    // The app's own daemon now holds the lease the holder freed.
    expect(leasePid()).toBe(appDaemonPid());
    expect(leasePid()).not.toBe(holderPid);
  });
});
