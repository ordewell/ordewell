/**
 * Every marketing shot of the desktop app, on Harbor (harbor.ts): a small
 * TypeScript service with a real history and a remote, and one goal the mock
 * planner (mock-planner.mjs) plans as six tasks. The fake runners in fakes/
 * stream each task's work and hold at named gates until the spec releases
 * them, so a shot is taken at the moment it shows. Each test launches the app
 * on a Harbor of its own, on the real clock in a zone where it is
 * mid-afternoon, since a task's elapsed time is the daemon's.
 *
 * MARKETING_ONLY takes a comma list of: stills, hero (its three takes),
 * hero-wide, hero-web, hero-square, git and queue. MARKETING_KEEP_MASTERS
 * keeps each take's lossless master, its cut and the speed badges.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { cut, encode, type Segment } from './edit';
import { GOAL, harbor, type Harbor } from './harbor';
import { MASTERS, OUT, VIDEOS, WEB, type Entry } from './manifest';
import { FPS, openStudio, recordTake, settle, speedBadge, STILL_SIZES, THEMES, type Size, type Studio } from './studio';
import { posterWebp, shareCard, webImage } from './web';

const ONLY = new Set((process.env.MARKETING_ONLY ?? '').split(',').map((k) => k.trim()).filter(Boolean));
function wanted(...keys: string[]): boolean {
  return ONLY.size === 0 || keys.some((k) => ONLY.has(k));
}
const KEEP = Boolean(process.env.MARKETING_KEEP_MASTERS);

/** The views the website shows, which also go to web/ as 16:10 WebPs. */
const WEB_VIEWS = new Set(['plan', 'run', 'task', 'review', 'checkpoint', 'loop', 'git-branches', 'sessions', 'settings']);

const TASKS = {
  1: 'Limit failed sign-in attempts',
  2: 'Test the limit through the route',
  3: 'Document the limit for API callers',
  4: 'Run the test suite',
  5: 'Fix what the suite reports',
  6: 'Review the change before it ships',
} as const;
type TaskNumber = keyof typeof TASKS;

const wide = (size: Size): boolean => size.width >= 1920;

interface Widths { sidebar: number; git: number; sessions: number; changes: number; plan: number }
/** Panel widths per window: wide enough that nothing in them is cut, narrow enough that the centre keeps its room. */
function widths(size: Size): Widths {
  return wide(size)
    ? { sidebar: 280, git: 424, sessions: 360, changes: 340, plan: 380 }
    : { sidebar: 260, git: 388, sessions: 320, changes: 320, plan: 360 };
}

function launch(h: Harbor, scale: number): Promise<Studio> {
  return openStudio({ scale, sandbox: h.sandbox, planner: () => h.planner(), env: (base) => h.env(base), clock: 'real' });
}

const views = (page: Page): Locator => page.getByRole('navigation', { name: 'Views' });
type SashName = 'Resize sidebar' | 'Resize plan panel';
const sash = (page: Page, name: SashName): Locator => page.getByRole('separator', { name });
const planPanel = (page: Page): Locator => page.getByRole('complementary', { name: 'Plan', exact: true });
const centre = (page: Page): Locator => page.getByRole('main', { name: 'Centre' });
const needsYou = (page: Page): Locator => page.getByRole('button', { name: /^Needs you, / });
const approveButton = (page: Page): Locator => page.locator('header.frame-title').getByRole('button', { name: 'Approve plan' });
const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message the planner' });
const sync = (page: Page): Locator => page.getByRole('group', { name: 'Sync harbor' });
const pullButton = (page: Page): Locator => sync(page).getByRole('button', { name: /^Pull/ });
const gitView = (page: Page, view: 'Branches' | 'History'): Locator => page.getByRole('group', { name: 'Git sidebar view' }).getByRole('button', { name: view });

type View = 'Sessions' | 'Explorer' | 'Changes' | 'Git';

/** Docks the sidebar on `view`; picking the open view again would fold it. */
async function dock(page: Page, view: View): Promise<void> {
  const tab = views(page).getByRole('tab', { name: new RegExp(`^${view}`) });
  if ((await tab.getAttribute('aria-selected')) !== 'true' || (await sash(page, 'Resize sidebar').count()) === 0) await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(sash(page, 'Resize sidebar')).toBeVisible();
}

async function fold(page: Page): Promise<void> {
  if ((await sash(page, 'Resize sidebar').count()) === 0) return;
  await views(page).getByRole('tab', { selected: true }).click();
  await expect(sash(page, 'Resize sidebar')).toHaveCount(0);
}

async function planOpen(page: Page, open: boolean): Promise<void> {
  const collapsed = page.getByRole('complementary', { name: 'Plan, collapsed' });
  if (open && (await collapsed.count())) await collapsed.getByRole('button', { name: 'Expand the plan panel' }).click();
  if (!open && (await planPanel(page).count())) await planPanel(page).getByRole('button', { name: 'Collapse the plan panel' }).click();
  await expect(open ? planPanel(page) : collapsed).toBeVisible();
}

