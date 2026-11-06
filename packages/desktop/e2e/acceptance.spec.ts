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
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { appEnv, closeApp, freePort, git as gitIn, launchApp, makeSandbox, openFolder, removeSandbox, startMock, untilListening, type Sandbox } from './fixtures';

const GOAL = 'Add greeting and farewell modules';
const COMMENT = 'Export it as a named constant, please.';

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let daemonPort = 0;

function git(...args: string[]): string {
  if (!sandbox) throw new Error('no sandbox');
  return gitIn(sandbox, ...args);
}

test.beforeAll(async () => {
  sandbox = makeSandbox();
  const started = await startMock();
  mock = started.process;
  daemonPort = await freePort();
  app = await launchApp(sandbox, appEnv(sandbox, daemonPort, started.port));
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
    if (sandbox && fs.existsSync(sandbox.fakeClaudeLog)) await testInfo.attach('fake-claude.log', { path: sandbox.fakeClaudeLog });
  }
});

test.afterAll(async () => {
  const closed = await closeApp(app).then(() => undefined, (error: unknown) => ({ error }));
  mock?.kill();
  // The daemon stops a moment after the window closes, and until then it can
  // write under the temp HOME, which would leave the directory behind.
  if (daemonPort) await untilListening(daemonPort, false);
  if (closed) throw closed.error;
  if (sandbox) removeSandbox(sandbox);
});

