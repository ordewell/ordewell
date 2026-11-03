/**
 * The desktop app end to end, offline: no API key, no network (RFC #129).
 *
 * The built Electron app opens a temp git repository. Its daemon's planner talks
 * to bench/live/mock-provider.mjs (persona mock/desktop-e2e), and its only runner
 * is bench/pipeline's fake-claude, first on PATH. The persona's prompts steer the
 * fake: task #1 writes src/greeting.ts and holds its turn open until a message
 * reaches it, which is the line comment this test sends; task #2 raises a
 * checkpoint, the Needs you item, then writes src/farewell.ts. So the walk follows
 * the run rather than the order of the views: the Explorer looks into task #1's
 * worktree while that task waits, because a landed task's worktree is pruned.
 *
 * Every assertion is on a role and an accessible name. The one exception is
 * picking a line in Monaco's diff, which exposes no line role.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const DESKTOP = path.join(ROOT, 'packages/desktop');
const GOAL = 'Add greeting and farewell modules';
const COMMENT = 'Export it as a named constant, please.';

let tmp = '';
let repo = '';
let mock: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let daemonPort = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: path.join(tmp, 'home') } });
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Polls a port until it is `up`, or not, for at most ten seconds. */
async function untilListening(port: number, up: boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await listening(port) === up) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Only the fake runner, node and git are on PATH. With the machine's own PATH the
 * daemon's model discovery spawns whatever real codex or opencode is installed,
 * which is neither offline nor quick. The daemon still appends the login shell's
 * PATH and the usual install directories after this one, so codex and opencode
 * are stubs that fail as a missing command does, and shadow a real install.
 */
