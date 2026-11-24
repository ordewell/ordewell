/**
 * A first message the selected planner cannot take is refused before any turn
 * starts: no session comes of it, so the sidebar gains no row, and the message
 * goes back to the composer rather than staying drawn in the chat, with a
 * refusal that says what to do.
 *
 * The planner is Claude Code, installed and signed out: its `auth status`
 * says nobody is logged in (firstRunHarness.ts, signedOutClaude), so the daemon
 * records it signed out, and any turn it is asked to run is logged.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { daemonCall, escapeRegExp, holdsFor, savedSessions, sessionsSidebar, signedOutClaude, startFirstRun, type FirstRun } from './firstRunHarness';

const MESSAGE = 'Add a greeting module';

let run: FirstRun | undefined;
let turns = '';

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await run?.finish(testInfo);
  run = undefined;
});

/** Whether the daemon has Claude Code's login verdict as signed out, which is what refuses a turn. */
async function signedOut(current: FirstRun): Promise<boolean> {
  const answer = await daemonCall(current.sandbox, current.daemonPort, '/api/runners').catch(() => undefined) as
    { runners?: Array<{ id?: string; auth?: { state?: string } }> } | undefined;
  return answer?.runners?.some((r) => r.id === 'claude-code' && r.auth?.state === 'signed-out') ?? false;
}

test('a first message to a signed-out planner is refused before any turn, and handed back', async () => {
  run = await startFirstRun('ordewell-firstrun-refused-', {
    noProvider: true,
    env: (sandbox, base) => {
      const fake = signedOutClaude(sandbox);
      turns = fake.turns;
      return { AI_PROVIDER: 'claude-code', PATH: [fake.bin, base.PATH].join(path.delimiter) };
    },
  });
  const current = run;
  const { win, editor, composer, workspace } = current;
  const sidebar = await sessionsSidebar(win);
  const row = sidebar.getByRole('button', { name: new RegExp(escapeRegExp(MESSAGE)) });

  await test.step('the daemon knows the planner is signed out', async () => {
    await expect.poll(() => signedOut(current), { timeout: 60_000 }).toBe(true);
  });

  await test.step('send the first message', async () => {
    await expect(composer).toBeEditable();
    await composer.fill(MESSAGE);
    await composer.press('Enter');
  });

  await test.step('the refusal says what to do', async () => {
    await expect(editor).toContainText(/\/login|auth login|[Ss]ign in|[Ll]og in/, { timeout: 30_000 });
  });

  await test.step('the text is back in the composer, and not left drawn in the chat', async () => {
    await expect(composer).toHaveValue(MESSAGE);
    // A chat message has no role of its own: its class is the one hook.
    await expect(editor.locator('.chat-msg-user').filter({ hasText: MESSAGE })).toHaveCount(0);
  });

  await test.step('no session came of it: no row in the sidebar, nothing saved, and no turn ran', async () => {
    await holdsFor(5_000, async () => await row.count() === 0, 'no session row for the refused message');
    expect(savedSessions(workspace).filter((saved) => saved.includes(MESSAGE))).toEqual([]);
    const listed = JSON.stringify(await daemonCall(current.sandbox, current.daemonPort, `/api/sessions?workspace=${encodeURIComponent(workspace)}`));
    expect(listed).not.toContain(MESSAGE);
    expect(fs.existsSync(turns) ? fs.readFileSync(turns, 'utf8') : '').toBe('');
  });
});