test('a goal goes from the welcome window to a merge on the checkout\'s branch', async () => {
  if (!app) throw new Error('the app did not launch');
  const electronApp = app;
  const welcome = await electronApp.firstWindow();
  let win: Page = welcome;

  await test.step('welcome: open the workspace', async () => {
    await expect(welcome.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    win = await openFolder(electronApp, welcome, sandbox?.repo ?? '');
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
  });

  const views = win.getByRole('navigation', { name: 'Views' });
  const editor = win.getByRole('main', { name: 'Centre' });
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });
  const graph = editor.getByRole('grid', { name: 'Plan graph' });
  const changes = win.getByRole('navigation', { name: 'Changes' });
  // The planner tab's approval card offers the same Approve: the title bar's is the frame's one.
  const approve = win.locator('header.frame-title').getByRole('button', { name: 'Approve plan' });
  const taskOneChanges = changes.getByRole('region', { name: 'Task #1: Add a greeting module' });

  await test.step('new session: describe a goal to the planner, and the draft plan appears in the plan panel', async () => {
    await win.getByRole('button', { name: 'New session' }).click();
    await expect(editor.getByRole('tab', { name: /Planner/ })).toHaveAttribute('aria-selected', 'true');
    const box = editor.getByRole('textbox', { name: 'Message the planner' });
    await box.fill(GOAL);
    await box.press('Enter');
    await expect(approve).toBeVisible({ timeout: 60_000 });
    await expect(planPanel.getByRole('button', { name: 'Add a greeting module' })).toBeVisible();
    await expect(planPanel.getByRole('button', { name: 'Add a farewell module' })).toBeVisible();
  });

  await test.step('the plan graph opens as a tab beside the planner', async () => {
    await planPanel.getByRole('button', { name: 'Open the plan graph' }).click();
    await expect(editor.getByRole('tab', { name: /Plan graph/ })).toHaveAttribute('aria-selected', 'true');
    await expect(graph.getByRole('button', { name: '#1 Add a greeting module, not started' })).toBeVisible();
    await expect(graph.getByRole('button', { name: '#2 Add a farewell module, not started' })).toBeVisible();
    await expect(planPanel.getByRole('button', { name: 'Add a greeting module' })).toBeVisible();
  });

  await test.step('approve and run: task #1 starts in its own worktree', async () => {
    await approve.click();
    await expect(graph.getByRole('button', { name: /^#1 Add a greeting module, running/ })).toBeVisible({ timeout: 60_000 });
    await expect(graph.getByRole('button', { name: /^#2 Add a farewell module, not started/ })).toBeVisible();
    await views.getByRole('tab', { name: 'Changes' }).click();
    await expect(taskOneChanges.getByRole('button', { name: /greeting\.ts/ })).toBeVisible({ timeout: 60_000 });
  });

  await test.step('Explorer: the task #1 worktree scope, then the checkout scope', async () => {
    await views.getByRole('tab', { name: 'Explorer' }).click();
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
    await views.getByRole('tab', { name: 'Changes' }).click();
    await taskOneChanges.getByRole('button', { name: /greeting\.ts/ }).click();
    const diff = win.getByTestId('monaco-diff-host');
    await expect(diff).toBeVisible();
    // Monaco draws lines with no accessible role: the line is the one CSS hook.
    // A narrow centre turns the diff inline, where the deleted lines are view-lines too.
    await diff.locator('.editor.modified .view-line').filter({ hasText: 'greeting' }).first().click();
    await win.getByRole('button', { name: 'Comment to task #1' }).click();
    await win.getByRole('textbox', { name: 'Comment to task #1' }).fill(COMMENT);
    await win.getByRole('button', { name: 'Send to task #1' }).click();
    await expect(win.getByRole('note', { name: /Comment on src\/greeting\.ts/ })).toBeVisible();
  });

  await test.step('task #1 passes, with its evidence in the task tab', async () => {
    await editor.getByRole('tab', { name: /Plan graph/ }).click();
    // The run is isolated, so a verified task waits for the merge rather than reading as passed.
    const passed = graph.getByRole('button', { name: /^#1 Add a greeting module, waiting for merge/ });
    await expect(passed).toBeVisible({ timeout: 60_000 });
    const editorTabs = editor.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab');
    const opened = await editorTabs.count();
    // A graph card reveals its task in the plan panel, opening it there even from the rail; only Open chat opens a tab.
    await planPanel.getByRole('button', { name: 'Collapse the plan panel' }).click();
    await expect(planPanel).toBeHidden();
    await passed.click();
    const card = planPanel.locator('.task-card').filter({ has: win.getByRole('button', { name: /^#1 Add a greeting module, / }) });
    await expect(card.getByRole('button', { name: /^#1 Add a greeting module, / })).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toBeInViewport();
    await expect(editorTabs).toHaveCount(opened);
    await card.getByRole('button', { name: 'Open chat' }).click();
    await expect(editor.getByRole('heading', { name: '#1 Add a greeting module' })).toBeVisible();
    await expect(editorTabs).toHaveCount(opened + 1);
    await editor.getByRole('tablist', { name: 'Task view' }).getByRole('tab', { name: 'Details' }).click();
    const verdict = editor.getByRole('region', { name: 'Verdict' });
    await expect(verdict).toContainText('Verified: the runner reported completion through task_complete.');
    await expect(verdict).not.toContainText('Verified: Verified');
    await expect(verdict.getByRole('listitem').filter({ hasText: 'Completion Call' })).toContainText('passed');
    await expect(editor.getByRole('region', { name: 'Attempts' })).toContainText('Attempt 1 · Claude Code');
    await expect(editor.getByRole('region', { name: 'Handoff section' })).toContainText('Added src/greeting.ts exporting a greeting.');
    // The comment reached the runner as a message on its turn.
    expect(fs.readFileSync(sandbox?.fakeClaudeLog ?? '', 'utf8')).toContain(COMMENT);
  });

  await test.step('Needs you: task #2\'s checkpoint is raised and answered', async () => {
    const needsYou = win.getByRole('button', { name: 'Needs you, 1' });
    await expect(needsYou).toBeVisible({ timeout: 60_000 });
    await needsYou.click();
    await win.getByRole('dialog', { name: 'Needs you' }).getByRole('button', { name: 'Approve: #2 Add a farewell module' }).click();
    await editor.getByRole('tab', { name: /Plan graph/ }).click();
    await expect(graph.getByRole('button', { name: /^#2 Add a farewell module, waiting for merge/ })).toBeVisible({ timeout: 60_000 });
    // The landed run is the next thing that needs you: its Merge all row.
    await expect(needsYou).toBeVisible({ timeout: 60_000 });
    await needsYou.click();
    await expect(win.getByRole('dialog', { name: 'Needs you' }).getByRole('button', { name: /Merge all: / })).toBeVisible({ timeout: 60_000 });
    await win.keyboard.press('Escape');
  });

  await test.step('Git: the view lists the run\'s integration branch', async () => {
    await views.getByRole('tab', { name: 'Git' }).click();
    await expect(win.getByRole('navigation', { name: 'Git' }).getByRole('button', { name: /^ordewell\/.+\/integration\b/ })).toBeVisible();
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
