import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';

/*
 * Machine B's first run (slug stateDirIgnore): a fresh two-file project, and
 * Ordewell's state directory beside it. The user ran `git status` after their
 * first session and found `.ordewell/` listed, though nothing in it was theirs
 * to commit. Decided: the state directory shows in `git status` only for what
 * is meant to be committed, a project skill, and the rules file that earlier
 * builds wrote is upgraded where nobody made it theirs.
 */

/** What 0.14.11 and the builds before it wrote, the rules file itself carved out. */
const PREVIOUS_IGNORE = '*\n!.gitignore\n!skills/\n!skills/**\n';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A git hook that runs the suite exports GIT_DIR & co., which would point every
// fixture command at the outer repository instead of the temp one.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...rel.split('/')), content);
}

/** Every path `git status` lists, one per file, in git's own forward-slash spelling. */
const statusPaths = (repo: string): string[] =>
  git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((line) => line.slice(3));

let repo = '';
const ignoreFile = (): string => path.join(repo, '.ordewell', '.gitignore');

/** The fresh project of machine B: hello.py and a README, committed. */
function freshProject(): void {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'hello.py', 'print("hello")\n');
  write(repo, 'README.md', '# hello\n\nSays hello.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
}

/** Ordewell saves its first state here: a session of a drafted plan for the goal. */
function firstSave(): void {
  const plan: LegacyPlanState = {
    status: 'draft',
    runners: ['claude-code'],
    generatedAt: '2026-11-24T09:00:00.000Z',
    lastUpdated: '2026-11-24T09:00:00.000Z',
    tasks: [createTask({ id: 't1', order: 1, title: 'Add --shout', prompt: 'add --shout', assignedRunner: 'claude-code' })],
    conversationHistory: [{ role: 'user', content: 'Add a --shout option to hello.py', timestamp: '2026-11-24T08:59:00.000Z' }],
  };
  saveSession(plan, 'Add a --shout option to hello.py that prints the greeting in upper case, with a test', repo, 'first-session');
}

beforeEach(() => {
  // Each test its own directory: the session store checks a state directory's rules once per process.
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-firstrun-b-ignore-')));
  if (hasGit) freshProject();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('machine B: the state directory in a fresh project', () => {
  it('is not listed by git status at all after Ordewell first saves state', () => {
    firstSave();

    expect(fs.existsSync(path.join(repo, '.ordewell', 'sessions'))).toBe(true);
    expect(statusPaths(repo).filter((p) => p.startsWith('.ordewell'))).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).not.toContain('.ordewell');
  });

  it('shows only a skill\'s own files once a skill is added under .ordewell/skills/', () => {
    firstSave();
    write(repo, '.ordewell/skills/pr-style/SKILL.md', '---\nname: pr-style\ndescription: How we word pull requests\n---\nKeep it short.\n');
    write(repo, '.ordewell/skills/pr-style/examples.md', 'An example.\n');

    expect(statusPaths(repo).filter((p) => p.startsWith('.ordewell')).sort()).toEqual([
      '.ordewell/skills/pr-style/SKILL.md',
      '.ordewell/skills/pr-style/examples.md',
    ]);
  });
});

describe.skipIf(!hasGit)('machine B: a rules file an earlier build wrote', () => {
  it('is upgraded in place when it is exactly the previously generated text and git does not track it', () => {
    write(repo, '.ordewell/.gitignore', PREVIOUS_IGNORE);
    expect(statusPaths(repo)).toContain('.ordewell/.gitignore');

    firstSave();

    expect(fs.readFileSync(ignoreFile(), 'utf8')).not.toBe(PREVIOUS_IGNORE);
    expect(statusPaths(repo).filter((p) => p.startsWith('.ordewell'))).toEqual([]);
  });

  it('is left as it is when git tracks it, even with the previously generated text', () => {
    write(repo, '.ordewell/.gitignore', PREVIOUS_IGNORE);
    git(repo, 'add', '.ordewell/.gitignore');
    git(repo, 'commit', '-q', '-m', 'track the rules');

    firstSave();

    expect(fs.readFileSync(ignoreFile(), 'utf8')).toBe(PREVIOUS_IGNORE);
    expect(statusPaths(repo)).toEqual([]);
  });

  it('is left as it is when the user customised it', () => {
    const customised = `${PREVIOUS_IGNORE}!plans/\n`;
    write(repo, '.ordewell/.gitignore', customised);

    firstSave();

    expect(fs.readFileSync(ignoreFile(), 'utf8')).toBe(customised);
  });
});