/** Closes every opened card in the plan panel: opening a task's chat opens its card, whose worktree path is the capture's temporary home. */
async function foldCards(page: Page): Promise<void> {
  for (const head of await planPanel(page).locator('.task-card.expanded .task-heading[aria-expanded="true"]').all()) await head.click();
  await expect(planPanel(page).locator('.task-card.expanded')).toHaveCount(0);
}

/** Drags a sash until its panel is `width` wide; the plan panel grows to the left. */
async function sashTo(page: Page, name: SashName, width: number): Promise<void> {
  const handle = sash(page, name);
  const sign = name === 'Resize plan panel' ? -1 : 1;
  const now = async (): Promise<number> => Number(await handle.getAttribute('aria-valuenow'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = await now();
    if (Math.abs(at - width) <= 1) return;
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${name} is not on screen`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + sign * (width - at), y, { steps: 6 });
    await page.mouse.up();
  }
  const rest = await now();
  if (Math.abs(rest - width) > 1) console.warn(`[marketing] ${name} rests at ${rest}, not ${width}`);
}

interface Arrangement { sidebar?: View; width?: keyof Widths; plan: boolean; planWidth?: number }

async function arrange(page: Page, size: Size, layout: Arrangement): Promise<void> {
  const w = widths(size);
  await planOpen(page, layout.plan);
  if (layout.sidebar) {
    await dock(page, layout.sidebar);
    await sashTo(page, 'Resize sidebar', w[layout.width ?? 'sidebar']);
  } else {
    await fold(page);
  }
  if (layout.plan) {
    await foldCards(page);
    await sashTo(page, 'Resize plan panel', layout.planWidth ?? w.plan);
  }
  await settle(page);
}

/** The run's own frame: the sidebar beside it where the window has the room, the plan panel docked. */
function runLayout(size: Size): Arrangement {
  return wide(size) ? { sidebar: 'Sessions', plan: true } : { plan: true };
}

/**
 * Grabs `view` at every still size in both themes, after `layout` has
 * arranged the window for that size, and the website's 16:10 pair from the
 * 1440x900 ones. Returns the dark 1440x900 still.
 */
async function shoot(studio: Studio, page: Page, view: string, layout?: (size: Size) => Promise<void>): Promise<Entry> {
  let kept: Entry | undefined;
  for (const size of STILL_SIZES) {
    await studio.present(page, size);
    if (layout) await layout(size);
    for (const theme of THEMES) {
      await studio.setTheme(page, theme);
      const entry = await studio.still(page, { view, theme, size });
      if (size.width === 1440 && WEB_VIEWS.has(view)) await webImage(path.join(OUT, entry.file), view, theme, entry.capturedAt);
      if (size.width === 1440 && theme === 'dark') kept = entry;
    }
  }
  if (!kept) throw new Error(`${view}: no 1440x900 dark still`);
  return kept;
}

async function welcomeReady(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.welcome-recent[data-state="loading"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/connecting/)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('ledger-api').first()).toBeVisible();
}

/**
 * The welcome card reads the workspace's isolation once, as the chat mounts. A window that mounted before
 * the daemon listened keeps "Could not read the Git repositories" until a run starts, so it reloads until
 * the read lands.
 */
async function isolationRead(page: Page): Promise<void> {
  const failed = page.getByText(/^Could not read the Git repositories/);
  const read = page.getByText('This workspace', { exact: true });
  await expect(async () => {
    if (await failed.isVisible()) {
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
    }
    await expect(read).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
}

/** Opens Harbor's workspace at `size`, with its earlier sessions listed. */
async function enter(studio: Studio, h: Harbor, size: Size): Promise<Page> {
  const page = await studio.openFolder(h.repo);
  await isolationRead(page);
  // A reload detects the runners again, and the status bar reads "runners: checking…" until they answer.
  await expect(page.locator('[data-runners="checking"]')).toHaveCount(0, { timeout: 90_000 });
  await studio.present(page, size);
  // Too narrow for both beside the centre, the sidebar would open as a drawer over it; the plan panel gives way until arrange() places it.
  await planOpen(page, false);
  await dock(page, 'Sessions');
  await expect(page.getByText('Paginate the users list').first()).toBeVisible({ timeout: 60_000 });
  return page;
}

async function plannerSettings(page: Page, open: boolean): Promise<void> {
  const toggle = page.getByRole('tabpanel', { name: 'Planner' }).getByRole('button', { name: 'Settings' });
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
}

const planCard = (page: Page, n: TaskNumber): Locator =>
  planPanel(page).locator('.task-card').filter({ has: page.getByRole('button', { name: new RegExp(`^#${n} ${TASKS[n]}, `) }) });
const openChatButton = (page: Page, n: TaskNumber): Locator => planCard(page, n).getByRole('button', { name: 'Open chat' });
const taskTab = (page: Page, n: TaskNumber): Locator => centre(page).getByRole('tab', { name: new RegExp(`^#${n} `) });
const graphTab = (page: Page): Locator => centre(page).getByRole('tab', { name: /^Plan graph/ });

// Through the plan panel: the centre may be showing a task rather than the graph.
async function openChat(page: Page, n: TaskNumber): Promise<void> {
  await planOpen(page, true);
  await openChatButton(page, n).click();
  await expect(taskTab(page, n)).toHaveAttribute('aria-selected', 'true');
}

async function showGraph(page: Page): Promise<void> {
  await graphTab(page).click();
  await expect(graphTab(page)).toHaveAttribute('aria-selected', 'true');
}

/** Closes the centre's selected tab, a diff or a commit opened for one shot. */
async function closeTab(page: Page): Promise<void> {
  await centre(page).getByRole('tab', { selected: true }).getByRole('button', { name: /^Close/ }).click();
}

async function logToEnd(page: Page): Promise<void> {
  await page.locator('.task-log-body').evaluateAll((els) => { for (const el of els) el.scrollTop = el.scrollHeight; });
}

/**
 * Opens every run of activity in the open log, so its reads, commands and
 * edits show rather than one line summing each up, and the task's prompt, the
 * log's first and loudest bubble, rises out of view above them.
 */
async function openActivity(page: Page): Promise<void> {
  // One at a time from the top: each one opened leaves the query, so the next closed one is always its first.
  const closed = centre(page).locator('.activity-group-toggle:visible[aria-expanded="false"]');
  for (let i = 0; i < 40 && (await closed.count()) > 0; i++) await closed.first().click();
  await expect(closed).toHaveCount(0);
}

async function fetchOrigin(page: Page): Promise<void> {
  await sync(page).getByRole('button', { name: 'Fetch' }).click();
  await expect(pullButton(page).locator('.sync-n')).toHaveText('2', { timeout: 30_000 });
}

// Waited for as attached, not visible: a narrow plan shows the wait nowhere but in Needs you's list, which is closed.
const mergeWaiting = (page: Page): Locator => page.getByText(/waits for Merge all/i).first();
const needsYouDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Needs you' });
const mergeAllRow = (page: Page): Locator => needsYouDialog(page).getByRole('button', { name: /^Merge all/ });
const approveCheckpointRow = (page: Page): Locator => needsYouDialog(page).getByRole('button', { name: /^Approve: #3/ });

/**
 * Closes Needs you once the row acted on has gone. Escape closes it only while
 * focus is inside, and that row took the focus with it, so its button in the
 * title bar closes it, as a person would.
 */
async function closeNeedsYou(page: Page, acted: Locator, click: (target: Locator) => Promise<void> = (target) => target.click()): Promise<void> {
  await expect(acted).toHaveCount(0, { timeout: 30_000 });
  const dialog = needsYouDialog(page);
  if ((await dialog.count()) === 0) return;
  if (await dialog.evaluate((el) => el.contains(document.activeElement))) await page.keyboard.press('Escape');
  else await click(page.locator('header.frame-title button.frame-needs-you-button'));
  await expect(dialog).toHaveCount(0);
}

async function mergeAll(page: Page): Promise<void> {
  await needsYou(page).click();
  await mergeAllRow(page).click();
  await closeNeedsYou(page, mergeAllRow(page));
}

async function answerCheckpoint(page: Page): Promise<void> {
  await needsYou(page).click();
  await approveCheckpointRow(page).click();
  await closeNeedsYou(page, approveCheckpointRow(page));
}

const taskComposer = (page: Page, n: TaskNumber): Locator => page.getByRole('textbox', { name: new RegExp(`^Message #${n}`) });
// The stack's last row is its Send all now button, not a message.
const pending = (page: Page): Locator => page.getByRole('list', { name: 'Pending messages' }).locator('li.pending-message');

/** Opens #1's change to src/auth/signIn.ts from its Changes tab. */
async function openSignInDiff(page: Page): Promise<void> {
  await page.getByRole('tablist', { name: 'Task view' }).getByRole('tab', { name: 'Changes' }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: /signIn\.ts/ }).first().dblclick();
  await expect(page.locator('.editor.modified .view-line').filter({ hasText: 'limiter.check(key)' }).first()).toBeVisible({ timeout: 30_000 });
}

async function diffLayout(page: Page, size: Size): Promise<void> {
  // Side by side cuts a diff's longer lines at 1440; unified keeps them whole.
  await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: wide(size) ? 'Side by side' : 'Unified' }).click();
  await settle(page);
}

const COMMENT = 'Log a throttled sign-in at info, without the email, so support can see why a caller got 429.';

/** Selects the limiter's lines in the diff and writes a comment on them to #1, unsent. */
async function commentOnDiff(page: Page): Promise<void> {
  const box = page.locator('textarea.changes-comment-input');
  if (await box.count()) return;
  const lines = page.locator('.editor.modified .view-line');
  await lines.filter({ hasText: 'limiter.check(key)' }).first().click();
  await lines.filter({ hasText: "'retry-after'" }).first().click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: /^Comment to task #1/ }).click();
  await box.fill(COMMENT);
}

test('stills: every view, at both sizes, in both themes', async () => {
  test.skip(!wanted('stills'), 'MARKETING_ONLY leaves the stills out');
  test.setTimeout(150 * 60_000);
  const h = harbor();
  h.pace(0.3);
  h.fetchDelay(0);
  let studio: Studio | undefined;
  try {
    studio = await launch(h, 2);
    const s = studio;
    const welcome = await s.welcome();
    await s.present(welcome, STILL_SIZES[0]);
    await welcomeReady(welcome);
    await shoot(s, welcome, 'welcome');

    const page = await enter(s, h, STILL_SIZES[0]);
    await composer(page).fill(GOAL);
    await shoot(s, page, 'planner-settings', async (size) => {
      await arrange(page, size, { sidebar: 'Sessions', plan: false });
      await plannerSettings(page, true);
    });
    await shoot(s, page, 'planner-goal', async (size) => {
      await arrange(page, size, { sidebar: 'Sessions', plan: false });
      await plannerSettings(page, false);
    });
    await composer(page).press('Enter');
    await expect(approveButton(page)).toBeVisible({ timeout: 90_000 });
    await shoot(s, page, 'plan', (size) => arrange(page, size, { sidebar: 'Sessions', plan: true }));

    await planOpen(page, true);
    await planPanel(page).getByRole('button', { name: 'Open the plan graph' }).click();
    await approveButton(page).click();
    for (const gate of ['limit', 'tests', 'docs']) await h.reached(gate);
    await showGraph(page);
    const run = await shoot(s, page, 'run', (size) => arrange(page, size, runLayout(size)));

    // The Git sidebar, after a fetch has found the two commits a teammate pushed.
    await dock(page, 'Git');
    await fetchOrigin(page);
    await shoot(s, page, 'git-branches', async (size) => {
      await arrange(page, size, { sidebar: 'Git', width: 'git', plan: false });
      await gitView(page, 'Branches').click();
      await expect(page.getByText(/Loading branches/)).toHaveCount(0, { timeout: 30_000 });
    });
    // The sign-in route's commit, with its change to app.ts open beside the history: a commit's file list alone leaves the pane bare.
    await gitView(page, 'History').click();
    await page.locator('.git-hrow').filter({ hasText: 'Add POST /sign-in' }).click();
    await page.getByRole('complementary', { name: 'Commit' }).getByRole('button', { name: 'M src/app.ts' }).click();
    await expect(page.locator('.editor.modified .view-line').filter({ hasText: 'POST /sign-in' }).first()).toBeVisible({ timeout: 30_000 });
    await shoot(s, page, 'git-history', async (size) => {
      await arrange(page, size, { sidebar: 'Git', width: 'git', plan: false });
      await diffLayout(page, size);
    });
    await closeTab(page);
    await closeTab(page);

    // #3's chat with a message queued for it while it works, taken back afterwards so the run goes on as planned.
    await openChat(page, 3);
    await taskComposer(page, 3).fill('Call them failed sign-in attempts.');
    await taskComposer(page, 3).press('Enter');
    await expect(pending(page)).toHaveCount(1);
    await shoot(s, page, 'task', async (size) => {
      await arrange(page, size, runLayout(size));
      await openActivity(page);
      await logToEnd(page);
    });
    await taskComposer(page, 3).press('Escape');
    await expect(pending(page)).toHaveCount(0);
    await taskComposer(page, 3).fill('');

    await openChat(page, 1);
    await shoot(s, page, 'task-log', async (size) => {
      await arrange(page, size, runLayout(size));
      await openActivity(page);
      await logToEnd(page);
    });

    // While #1 is still at work, so a comment on its diff goes to it rather than to the planner.
    await openSignInDiff(page);
    await shoot(s, page, 'review', async (size) => {
      await arrange(page, size, { sidebar: 'Changes', width: 'changes', plan: false });
      await diffLayout(page, size);
      await commentOnDiff(page);
    });
    await page.locator('textarea.changes-comment-input').press('Escape');
    await closeTab(page);

    h.release('docs');
    await expect(needsYou(page)).toBeVisible({ timeout: 60_000 });
    await openChat(page, 3);
    await expect(planPanel(page).getByText('HITL Checkpoint')).toBeVisible({ timeout: 30_000 });
    await shoot(s, page, 'checkpoint', async (size) => {
      await arrange(page, size, runLayout(size));
      await openActivity(page);
      await logToEnd(page);
    });
    await showGraph(page);
    await shoot(s, page, 'sessions', (size) => arrange(page, size, { sidebar: 'Sessions', width: 'sessions', plan: false }));
    await answerCheckpoint(page);

    h.release('limit');
    h.release('tests');
    await expect(mergeWaiting(page)).toBeAttached({ timeout: 120_000 });
    // A change of the developer's own beside the run, composed as a commit and put back before the merge, which wants a clean tree.
    h.editLocally();
    await dock(page, 'Changes');
    // The server's change staged and its diff open, the docs line still to stage: a commit halfway composed.
    // A row's actions show only while it is hovered, as a person reaches them.
    const serverRow = page.getByRole('region', { name: 'Changes in Your checkout' }).getByRole('listitem').filter({ hasText: 'server.ts' });
    await serverRow.hover({ timeout: 30_000 });
    await serverRow.getByRole('button', { name: 'Stage src/server.ts' }).click();
    await page.getByRole('region', { name: 'Staged in Your checkout' }).getByRole('button', { name: /server\.ts/ }).first().click();
    await page.getByRole('textbox', { name: /^Commit message for/ }).fill('Listen on HOST, defaulting to 127.0.0.1');
    await shoot(s, page, 'changes', async (size) => {
      await arrange(page, size, { sidebar: 'Changes', width: 'changes', plan: false });
      await diffLayout(page, size);
    });
    await closeTab(page);
    await page.getByRole('textbox', { name: /^Commit message for/ }).fill('');
    h.undoLocal();
    await showGraph(page);
    await expect(page.getByText('No changes in your checkout.')).toBeVisible({ timeout: 30_000 });
    await shoot(s, page, 'merge', async (size) => {
      await arrange(page, size, { sidebar: 'Changes', width: 'changes', plan: true });
      // At 1440 the plan list is taller than its panel and the Merge card sits below its fold.
      await page.locator('.isolation-handoff-actions:visible').first().scrollIntoViewIfNeeded();
      await settle(page);
    });

    await mergeAll(page);
    await h.reached('fix', 180_000);
    await expect(page.getByText(/Round 1 of 3: fixing/).first()).toBeVisible({ timeout: 60_000 });
    await shoot(s, page, 'loop-fixing', (size) => arrange(page, size, runLayout(size)));
    h.release('fix');
    await expect(page.getByText(/Round 2 of 3/).first()).toBeVisible({ timeout: 120_000 });
    await shoot(s, page, 'loop', (size) => arrange(page, size, runLayout(size)));

    const done = centre(page).getByRole('button', { name: /^Stage 3, passed, 2 of 2 done/ });
    await expect(async () => {
      if (await mergeWaiting(page).count()) await mergeAll(page);
      await expect(done).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 300_000, intervals: [2_000] });
    await shoot(s, page, 'done', (size) => arrange(page, size, runLayout(size)));

    await views(page).getByRole('button', { name: 'Settings' }).click();
    const runners = page.getByRole('region', { name: 'Runners' });
    await expect(runners).toBeVisible({ timeout: 30_000 });
    // The runners and the models each may offer are the story here, not the theme picker above them.
    await runners.getByRole('button', { name: 'Edit Claude Code models' }).click();
    await expect(runners.getByRole('listbox', { name: 'Claude Code models' }).getByRole('option').first()).toBeVisible({ timeout: 30_000 });
    await shoot(s, page, 'settings', async (size) => {
      await arrange(page, size, { plan: false });
      await runners.evaluate((section) => {
        section.scrollIntoView({ block: 'start' });
        let box = section.parentElement;
        while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
        box?.scrollBy(0, -24);
      });
      await settle(page);
    });

    await shareCard(s, path.join(OUT, run.file), new Date().toISOString());
  } finally {
    await studio?.close();
  }
});

/** A recorded take's outline: what the window shows and how the flow goes. */
interface HeroTake {
  key: 'hero-wide' | 'hero-web' | 'hero-square';
  size: Size;
  layout: Arrangement;
  /** Whether the take opens #1's diff: the square has no room to read one. */
  diff: boolean;
  /** How long the hand rests between steps, against the wide take's: the square's 30 seconds leave less room to linger. */
  rests: number;
}

const HERO_TAKES: readonly HeroTake[] = [
  { key: 'hero-wide', size: { width: 1920, height: 1080 }, layout: { sidebar: 'Sessions', plan: true }, diff: true, rests: 1 },
  { key: 'hero-web', size: { width: 1440, height: 900 }, layout: { plan: true }, diff: true, rests: 1 },
  { key: 'hero-square', size: { width: 1080, height: 1080 }, layout: { plan: true, planWidth: 320 }, diff: false, rests: 0.6 },
];

/**
 * The stretches the edit may play faster, each with the seconds it is given
 * at each tightness, 0 the loosest. Typing stays at 1x until the cut has to
 * be short. Every other second plays at 1x.
 */
const BEATS: ReadonlyArray<{ from: string; to: string; seconds: readonly number[] }> = [
  { from: 'typing', to: 'typed', seconds: [Infinity, Infinity, Infinity, 3, 2.5] },
  { from: 'sent', to: 'planned', seconds: [3, 2, 1.5, 1.5, 1] },
  { from: 'reading', to: 'held', seconds: [6, 4, 3, 3, 2] },
  { from: 'back', to: 'asked', seconds: [2.5, 1.5, 1, 1, 0.8] },
  { from: 'answered', to: 'landed', seconds: [3, 2, 1.5, 1.5, 1] },
  { from: 'merging', to: 'merged', seconds: [3, 2, 1.5, 1.5, 1] },
];
const LEVELS = 5;
const SPEEDS = [2, 3, 4, 6, 8, 12] as const;

function retime(marks: Readonly<Record<string, number>>, level: number): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const beat of BEATS) {
    const from = marks[beat.from];
    const to = marks[beat.to];
    if (from === undefined || to === undefined || from < at || to <= from) continue;
    if (from > at) out.push({ from: at, to: from });
    const length = to - from;
    const room = beat.seconds[level] ?? Infinity;
    const speed = length <= room ? 1 : SPEEDS.find((s) => length / s <= room) ?? SPEEDS[SPEEDS.length - 1];
    out.push({ from, to, speed });
    at = to;
  }
  const end = marks.end ?? at;
  if (end > at) out.push({ from: at, to: end });
  // One 1x stretch where two meet, and none too short to hold a frame.
  const merged: Segment[] = [];
  for (const segment of out) {
    const last = merged[merged.length - 1];
    if (last && (last.speed ?? 1) === 1 && (segment.speed ?? 1) === 1 && last.to === segment.from) last.to = segment.to;
    else merged.push({ ...segment });
  }
  return merged.filter((s) => (s.to - s.from) / (s.speed ?? 1) >= 1 / FPS);
}

