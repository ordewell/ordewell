/**
 * Typing `/` in the composer lists the workspace's user-invocable skills by
 * name, each with its description, beside the built-in commands (docs/skills.md):
 * the workspace's own `.ordewell/skills/`, and in a folder of several git
 * repositories (a repo group) each repository's too. A skill marked
 * `user-invocable: false` is a model's alone and is not listed.
 */
import { expect, test, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Sandbox } from './fixtures';
import { startFirstRun, type FirstRun } from './firstRunHarness';

interface Skill { readonly name: string; readonly description: string; readonly userInvocable?: false }

const WORKSPACE_SKILL: Skill = { name: 'release-notes', description: 'Draft release notes from the changes merged since the last tag.' };
const HIDDEN_SKILL: Skill = { name: 'index-for-planner', description: 'Index the repository for the planner alone.', userInvocable: false };
const GROUP_SKILL: Skill = { name: 'group-style', description: 'Follow the house style shared by every repository here.' };
const CHILD_SKILL: Skill = { name: 'api-contract', description: 'Check the HTTP contract before changing a route.' };
const CHILD_HIDDEN: Skill = { name: 'web-internal', description: 'Internal notes for the planner on the web client.', userInvocable: false };
/** Built-in commands the list offers beside the skills (packages/ui/src/shared/slashCommands.ts). */
const BUILT_INS = ['/help', '/sessions'];

let run: FirstRun | undefined;

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await run?.finish(testInfo);
  run = undefined;
});

function writeSkill(root: string, skill: Skill): void {
  const dir = path.join(root, '.ordewell', 'skills', skill.name);
  fs.mkdirSync(dir, { recursive: true });
  const invocable = skill.userInvocable === false ? 'user-invocable: false\n' : '';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n${invocable}---\n\nDo what the description says.\n`);
}

function gitIn(sandbox: Sandbox, dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, env: { ...process.env, HOME: sandbox.home }, stdio: 'ignore' });
}

/** A repository with one commit holding `skills`, committed as a team shares them. */
function repoWith(sandbox: Sandbox, dir: string, skills: readonly Skill[]): void {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(sandbox, dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  for (const skill of skills) writeSkill(dir, skill);
  gitIn(sandbox, dir, 'add', '.');
  gitIn(sandbox, dir, 'commit', '-qm', 'init');
}

/** Types `/` into an empty composer and returns the suggestion list it opens. */
async function slashList(current: FirstRun): Promise<Locator> {
  await expect(current.composer).toBeEditable();
  await current.composer.fill('');
  await current.composer.pressSequentially('/');
  // The list has no role of its own: its class is the one hook.
  const list = current.editor.locator('.slash-suggestions');
  await expect(list).toBeVisible();
  return list;
}

async function expectListed(list: Locator, skill: Skill): Promise<void> {
  await expect(list, `/${skill.name} is listed`).toContainText(`/${skill.name}`);
  await expect(list).toContainText(skill.description);
}

async function expectBuiltIns(list: Locator): Promise<void> {
  for (const command of BUILT_INS) await expect(list, `${command} is listed`).toContainText(command);
}

test('`/` lists the workspace\'s user-invocable skill with its description beside the built-ins', async () => {
  run = await startFirstRun('ordewell-firstrun-skills-', {
    workspace: (sandbox) => {
      writeSkill(sandbox.repo, WORKSPACE_SKILL);
      writeSkill(sandbox.repo, HIDDEN_SKILL);
      gitIn(sandbox, sandbox.repo, 'add', '.');
      gitIn(sandbox, sandbox.repo, 'commit', '-qm', 'Add skills');
      return sandbox.repo;
    },
  });
  const list = await slashList(run);
  await expectBuiltIns(list);
  await expectListed(list, WORKSPACE_SKILL);
  await expect(list).not.toContainText(`/${HIDDEN_SKILL.name}`);
});

test('`/` in a folder of several repositories lists the folder\'s skill and each repository\'s', async () => {
  run = await startFirstRun('ordewell-firstrun-group-skills-', {
    workspace: (sandbox) => {
      const group = path.join(sandbox.tmp, 'group');
      fs.mkdirSync(group);
      writeSkill(group, GROUP_SKILL);
      repoWith(sandbox, path.join(group, 'api'), [CHILD_SKILL]);
      repoWith(sandbox, path.join(group, 'web'), [CHILD_HIDDEN]);
      return group;
    },
  });
  const list = await slashList(run);
  await expectBuiltIns(list);
  await expectListed(list, GROUP_SKILL);
  await expectListed(list, CHILD_SKILL);
  await expect(list).not.toContainText(`/${CHILD_HIDDEN.name}`);
});
