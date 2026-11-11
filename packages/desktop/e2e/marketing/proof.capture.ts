/**
 * The capture tool's own proof, and the pattern a shot list follows: the
 * welcome window and the workspace's Git view as stills, in both themes at
 * every still size, one region of the Git view, and a short video that starts a
 * session, types a goal and opens the Git view, with the typing sped up under
 * its badge. MARKETING_ONLY=stills or =video runs one of the two.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, type Sandbox } from '../fixtures';
import { cut, encode } from './edit';
import { VIDEOS } from './manifest';
import { commitAgo, openStudio, recordTake, seedRecents, speedBadge, STILL_SIZES, THEMES, VIDEO_SIZE, type Studio } from './studio';

const only = process.env.MARKETING_ONLY;

/** A small product repository under ~/code, with a history that reads as a week's work, and two more recent folders beside it. */
function demoProject(): { sandbox: Sandbox; repo: string } {
  const sandbox = makeSandbox('ordewell-marketing-');
  const code = path.join(sandbox.home, 'code');
  const repo = path.join(code, 'acme-web');
  const run = (...args: string[]): void => { execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, HOME: sandbox.home } }); };
  fs.mkdirSync(repo, { recursive: true });
  run('init', '-q');
  commitAgo(sandbox, repo, 7 * 24 * 60, 'README.md', 'Start the Acme web app', '# acme-web\n');
  commitAgo(sandbox, repo, 5 * 24 * 60, 'src/app.ts', 'Add the app shell with routing and a health check');
  commitAgo(sandbox, repo, 3 * 24 * 60, 'src/auth.ts', 'Sign users in with email links');
  run('checkout', '-qb', 'feature/sso');
  commitAgo(sandbox, repo, 2 * 24 * 60, 'src/sso.ts', 'Add SAML single sign-on for workspace admins');
  commitAgo(sandbox, repo, 26 * 60, 'src/sso.ts', 'Map SAML groups to workspace roles');
  run('checkout', '-q', 'main');
  commitAgo(sandbox, repo, 5 * 60, 'docs/setup.md', 'Document the local setup');
  commitAgo(sandbox, repo, 95, 'src/billing.ts', 'Charge annual plans in the customer’s currency');
  run('branch', 'fix/login-redirect');
  for (const other of ['billing-service', 'design-tokens']) {
    fs.mkdirSync(path.join(code, other), { recursive: true });
    execFileSync('git', ['-C', path.join(code, other), 'init', '-q'], { env: { ...process.env, HOME: sandbox.home } });
  }
  seedRecents(sandbox, [
    { path: repo, minutes: 40, branch: 'main' },
    { path: path.join(code, 'billing-service'), minutes: 26 * 60, branch: 'main' },
    { path: path.join(code, 'design-tokens'), minutes: 6 * 24 * 60, branch: 'main' },
  ]);
  return { sandbox, repo };
}

async function gitView(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('tab', { name: 'Git' }).click();
  await expect(page.getByRole('navigation', { name: 'Git' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Git' }).getByText('Map SAML groups to workspace roles').or(page.getByRole('navigation', { name: 'Git' }).getByText('main', { exact: true })).first()).toBeVisible();
}

test('stills: welcome and the Git view, both themes, every size, at 2x', async () => {
  test.skip(only === 'video', 'MARKETING_ONLY=video');
  const { sandbox, repo } = demoProject();
  let studio: Studio | undefined;
  try {
    studio = await openStudio({ scale: 2, sandbox });
    const welcome = await studio.welcome();
    await expect(welcome.getByText('acme-web').first()).toBeVisible();
    for (const theme of THEMES) {
      await studio.setTheme(welcome, theme);
      for (const size of STILL_SIZES) await studio.still(welcome, { view: 'welcome', theme, size });
    }
    const workspace = await studio.openFolder(repo);
    await studio.present(workspace, STILL_SIZES[0]);
    await gitView(workspace);
    for (const theme of THEMES) {
      await studio.setTheme(workspace, theme);
      for (const size of STILL_SIZES) await studio.still(workspace, { view: 'git', theme, size });
      await studio.still(workspace, { view: 'git', theme, size: STILL_SIZES[0], region: { name: 'sidebar', locator: workspace.getByRole('navigation', { name: 'Git' }) } });
    }
  } finally {
    await studio?.close();
  }
});

test('video: start a session, type a goal, open the Git view', async () => {
  test.skip(only === 'stills', 'MARKETING_ONLY=stills');
  const { sandbox, repo } = demoProject();
  let studio: Studio | undefined;
  try {
    studio = await openStudio({ scale: 1, sandbox });
    const page = await studio.openFolder(repo);
    await studio.present(page, VIDEO_SIZE);
    await studio.setTheme(page, 'dark');
    const badge = await speedBadge(studio, 3, path.join(VIDEOS, 'badge-3x.png'));
    const master = path.join(VIDEOS, 'open-git-view.master.mkv');
    const take = await recordTake(studio, page, master, async (hand, mark) => {
      await hand.wait(600);
      await hand.click(page.getByRole('button', { name: 'New session' }));
      const box = page.getByRole('textbox', { name: 'Message the planner' });
      await expect(box).toBeVisible();
      await hand.click(box, 500);
      mark('typing');
      await hand.type('Add SAML single sign-on for workspace admins, with group-to-role mapping.');
      mark('typed');
      await hand.wait(500);
      await hand.click(page.getByRole('navigation', { name: 'Views' }).getByRole('tab', { name: 'Git' }), 900);
      await expect(page.getByRole('navigation', { name: 'Git' })).toBeVisible();
      await hand.wait(1800);
    });
    const { typing, typed, end } = take.marks;
    const edited = await cut(master, {
      segments: [
        { from: 0, to: typing + 1.2 },
        { from: typing + 1.2, to: typed - 0.6, speed: 3 },
        { from: typed - 0.6, to: end },
      ],
      fade: 0.4,
      badges: { 3: badge },
    }, path.join(VIDEOS, 'open-git-view.cut.mkv'));
    expect(edited.duration).toBeGreaterThanOrEqual(5);
    expect(edited.duration).toBeLessThanOrEqual(10);
    await encode(edited.file, { name: 'open-git-view', view: 'workspace: new session, then Git', theme: 'dark', size: VIDEO_SIZE, posterAt: edited.duration - 1 });
    // The master and the cut are lossless and large; what ships is encoded.
    if (!process.env.MARKETING_KEEP_MASTERS) for (const file of [master, edited.file, badge]) fs.rmSync(file, { force: true });
  } finally {
    await studio?.close();
  }
});