function hermeticPath(): string {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  for (const absent of ['codex', 'opencode']) fs.writeFileSync(path.join(bin, absent), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  return [path.join(ROOT, 'bench/pipeline/fake-claude'), bin, '/usr/bin', '/bin'].join(path.delimiter);
}

function appEnv(home: string, daemonPort: number, mockPort: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A developer's own Ordewell, Claude Code or VS Code settings would steer the app under test.
    if (value === undefined || /^(ORDEWELL_|VSCODE_|CLAUDE)/.test(key) || key === 'ELECTRON_RUN_AS_NODE' || key === 'ANTHROPIC_API_KEY') continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    PATH: hermeticPath(),
    ORDEWELL_PORT: String(daemonPort),
    ORDEWELL_NO_VERSION_CHECK: '1',
    ORDEWELL_ENABLED_RUNNERS: 'claude-code',
    AI_PROVIDER: 'openrouter',
    ORCHESTRATOR_MODEL: 'mock/desktop-e2e',
    OPENROUTER_API_KEY: 'mock-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    FAKE_CLAUDE_LOG: path.join(tmp, 'fake-claude.log'),
  };
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-desktop-e2e-')));
  const home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  for (const dir of [home, repo]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Desktop E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n');
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const mockPort = await freePort();
  daemonPort = await freePort();
  mock = spawn(process.execPath, [path.join(ROOT, 'bench/live/mock-provider.mjs'), '--port', String(mockPort)], { stdio: 'ignore' });
  // The planner's first turn must never meet a closed port.
  if (!await untilListening(mockPort, true)) throw new Error(`the mock provider never listened on ${mockPort}`);

  app = await electron.launch({
    // A Linux CI runner has no setuid chrome-sandbox, and its AppArmor forbids
    // the unprivileged user namespaces Chromium's sandbox falls back to.
    args: [DESKTOP, `--user-data-dir=${path.join(tmp, 'user-data')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: appEnv(home, daemonPort, mockPort),
    cwd: tmp,
  });
  // Playwright's own `trace` option reaches pages it launches, not an Electron app's.
  await app.context().tracing.start({ screenshots: true, snapshots: true });
});

// Playwright reads the fixtures a hook takes from a destructured first parameter, so an empty one it must be.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  await app?.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined).catch(() => undefined);
  if (failed) {
    for (const [i, page] of (app?.windows() ?? []).entries()) {
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined);
    }
    const log = path.join(tmp, 'fake-claude.log');
    if (fs.existsSync(log)) await testInfo.attach('fake-claude.log', { path: log });
  }
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  mock?.kill();
  // The daemon stops a moment after the window closes, and until then it can
  // write under the temp HOME, which would leave the directory behind.
  if (daemonPort) await untilListening(daemonPort, false);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('a goal goes from the welcome window to a merge on the checkout\'s branch', async () => {
  if (!app) throw new Error('the app did not launch');
  const electronApp = app;
  const welcome = await electronApp.firstWindow();
  let win: Page = welcome;

  await test.step('welcome: open the workspace', async () => {
    await expect(welcome.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    // The native picker cannot be driven: main's dialog answers with the repository.
    await electronApp.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, repo);
    [win] = await Promise.all([electronApp.waitForEvent('window'), welcome.getByRole('button', { name: 'Open folder…' }).click()]);
    await expect(win.getByRole('contentinfo')).toContainText('runners: claude-code');
  });

  const views = win.getByRole('navigation', { name: 'Views' });
  const editor = win.getByRole('main', { name: 'Editor' });
  const planSidebar = win.getByRole('complementary', { name: 'Plan', exact: true });
  const changes = win.getByRole('complementary', { name: 'Changes' });
  const taskOneChanges = changes.getByRole('region', { name: 'Task #1: Add a greeting module' });

  await test.step('new session: describe a goal, and the draft plan appears in List', async () => {
    await win.getByRole('button', { name: 'New session' }).click();
    const box = win.getByRole('textbox', { name: 'Message the planner' });
    await box.fill(GOAL);
    await box.press('Enter');
    await expect(win.getByRole('button', { name: 'Approve plan' })).toBeVisible({ timeout: 60_000 });
    const planView = editor.getByRole('group', { name: 'Plan view' });
    await expect(planView.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    await expect(editor.getByRole('button', { name: 'Add a greeting module' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Add a farewell module' })).toBeVisible();
  });

  await test.step('toggle Graph and back to List', async () => {
    const planView = editor.getByRole('group', { name: 'Plan view' });
    await planView.getByRole('button', { name: 'Graph' }).click();
    const graph = editor.getByRole('application', { name: 'Plan graph' });
    await expect(graph.getByRole('button', { name: '#1 Add a greeting module, not started' })).toBeVisible();
    await expect(graph.getByRole('button', { name: '#2 Add a farewell module, not started' })).toBeVisible();
    await planView.getByRole('button', { name: 'List' }).click();
    await expect(planView.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    await expect(editor.getByRole('button', { name: 'Add a greeting module' })).toBeVisible();
  });

  await test.step('approve and run: task #1 starts in its own worktree', async () => {
    await win.getByRole('button', { name: 'Approve plan' }).click();
    const tasks = planSidebar.getByRole('list', { name: 'Tasks' });
    await expect(tasks.getByRole('button', { name: 'Running #1 Add a greeting module' })).toBeVisible({ timeout: 60_000 });
    await expect(tasks.getByRole('button', { name: 'Not started #2 Add a farewell module' })).toBeVisible();
    await views.getByRole('button', { name: 'Changes' }).click();
    await expect(taskOneChanges.getByRole('button', { name: /greeting\.ts/ })).toBeVisible({ timeout: 60_000 });
  });

  await test.step('Explorer: the task #1 worktree scope, then the checkout scope', async () => {
    await views.getByRole('button', { name: 'Explorer' }).click();
    await win.getByRole('button', { name: 'Your checkout', exact: true }).click();
    await win.getByRole('menuitemradio', { name: /Task #1 worktree/ }).click();
    const taskTree = win.getByRole('tree', { name: 'Files in Task #1' });
    await expect(taskTree.getByRole('treeitem', { name: /src/ })).toBeVisible();
    await expect(taskTree.getByRole('treeitem', { name: /README\.md/ })).toBeVisible();

    await win.getByRole('button', { name: /Task #1/ }).first().click();
    await win.getByRole('menuitemradio', { name: /Your checkout/ }).click();
    const checkoutTree = win.getByRole('tree', { name: 'Files in Your checkout' });
    await expect(checkoutTree.getByRole('treeitem', { name: /README\.md/ })).toBeVisible();
    // The task's file is in its worktree, not yet in the checkout.
    await expect(checkoutTree.getByRole('treeitem', { name: /^src/ })).toHaveCount(0);
  });

  await test.step('Changes: open task #1\'s diff and send it a line comment', async () => {
    await views.getByRole('button', { name: 'Changes' }).click();
    await taskOneChanges.getByRole('button', { name: /greeting\.ts/ }).click();
    const diff = win.getByTestId('monaco-diff-host');
    await expect(diff).toBeVisible();
    // Monaco draws lines with no accessible role: the line is the one CSS hook.
    await diff.locator('.editor.modified .view-line').first().click();
    await win.getByRole('button', { name: 'Comment to task #1' }).click();
    await win.getByRole('textbox', { name: 'Comment to task #1' }).fill(COMMENT);
    await win.getByRole('button', { name: 'Send to task #1' }).click();
    await expect(win.getByRole('note', { name: /Comment on src\/greeting\.ts/ })).toBeVisible();
  });

  await test.step('task #1 passes, with its evidence in the task tab', async () => {
    await views.getByRole('button', { name: 'Plan' }).click();
    const passed = planSidebar.getByRole('list', { name: 'Tasks' }).getByRole('button', { name: 'Passed #1 Add a greeting module' });
    await expect(passed).toBeVisible({ timeout: 60_000 });
    await passed.click();
    await expect(editor.getByRole('heading', { name: '#1 Add a greeting module' })).toBeVisible();
    const verdict = editor.getByRole('region', { name: 'Verdict' });
    await expect(verdict).toContainText('Verified: the runner reported completion through task_complete.');
    await expect(verdict).not.toContainText('Verified: Verified');
    await expect(verdict.getByRole('listitem').filter({ hasText: 'Completion Call' })).toContainText('passed');
    await expect(editor.getByRole('region', { name: 'Attempts' })).toContainText('Attempt 1 · Claude Code');
    await expect(editor.getByRole('region', { name: 'Handoff section' })).toContainText('Added src/greeting.ts exporting a greeting.');
    // The comment reached the runner as a message on its turn.
    expect(fs.readFileSync(path.join(tmp, 'fake-claude.log'), 'utf8')).toContain(COMMENT);
  });

  await test.step('Needs you: task #2\'s checkpoint is raised and answered', async () => {
    await expect(win.getByRole('button', { name: 'Needs you: 1' })).toBeVisible({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Approve: #2 Add a farewell module' }).click();
    await expect(planSidebar.getByRole('list', { name: 'Tasks' }).getByRole('button', { name: 'Passed #2 Add a farewell module' }))
      .toBeVisible({ timeout: 60_000 });
    await expect(win.getByRole('button', { name: /Merge all: / })).toBeVisible({ timeout: 60_000 });
  });

  await test.step('Git: the view lists the run\'s integration branch', async () => {
    await views.getByRole('button', { name: 'Git' }).click();
    await expect(win.getByRole('complementary', { name: 'Git' }).getByRole('button', { name: /^ordewell\/.+\/integration$/ })).toBeVisible();
  });

  await test.step('Review & Merge all, through the preflight', async () => {
    await win.getByRole('button', { name: 'Review & Merge all' }).click();
    await changes.getByRole('button', { name: 'Merge all…' }).click();
    const preflight = win.getByRole('dialog', { name: /Merge the isolated run into main/ });
    await expect(preflight.getByRole('list', { name: 'Where it lands' })).toBeVisible();
    await preflight.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(preflight).toBeHidden({ timeout: 60_000 });
  });

  await test.step('the change lands on the checkout\'s branch', async () => {
    const onMain = (file: string): string => {
      try { return git('show', `main:${file}`); } catch { return ''; }
    };
    await expect.poll(() => onMain('src/greeting.ts'), { timeout: 60_000 }).toContain('hello from the desktop e2e');
    expect(onMain('src/farewell.ts')).toContain('goodbye from the desktop e2e');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });
});
