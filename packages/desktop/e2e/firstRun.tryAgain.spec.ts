/**
 * A planner turn that started and then failed shows its message once, then the
 * error with Try Again. Try Again sends that message again, and the message is
 * still drawn once: while the retried turn runs, after it lands, and when the
 * session is opened again; the saved conversation holds it once. Both for a
 * session's first message and for a later one, once a plan is drafted.
 *
 * The planner endpoint (firstRunHarness.ts) holds each turn until the spec lets
 * it go, and fails only the one request the spec names, so the failed turn and
 * the retried one in flight are states the spec holds rather than races.
 */
import { expect, test, type Locator } from '@playwright/test';
import { escapeRegExp, holdsFor, savedSessions, sessionsSidebar, startFirstRun, type FirstRun, type HeldPlanner } from './firstRunHarness';

const GOAL = 'Add greeting and farewell modules';
/** A task title of the plan bench/live's desktop-e2e persona answers GOAL with. */
const PLANNED = 'Add a greeting module';
/** A later message; the persona answers any after the plan with this. */
const LATER = 'Keep both modules small';
const LATER_ANSWER = 'Nothing to change.';
const FAILURE = 'firstRun: the planner refused this turn on purpose';

let run: FirstRun | undefined;

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await run?.finish(testInfo);
  run = undefined;
});

/** The user's bubbles in the chat that say `text`. A chat message has no role of its own: its class is the one hook. */
const bubbles = (editor: Locator, text: string): Locator => editor.locator('.chat-msg-user .chat-msg-content').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });

/** How many times the saved session's conversation holds `text` as a user message, in each session file that holds it at all. */
function savedTimes(workspace: string, text: string): number[] {
  const counts: number[] = [];
  for (const saved of savedSessions(workspace)) {
    let parsed: unknown;
    try { parsed = JSON.parse(saved); } catch { continue; }
    let n = 0;
    let found = false;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'conversationHistory' && Array.isArray(item)) {
          found = true;
          n += item.filter((entry: { role?: unknown; content?: unknown }) => entry?.role === 'user' && entry.content === text).length;
        } else walk(item);
      }
    };
    walk(parsed);
    if (found && saved.includes(text)) counts.push(n);
  }
  return counts;
}

/** Fails the next turn after it started, shows its message once with the error, then Try Again with the retried turn held. */
async function failThenTryAgain(current: FirstRun, planner: HeldPlanner, text: string): Promise<void> {
  const { editor, composer } = current;
  await test.step(`send "${text}": the planner fails its turn`, async () => {
    planner.hold();
    planner.failNext(FAILURE);
    const before = planner.requests();
    await expect(composer).toBeEditable({ timeout: 30_000 });
    await composer.fill(text);
    await composer.press('Enter');
    await expect.poll(() => planner.requests(), { timeout: 30_000 }).toBeGreaterThan(before);
    planner.release();
    await expect(editor).toContainText('on purpose', { timeout: 60_000 });
    await expect(bubbles(editor, text)).toHaveCount(1);
  });

  await test.step('Try Again: the retried turn runs, and the message is drawn once', async () => {
    planner.hold();
    const before = planner.requests();
    await editor.getByRole('button', { name: 'Try Again' }).click();
    await expect.poll(() => planner.requests(), { timeout: 30_000 }).toBeGreaterThan(before);
    await holdsFor(3_000, async () => await bubbles(editor, text).count() === 1, `one bubble for "${text}" while its retried turn runs`);
  });

  await test.step('opened again while the retried turn runs, the session draws the message once', async () => {
    await reopened(current, text);
    planner.release();
  });
}

/** Opens another session and then this one again from the sidebar: its message is drawn once. */
async function reopened(current: FirstRun, text: string): Promise<void> {
  const { win, editor } = current;
  const sidebar = await sessionsSidebar(win);
  const row = sidebar.getByRole('button', { name: new RegExp(escapeRegExp(GOAL)) });
  await win.getByRole('button', { name: 'New session' }).first().click();
  await expect(row).not.toHaveAttribute('aria-current', 'true');
  await expect(bubbles(editor, text)).toHaveCount(0);
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true', { timeout: 30_000 });
  await expect(bubbles(editor, text)).toHaveCount(1, { timeout: 30_000 });
  await holdsFor(2_000, async () => await bubbles(editor, text).count() === 1, `one bubble for "${text}" once the session is open again`);
}

test('Try Again on a failed first message draws and saves that message once', async () => {
  run = await startFirstRun('ordewell-firstrun-tryagain-first-', { planner: { held: true } });
  const current = run;
  const { win, editor, workspace } = current;
  const planner = current.planner!;
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });

  await failThenTryAgain(current, planner, GOAL);

  await test.step('the plan lands, and the goal is still drawn and saved once', async () => {
    await expect(planPanel.getByRole('button', { name: PLANNED })).toBeVisible({ timeout: 60_000 });
    await holdsFor(2_000, async () => await bubbles(editor, GOAL).count() === 1, 'one bubble for the goal once its plan landed');
    await expect.poll(() => savedTimes(workspace, GOAL), { timeout: 30_000 }).toEqual([1]);
  });

  await test.step('opened again, the session draws the goal once', async () => {
    await reopened(current, GOAL);
  });
});

test('Try Again on a failed later message draws and saves that message once', async () => {
  run = await startFirstRun('ordewell-firstrun-tryagain-later-', { planner: { held: false } });
  const current = run;
  const { win, editor, composer, workspace } = current;
  const planner = current.planner!;
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });

  await test.step('the first message drafts a plan, drawn once while its turn runs and once the session is opened again', async () => {
    planner.hold();
    await composer.fill(GOAL);
    await composer.press('Enter');
    await expect.poll(() => planner.requests(), { timeout: 30_000 }).toBeGreaterThan(0);
    await holdsFor(2_000, async () => await bubbles(editor, GOAL).count() === 1, 'one bubble for the goal while its turn runs');
    await reopened(current, GOAL);
    planner.release();
    await expect(planPanel.getByRole('button', { name: PLANNED })).toBeVisible({ timeout: 60_000 });
    await expect(bubbles(editor, GOAL)).toHaveCount(1);
  });

  await failThenTryAgain(current, planner, LATER);

  await test.step('the retried turn lands, and the message is still drawn and saved once', async () => {
    await expect(editor).toContainText(LATER_ANSWER, { timeout: 60_000 });
    await holdsFor(2_000, async () => await bubbles(editor, LATER).count() === 1, 'one bubble for the later message once its turn landed');
    await expect.poll(() => savedTimes(workspace, LATER), { timeout: 30_000 }).toEqual([1]);
    await expect(bubbles(editor, GOAL)).toHaveCount(1);
  });

  await test.step('opened again, the session draws each message once', async () => {
    await reopened(current, LATER);
    await expect(bubbles(editor, GOAL)).toHaveCount(1);
  });
});
