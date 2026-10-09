import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureStateDirIgnored, STATE_DIR_IGNORE } from '../fsHelpers';

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

let tmpDir = '';
const ignorePath = (): string => path.join(tmpDir, '.ordewell', '.gitignore');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-fshelpers-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureStateDirIgnored', () => {
  it('writes the ignore file with the skills carve-out', () => {
    ensureStateDirIgnored(tmpDir);
    expect(fs.readFileSync(ignorePath(), 'utf8')).toBe('*\n!.gitignore\n!skills/\n!skills/**\n');
  });

  it.each(['*\n', '*'])('upgrades the legacy match-everything rule %j', (legacy) => {
    write(tmpDir, '.ordewell/.gitignore', legacy);
    ensureStateDirIgnored(tmpDir);
    expect(fs.readFileSync(ignorePath(), 'utf8')).toBe(STATE_DIR_IGNORE);
  });

  it.each(['*\n\n', '# mine\n*\n', 'sessions/\n'])('leaves a customised ignore file %j untouched', (custom) => {
    write(tmpDir, '.ordewell/.gitignore', custom);
    ensureStateDirIgnored(tmpDir);
    expect(fs.readFileSync(ignorePath(), 'utf8')).toBe(custom);
  });

  it.skipIf(!hasGit)('tracks .ordewell/skills and the ignore file, and ignores the rest of the state directory', () => {
    git(tmpDir, 'init', '-q', '-b', 'main');
    ensureStateDirIgnored(tmpDir);
    write(tmpDir, '.ordewell/skills/x/SKILL.md', '---\nname: x\n---\n\nBody.\n');
    write(tmpDir, '.ordewell/skills/x/notes/extra.md', 'More.\n');
    write(tmpDir, '.ordewell/sessions/s.json', '{}');
    write(tmpDir, '.ordewell/sessions/skills/y/SKILL.md', 'nested\n');
    write(tmpDir, '.ordewell/worktrees/run/task/README.md', 'hi\n');

    const untracked = git(tmpDir, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.slice(3)).sort();
    expect(untracked).toEqual([
      '.ordewell/.gitignore',
      '.ordewell/skills/x/SKILL.md',
      '.ordewell/skills/x/notes/extra.md',
    ]);
  });
});