function lengthOf(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + (s.to - s.from) / (s.speed ?? 1), 0);
}

/** The first tightness, from `least`, at which the cut fits in `max` seconds; the tightest when none does. */
function fit(marks: Readonly<Record<string, number>>, max: number, least = 0): { level: number; segments: Segment[] } {
  for (let level = least; level < LEVELS; level++) {
    const segments = retime(marks, level);
    if (lengthOf(segments) <= max) return { level, segments };
  }
  const segments = retime(marks, LEVELS - 1);
  console.warn(`[marketing] the tightest cut is ${lengthOf(segments).toFixed(1)}s, over ${max}s`);
  return { level: LEVELS - 1, segments };
}

/** Where a second of the master falls in the cut. */
function cutTime(segments: readonly Segment[], at: number): number {
  let t = 0;
  for (const s of segments) {
    if (at <= s.from) break;
    t += (Math.min(at, s.to) - s.from) / (s.speed ?? 1);
    if (at < s.to) break;
  }
  return t;
}

async function badgesFor(studio: Studio, speeds: Iterable<number>): Promise<Record<number, string>> {
  const badges: Record<number, string> = {};
  for (const speed of new Set(speeds)) {
    if (speed !== 1) badges[speed] = await speedBadge(studio, speed, path.join(VIDEOS, `badge-${speed}x.png`));
  }
  return badges;
}

