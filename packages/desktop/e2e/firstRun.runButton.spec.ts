/**
 * A drafted plan is started with Run: the title bar's button reads 'Run', and
 * nothing in the window offers 'Approve plan' (the labels are
 * src/renderer/session/primaryAction.ts's).
 */
import { expect, test } from '@playwright/test';
import { startFirstRun, type FirstRun } from './firstRunHarness';

const GOAL = 'Add greeting and farewell modules';
/** A task title of the plan bench/live's desktop-e2e persona answers GOAL with. */
const PLANNED = 'Add a greeting module';

let run: FirstRun | undefined;

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await run?.finish(testInfo);
  run = undefined;
});

test('a drafted plan\'s title-bar button reads Run, and nothing reads Approve plan', async () => {
  run = await startFirstRun('ordewell-firstrun-run-button-');
  const { win, composer } = run;
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });

  await composer.fill(GOAL);
  await composer.press('Enter');
  await expect(planPanel.getByRole('button', { name: PLANNED })).toBeVisible({ timeout: 60_000 });

  await expect(win.locator('header.frame-title').getByRole('button', { name: 'Run', exact: true })).toBeVisible({ timeout: 30_000 });
  for (const role of ['button', 'menuitem', 'link'] as const) {
    await expect(win.getByRole(role, { name: /Approve plan/i })).toHaveCount(0);
  }
  await expect(win.getByText(/Approve plan/i)).toHaveCount(0);
});

test('running the draft says the plan started, and no line says it was approved', async () => {
  run = await startFirstRun('ordewell-firstrun-run-said-');
  const { win, composer } = run;
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });

  await composer.fill(GOAL);
  await composer.press('Enter');
  await expect(planPanel.getByRole('button', { name: PLANNED })).toBeVisible({ timeout: 60_000 });
  await win.locator('header.frame-title').getByRole('button', { name: 'Run', exact: true }).click();

  await expect(win.getByText('You started the plan.')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText(/Plan approved/i)).toHaveCount(0);
});
