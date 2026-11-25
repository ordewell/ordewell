/**
 * A chat is a session from its first message: the Sessions sidebar lists it as
 * soon as the message is sent, not once the planner has answered, keeps it when
 * that first turn fails, and Stop during the first turn stops the daemon's turn.
 *
 * The planner endpoint (firstRunHarness.ts) holds each turn until the spec lets
 * it go, so "before the reply" is a state the spec holds rather than a race.
 * The sidebar reads the daemon's list again every 15 s when idle
 * (useSessionList.ts, IDLE_LIST_MS): a row that shows only at that poll is the
 * fault this spec catches, so a row must show well inside it.
 */
import { expect, test } from '@playwright/test';
import { escapeRegExp, holdsFor, savedSessions, sessionsSidebar, startFirstRun, type FirstRun } from './firstRunHarness';

const GOAL = 'Add greeting and farewell modules';
/** A task title of the plan bench/live's desktop-e2e persona answers GOAL with. */
const PLANNED = 'Add a greeting module';
const FAILURE = 'firstRun: the planner refused this turn on purpose';
/** Well inside the sidebar's 15 s idle poll. */
const PROMPTLY = 5_000;

let run: FirstRun | undefined;

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await run?.finish(testInfo);
  run = undefined;
});

test('the first message makes a selectable session row before the planner replies', async () => {
  run = await startFirstRun('ordewell-firstrun-sidebar-', { planner: { held: true } });
  const { win, editor, composer } = run;
  const planner = run.planner!;
  const sidebar = await sessionsSidebar(win);
  const row = sidebar.getByRole('button', { name: new RegExp(escapeRegExp(GOAL)) });
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });

  await test.step('send the first message: the planner is asked and holds its reply', async () => {
    await composer.fill(GOAL);
    await composer.press('Enter');
    await expect.poll(() => planner.requests(), { timeout: 30_000 }).toBeGreaterThan(0);
  });

  await test.step('the session is a row in the sidebar at once, the open one, while the planner has not replied', async () => {
    await expect(row).toBeVisible({ timeout: PROMPTLY });
    await expect(row).toBeEnabled();
    await expect(row).toHaveAttribute('aria-current', 'true');
    expect(planner.answered()).toBe(0);
    await expect(planPanel.getByRole('button', { name: PLANNED })).toHaveCount(0);
  });

  await test.step('the reply lands in that session, and the row selects it again from another', async () => {
    planner.release();
    await expect(planPanel.getByRole('button', { name: PLANNED })).toBeVisible({ timeout: 60_000 });
    await expect(row).toBeVisible();
    await win.getByRole('button', { name: 'New session' }).first().click();
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true', { timeout: 30_000 });
    await expect(editor).toContainText(GOAL, { timeout: 30_000 });
    await expect(planPanel.getByRole('button', { name: PLANNED })).toBeVisible({ timeout: 30_000 });
  });
});

test('a first turn that fails after it started leaves its row, which shows the goal and the error', async () => {
  run = await startFirstRun('ordewell-firstrun-failed-', { planner: { held: true, failWith: FAILURE } });
  const { win, editor, composer } = run;
  const planner = run.planner!;
  const sidebar = await sessionsSidebar(win);
  const row = sidebar.getByRole('button', { name: new RegExp(escapeRegExp(GOAL)) });

  await test.step('the first turn starts, then the planner fails it', async () => {
    await composer.fill(GOAL);
    await composer.press('Enter');
    await expect.poll(() => planner.requests(), { timeout: 30_000 }).toBeGreaterThan(0);
    planner.release();
    await expect(editor).toContainText('on purpose', { timeout: 60_000 });
  });

  await test.step('the failed session is still a row in the sidebar', async () => {
    await expect(row).toBeVisible({ timeout: PROMPTLY });
  });

  await test.step('selecting it from another session shows its goal and the error', async () => {
    await win.getByRole('button', { name: 'New session' }).first().click();
    await expect(editor).not.toContainText('on purpose');
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true', { timeout: 30_000 });
    await expect(editor).toContainText(GOAL, { timeout: 30_000 });
    await expect(editor).toContainText('on purpose');
  });
});

test('Stop during the first turn stops the daemon\'s turn, which never completes later by itself', async () => {
  run = await startFirstRun('ordewell-firstrun-stop-', { planner: { held: true } });
  const { win, editor, composer, workspace } = run;
  const planner = run.planner!;
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });

  await test.step('the first turn starts and the planner holds its reply', async () => {
    await composer.fill(GOAL);
    await composer.press('Enter');
    await expect.poll(() => planner.requests(), { timeout: 30_000 }).toBeGreaterThan(0);
  });

  await test.step('Stop the turn from the composer', async () => {
    // The send button turns into the turn's Stop while a turn is in flight.
    await editor.locator('.chat-input').getByRole('button', { name: /^Stop/ }).click();
    await expect(composer).toBeEditable({ timeout: 30_000 });
  });

  await test.step('the planner would reply now: the stopped turn does not complete', async () => {
    planner.release();
    const noPlan = async (): Promise<boolean> => (
      !savedSessions(workspace).some((saved) => saved.includes(PLANNED))
      && await planPanel.getByRole('button', { name: PLANNED }).count() === 0
      && await editor.getByText(PLANNED).count() === 0
    );
    await holdsFor(15_000, noPlan, `no plan for the stopped first turn, in the window or saved (the daemon's turn was ${planner.abandoned() > 0 ? 'abandoned' : 'still waiting on the planner'})`);
  });
});