function tidy(files: Iterable<string>): void {
  if (KEEP) return;
  // Masters and cuts are lossless and large; what ships is encoded.
  for (const file of files) fs.rmSync(file, { force: true });
}

for (const take of HERO_TAKES) {
  test(`video: ${take.key}, from the goal to the merge`, async () => {
    test.skip(!wanted('hero', take.key), `MARKETING_ONLY leaves ${take.key} out`);
    test.setTimeout(30 * 60_000);
    const h = harbor();
    h.pace(0.5);
    h.fetchDelay(0);
    let studio: Studio | undefined;
    const scratch: string[] = [];
    try {
      studio = await launch(h, 1);
      const page = await enter(studio, h, take.size);
      await studio.setTheme(page, 'dark');
      await plannerSettings(page, false);
      await arrange(page, take.size, take.layout);
      const master = path.join(VIDEOS, `${take.key}.master.mkv`);
      scratch.push(master);
      const recorded = await recordTake(studio, page, master, async (hand, mark) => {
        const rest = (ms: number): Promise<void> => hand.wait(ms * take.rests);
        await rest(900);
        await hand.click(composer(page));
        mark('typing');
        await hand.type(GOAL);
        mark('typed');
        await rest(500);
        await page.keyboard.press('Enter');
        mark('sent');
        await expect(approveButton(page)).toBeVisible({ timeout: 90_000 });
        await settle(page);
        mark('planned');
        await rest(2500);
        await hand.click(planPanel(page).getByRole('button', { name: 'Open the plan graph' }));
        await rest(1800);
        await hand.click(approveButton(page));
        await expect(centre(page).getByRole('button', { name: /^#1 Limit failed sign-in attempts, running/ })).toBeVisible({ timeout: 60_000 });
        // Off the Stop button Approve turned into, to rest on the graph's empty corner while three tasks start.
        const graph = await centre(page).boundingBox();
        if (graph) await hand.move({ x: graph.x + graph.width * 0.82, y: graph.y + graph.height * 0.8 }, 800);
        mark('running');
        await rest(2000);
        await hand.click(openChatButton(page, 1));
        await expect(taskTab(page, 1)).toHaveAttribute('aria-selected', 'true');
        // Opening the chat opened #1's card in the plan as well; folded, the plan keeps all six tasks in view as they run.
        if (take.layout.plan) {
          await rest(700);
          await hand.click(planPanel(page).locator('.task-card.expanded .task-heading'));
          await expect(planPanel(page).locator('.task-card.expanded')).toHaveCount(0);
        }
        mark('reading');
        await h.reached('limit');
        await h.reached('tests');
        await logToEnd(page);
        mark('held');
        await rest(1500);
        if (take.diff) {
          await hand.click(page.getByRole('tablist', { name: 'Task view' }).getByRole('tab', { name: 'Changes' }));
          await rest(900);
          const file = page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: /signIn\.ts/ }).first();
          await hand.move(file);
          await page.mouse.dblclick((await file.boundingBox().then((b) => b && b.x + b.width / 2)) ?? 0, (await file.boundingBox().then((b) => b && b.y + b.height / 2)) ?? 0);
          await expect(page.locator('.editor.modified .view-line').filter({ hasText: 'limiter.check(key)' }).first()).toBeVisible({ timeout: 30_000 });
          if (!wide(take.size)) await hand.click(page.getByRole('button', { name: 'Unified' }));
          await rest(3500);
        }
        await hand.click(graphTab(page));
        mark('back');
        h.release('docs');
        await expect(needsYou(page)).toBeVisible({ timeout: 60_000 });
        mark('asked');
        await rest(1200);
        await hand.click(needsYou(page));
        await rest(900);
        await hand.click(approveCheckpointRow(page));
        mark('answered');
        await rest(600);
        await closeNeedsYou(page, approveCheckpointRow(page), (target) => hand.click(target, 500));
        h.release('limit');
        h.release('tests');
        await expect(mergeWaiting(page)).toBeAttached({ timeout: 120_000 });
        mark('landed');
        await rest(1500);
        await hand.click(needsYou(page));
        await rest(900);
        await hand.click(mergeAllRow(page));
        mark('merging');
        await rest(600);
        await closeNeedsYou(page, mergeAllRow(page), (target) => hand.click(target, 500));
        await expect(centre(page).getByRole('button', { name: /^Stage 1, passed, 3 of 3 done/ })).toBeVisible({ timeout: 120_000 });
        mark('merged');
        await rest(3000);
      });
      const clock = new Date().toISOString();
      const marks = recorded.marks;
      const square = take.key === 'hero-square';
      const main = fit(marks, square ? 30 : 50);
      const social = take.key === 'hero-wide' ? fit(marks, 45, Math.min(main.level + 1, LEVELS - 1)) : undefined;
      const badges = await badgesFor(studio, [...main.segments, ...(social?.segments ?? [])].map((s) => s.speed ?? 1));
      scratch.push(...Object.values(badges));
      const edit = async (name: string, segments: readonly Segment[]): Promise<{ file: string; duration: number }> => {
        const file = path.join(VIDEOS, `${name}.cut.mkv`);
        scratch.push(file);
        return cut(master, { segments, fade: 0.4, badges }, file);
      };
      // The poster is the moment three tasks run at once, the pointer at rest.
      const posterAt = (segments: readonly Segment[]): number => Math.max(0, cutTime(segments, (marks.running ?? 0) + take.rests));
      if (take.key === 'hero-wide') {
        const edited = await edit('hero-wide', main.segments);
        expect(edited.duration).toBeLessThanOrEqual(50.5);
        await encode(edited.file, { name: 'hero--dark--1920x1080', view: 'hero', theme: 'dark', size: take.size, posterAt: posterAt(main.segments), clock });
        if (social) {
          const short = await edit('hero-social', social.segments);
          expect(short.duration).toBeLessThanOrEqual(45);
          await encode(short.file, { name: 'hero-social--dark--1920x1080', view: 'hero (social)', theme: 'dark', size: take.size, posterAt: posterAt(social.segments), clock });
        }
      } else if (take.key === 'hero-web') {
        const edited = await edit('hero-web', main.segments);
        const poster = path.join(MASTERS, 'hero-poster.png');
        await encode(edited.file, { dir: WEB, name: 'hero', view: 'hero', theme: 'dark', size: take.size, poster, posterAt: posterAt(main.segments), clock });
        await posterWebp(poster, clock);
      } else {
        const edited = await edit('hero-square', main.segments);
        expect(edited.duration).toBeLessThanOrEqual(30.5);
        await encode(edited.file, { name: 'hero-square--dark--1080x1080', view: 'hero (square)', theme: 'dark', size: take.size, posterAt: posterAt(main.segments), clock });
      }
      console.log(`[marketing] ${take.key}: ${recorded.duration.toFixed(1)}s recorded, cut at tightness ${main.level}${social ? `, social at ${social.level}` : ''}`);
    } finally {
      await studio?.close();
      tidy(scratch);
    }
  });
}

const SMALL: Size = { width: 1280, height: 800 };

test('video: git, fetch then pull, then the history', async () => {
  test.skip(!wanted('git'), 'MARKETING_ONLY leaves git out');
  const h = harbor();
  // Long enough that each sync's busy motion reads.
  h.fetchDelay(1.4);
  let studio: Studio | undefined;
  const scratch: string[] = [];
  try {
    studio = await launch(h, 1);
    const page = await enter(studio, h, SMALL);
    await studio.setTheme(page, 'dark');
    await plannerSettings(page, false);
    await arrange(page, SMALL, { sidebar: 'Git', width: 'git', plan: false });
    await gitView(page, 'Branches').click();
    await expect(page.getByText(/Loading branches/)).toHaveCount(0, { timeout: 30_000 });
    const master = path.join(VIDEOS, 'git.master.mkv');
    scratch.push(master);
    const recorded = await recordTake(studio, page, master, async (hand) => {
      await hand.wait(600);
      await hand.click(sync(page).getByRole('button', { name: 'Fetch' }));
      await expect(pullButton(page).locator('.sync-n')).toHaveText('2', { timeout: 30_000 });
      await hand.wait(900);
      await hand.click(pullButton(page));
      await hand.click(page.getByRole('button', { name: 'Pull from origin' }), 500);
      await expect(sync(page).getByRole('button', { name: /^Pulling/ })).toBeVisible({ timeout: 10_000 });
      await expect(pullButton(page).locator('.sync-n')).toHaveText('', { timeout: 30_000 });
      await hand.wait(800);
      await hand.click(gitView(page, 'History'));
      await hand.wait(1200);
      await hand.click(page.locator('.git-hrow').first());
      // The take ends on the commit, so the poster shows its files rather than "Loading…" under the pointer.
      await expect(centre(page).getByRole('complementary', { name: 'Commit' }).locator('.git-list')).toBeVisible({ timeout: 30_000 });
      const pane = await centre(page).boundingBox();
      if (pane) await hand.move({ x: pane.x + pane.width * 0.62, y: pane.y + pane.height * 0.6 }, 700);
      await hand.wait(1400);
    });
    const file = path.join(VIDEOS, 'git.cut.mkv');
    scratch.push(file);
    const edited = await cut(master, { segments: [{ from: 0, to: recorded.marks.end ?? recorded.duration }], fade: 0.4 }, file);
    expect(edited.duration).toBeGreaterThanOrEqual(10);
    expect(edited.duration).toBeLessThanOrEqual(15.5);
    await encode(edited.file, { name: 'git--dark--1280x800', view: 'git: fetch, pull, history', theme: 'dark', size: SMALL, gifWidth: 960, posterAt: edited.duration - 1, clock: new Date().toISOString() });
  } finally {
    await studio?.close();
    tidy(scratch);
  }
});

test('video: queue, talk to a running task', async () => {
  test.skip(!wanted('queue'), 'MARKETING_ONLY leaves queue out');
  test.setTimeout(20 * 60_000);
  const h = harbor();
  h.pace(0.3);
  h.fetchDelay(0);
  let studio: Studio | undefined;
  const scratch: string[] = [];
  try {
    studio = await launch(h, 1);
    const page = await enter(studio, h, SMALL);
    await studio.setTheme(page, 'dark');
    await composer(page).fill(GOAL);
    await composer(page).press('Enter');
    await expect(approveButton(page)).toBeVisible({ timeout: 90_000 });
    await approveButton(page).click();
    for (const gate of ['limit', 'tests', 'docs']) await h.reached(gate);
    await planOpen(page, true);
    await openChat(page, 3);
    await arrange(page, SMALL, { plan: true, planWidth: 340 });
    // The work it has done open, as in the task still, so the log is #3's reading and editing rather than its prompt.
    await openActivity(page);
    await logToEnd(page);
    const box = taskComposer(page, 3);
    const master = path.join(VIDEOS, 'queue.master.mkv');
    scratch.push(master);
    const recorded = await recordTake(studio, page, master, async (hand, mark) => {
      await hand.wait(600);
      await hand.click(box);
      mark('typing1');
      await hand.type('Call them failed sign-in attempts.');
      mark('typed1');
      await hand.wait(400);
      await page.keyboard.press('Enter');
      await expect(pending(page)).toHaveCount(1);
      await hand.wait(700);
      mark('typing2');
      await hand.type('Mention Retry-After in the changelog.');
      mark('typed2');
      await hand.wait(400);
      await page.keyboard.press('Enter');
      await expect(pending(page)).toHaveCount(2);
      await hand.wait(1200);
      // Esc takes back the newest, into the empty composer, to be finished.
      await page.keyboard.press('Escape');
      await expect(pending(page)).toHaveCount(1);
      await expect(box).toHaveValue('Mention Retry-After in the changelog.');
      await hand.wait(1000);
      await page.keyboard.press('End');
      await page.keyboard.press('Backspace');
      mark('typing3');
      await hand.type(', beside the 429.');
      mark('typed3');
      await hand.wait(500);
      // Ctrl+Enter interrupts the turn and sends the queue, the composer's text last.
      await page.keyboard.press('Control+Enter');
      await expect(centre(page).getByText(/Good calls, both/).first()).toBeVisible({ timeout: 60_000 });
      await logToEnd(page);
      await hand.wait(2200);
    });
    const { typing1, typed1, typing2, typed2, typing3, typed3 } = recorded.marks;
    const segments: Segment[] = [
      { from: 0, to: typing1 + 0.5 },
      { from: typing1 + 0.5, to: typed1 - 0.3, speed: 2 },
      { from: typed1 - 0.3, to: typing2 + 0.5 },
      { from: typing2 + 0.5, to: typed2 - 0.3, speed: 2 },
      { from: typed2 - 0.3, to: typing3 + 0.3 },
      { from: typing3 + 0.3, to: typed3 - 0.2, speed: 2 },
      { from: typed3 - 0.2, to: recorded.marks.end ?? recorded.duration },
    ];
    const badges = await badgesFor(studio, [2]);
    scratch.push(...Object.values(badges));
    const file = path.join(VIDEOS, 'queue.cut.mkv');
    scratch.push(file);
    const edited = await cut(master, { segments, fade: 0.4, badges }, file);
    expect(edited.duration).toBeGreaterThanOrEqual(10);
    expect(edited.duration).toBeLessThanOrEqual(15.5);
    await encode(edited.file, { name: 'queue--dark--1280x800', view: 'queue: talk to a running task', theme: 'dark', size: SMALL, posterAt: cutTime(segments, typed2 + 0.8), clock: new Date().toISOString() });
  } finally {
    await studio?.close();
    tidy(scratch);
  }
});
