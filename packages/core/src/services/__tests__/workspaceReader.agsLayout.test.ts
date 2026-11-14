import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * A parent folder like a reported "ags-repos", no repository itself, holding
 * four repositories and many ordinary folders. The desktop Explorer asks for
 * repo "." there; the reader must list the folder, and must never answer
 * `No repository "." in this workspace`, as a contract-2 daemon's reader did
 * (the reason `DAEMON_CONTRACT` is 3).
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
function repo(root: string, files: Record<string, string>, commit = true): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
  if (!commit) return;
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

const REPOS = ['ags', 'ags-website-public', 'ags2', 'old-website'];
const PLAIN = ['assets', 'backups', 'design', 'docs', 'exports', 'node_modules', 'scripts', 'tmp', '.vscode', 'Old Stuff'];

describe.skipIf(!hasGit)('workspace reader on an ags-repos-like folder', () => {
  let tmp: string;
  let parent: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-ags-')));
    parent = path.join(tmp, 'ags-repos');
    repo(path.join(parent, 'ags'), { 'README.md': 'ags\n', '.gitignore': 'dist/\n' });
    repo(path.join(parent, 'ags-website-public'), { 'index.html': '<p/>\n' });
    repo(path.join(parent, 'ags2'), { 'main.ts': 'x\n' });
    repo(path.join(parent, 'old-website'), { 'old.html': 'old\n' }, false); // no commit yet
    fs.mkdirSync(path.join(parent, 'ags', 'dist'));
    for (const d of PLAIN) { fs.mkdirSync(path.join(parent, d)); fs.writeFileSync(path.join(parent, d, 'f.txt'), `${d}\n`); }
    fs.writeFileSync(path.join(parent, 'notes.md'), 'notes\n');
    fs.writeFileSync(path.join(parent, '.DS_Store'), '\0\0');
    // A junction on Windows, which needs no privilege; the type is ignored elsewhere.
    fs.symlinkSync(path.join(parent, 'docs'), path.join(parent, 'docs-link'), 'junction');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const [label, workspaceRepos] of [['auto-detected', []], ['listed in workspaceRepos', REPOS]] as const) {
    describe(label, () => {
      const reader = createWorkspaceReader({ config: { workspaceRepos: [...workspaceRepos] } });

      it('control: git.repos names exactly the four repositories', async () => {
        expect((await reader.repos(parent)).repos.map((r) => r.repo)).toEqual(REPOS);
      });

      it('lists the folder for repo "." with its four repositories and ordinary folders', async () => {
        const tree = await reader.tree({ workspace: parent, repo: '.' }, '');
        const names = tree.entries.map((e) => e.name);
        for (const r of REPOS) expect(tree.entries.find((e) => e.name === r)?.kind).toBe('repository');
        for (const d of ['assets', 'design', 'docs', 'Old Stuff']) expect(names).toContain(d);
        expect(names).toContain('notes.md');
      });

      it('reads into an ordinary folder, a repository below, and a loose file for repo "."', async () => {
        expect((await reader.tree({ workspace: parent, repo: '.' }, 'Old Stuff')).entries.map((e) => e.name)).toEqual(['f.txt']);
        const inRepo = await reader.tree({ workspace: parent, repo: '.' }, 'ags');
        expect(inRepo.entries.find((e) => e.name === 'dist')?.ignored).toBe(true);
        expect((await reader.tree({ workspace: parent, repo: '.' }, 'old-website')).entries.map((e) => e.name)).toContain('old.html');
        expect(await reader.content({ workspace: parent, repo: '.' }, 'notes.md')).toMatchObject({ kind: 'text', text: 'notes\n' });
      });

      it('finds by name across the folder and its repositories for repo "."', async () => {
        const found = await reader.find({ workspace: parent, repo: '.' }, { query: 'html' });
        expect(found.matches.map((m) => m.path)).toEqual(expect.arrayContaining(['ags-website-public/index.html']));
      });

      it('never answers the pre-feature refusal for repo "."', async () => {
        await expect(reader.tree({ workspace: parent, repo: '.' }, '')).resolves.toBeDefined();
        // A git read of "." is refused, but with the folder's own words, not `No repository "."`.
        await expect(reader.status({ workspace: parent, repo: '.' })).rejects.toThrow(/workspace folder is not a repository/);
      });

      it('control: an unknown repository is still refused by name', async () => {
        await expect(reader.tree({ workspace: parent, repo: 'nope' }, '')).rejects.toThrow('No repository "nope" in this workspace: it has "ags", "ags-website-public", "ags2", "old-website".');
      });
    });
  }
});
