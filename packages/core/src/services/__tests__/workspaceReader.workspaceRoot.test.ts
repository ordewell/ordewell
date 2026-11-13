import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUserGit } from '../userGitActions';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * Reproduction (plan task 14): a parent folder that is not itself a git
 * repository holds plain folders, a loose file and two repositories. The
 * Explorer's default view is that folder ("."), so the reader must list it.
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });

function repo(root: string, files: Record<string, string>): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!hasGit)('workspace reader on a folder of repositories (workspace root)', () => {
  let tmp: string;
  let parent: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-root-')));
    parent = path.join(tmp, 'parent');
    repo(path.join(parent, 'api'), { 'x.txt': 'x\n' });
    repo(path.join(parent, 'web'), { 'y.txt': 'y\n' });
    fs.mkdirSync(path.join(parent, 'docs'));
    fs.writeFileSync(path.join(parent, 'docs', 'guide.md'), '# Guide\n');
    fs.writeFileSync(path.join(parent, 'notes.md'), 'notes\n');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside\n');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('control: git.repos names only the two repositories', async () => {
    expect((await reader.repos(parent)).repos.map((r) => r.repo)).toEqual(['api', 'web']);
  });

  it('lists the workspace folder itself, plain folders and repositories alike, for repo "."', async () => {
    const tree = await reader.tree({ workspace: parent, repo: '.' }, '');
    expect(tree.entries.map((e) => [e.name, e.kind])).toEqual([
      ['api', 'repository'], ['docs', 'directory'], ['web', 'repository'], ['notes.md', 'file'],
    ]);
  });

  it('reads a plain folder and a loose file at the workspace root for repo "."', async () => {
    expect((await reader.tree({ workspace: parent, repo: '.' }, 'docs')).entries.map((e) => e.name)).toEqual(['guide.md']);
    expect(await reader.content({ workspace: parent, repo: '.' }, 'notes.md')).toMatchObject({ kind: 'text', text: 'notes\n' });
  });

  it('control: still refuses traversal out of the workspace root', async () => {
    await expect(reader.content({ workspace: parent, repo: '.' }, '../secret.txt')).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('control: an individual repository still reads', async () => {
    expect((await reader.tree({ workspace: parent, repo: 'api' }, '')).entries.map((e) => e.name)).toEqual(['x.txt']);
  });
  it('marks what a repository ignores below it, and nothing at the folder that has no rules', async () => {
    fs.writeFileSync(path.join(parent, 'api', '.gitignore'), 'build/\n');
    fs.mkdirSync(path.join(parent, 'api', 'build'));
    fs.writeFileSync(path.join(parent, 'build.log'), 'log\n');
    const below = await reader.tree({ workspace: parent, repo: '.' }, 'api');
    expect(below.entries.find((e) => e.name === 'build')).toMatchObject({ kind: 'directory', ignored: true });
    expect(below.entries.find((e) => e.name === 'x.txt')?.ignored).toBeFalsy();
    const top = await reader.tree({ workspace: parent, repo: '.' }, '');
    expect(top.entries.every((e) => !e.ignored)).toBe(true);
  });

  it('finds by name across the loose files and every repository, each path from the workspace folder', async () => {
    fs.writeFileSync(path.join(parent, 'api', 'guide.txt'), 'g\n');
    const found = await reader.find({ workspace: parent, repo: '.' }, { query: 'guide' });
    expect(found.matches.map((m) => m.path).sort()).toEqual(['api/guide.txt', 'docs/guide.md']);
    expect(found.truncated).toBe(false);
  });

  it('finds text in loose files and repositories, never what is outside, never what git ignores, never node_modules', async () => {
    fs.writeFileSync(path.join(parent, 'api', 'x.txt'), 'needle in api\n');
    fs.writeFileSync(path.join(parent, 'api', '.gitignore'), 'skip.txt\n');
    fs.writeFileSync(path.join(parent, 'api', 'skip.txt'), 'needle ignored\n');
    fs.mkdirSync(path.join(parent, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'node_modules', 'dep', 'index.js'), 'needle\n');
    fs.writeFileSync(path.join(parent, 'docs', 'guide.md'), '# Guide\nA NEEDLE here\n');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'needle outside\n');
    fs.writeFileSync(path.join(parent, 'blob.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    const found = await reader.find({ workspace: parent, repo: '.' }, { query: 'needle', text: true });
    expect(found.mode).toBe('text');
    expect(found.matches.map((m) => [m.path, m.line])).toEqual([['docs/guide.md', 2], ['api/x.txt', 1]]);
  });

  it('caps a folder search at its limit and says it stopped short', async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(parent, `hit-${i}.md`), 'x\n');
    const found = await reader.find({ workspace: parent, repo: '.' }, { query: 'hit-', limit: 3 });
    expect(found.matches).toHaveLength(3);
    expect(found.truncated).toBe(true);
  });

  it('refuses the git of a folder that is no repository, and its integration and task scopes', async () => {
    const folder = { workspace: parent, repo: '.' };
    for (const read of [reader.status(folder), reader.log(folder, {}), reader.branches(folder), reader.diff(folder, {})]) {
      await expect(read).rejects.toMatchObject({ code: 'refused' });
    }
    await expect(reader.tree({ ...folder, scope: 'integration' }, '')).rejects.toMatchObject({ code: 'refused' });
    await expect(reader.tree({ ...folder, scope: 'task', taskId: 't' }, '')).rejects.toMatchObject({ code: 'refused' });
  });

  it('control: naming no repository in a folder of several is still refused', async () => {
    await expect(reader.tree({ workspace: parent }, '')).rejects.toMatchObject({ code: 'refused' });
  });

  it('saves a loose file at the folder, and refuses a git action there', async () => {
    const userGit = createUserGit({ reader, landingRuns: () => [], record: () => undefined });
    const answer = await userGit.save({ workspace: parent, repo: '.' }, { path: 'notes.md', baseHash: sha256('notes\n'), text: 'edited\n' });
    expect(fs.readFileSync(path.join(parent, 'notes.md'), 'utf8')).toBe('edited\n');
    expect(answer.repo).toMatchObject({ repo: '.', branch: null });
    await expect(userGit.save({ workspace: parent, repo: '.' }, { path: '../secret.txt', baseHash: null, text: 'x' })).rejects.toThrow();
    expect(fs.readFileSync(path.join(tmp, 'secret.txt'), 'utf8')).toBe('outside\n');
    await expect(userGit.stage({ workspace: parent, repo: '.' }, { paths: ['notes.md'] })).rejects.toMatchObject({ code: 'refused' });
  });
});

describe.skipIf(!hasGit)('workspace reader on a folder that holds no repository', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-plain-')));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'main.c'), 'int main;\n');
    fs.writeFileSync(path.join(tmp, 'README'), 'read me\n');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('lists, reads and finds in the folder itself for repo "."', async () => {
    expect((await reader.repos(tmp)).repos).toEqual([]);
    const folder = { workspace: tmp, repo: '.' };
    expect((await reader.tree(folder, '')).entries.map((e) => e.name)).toEqual(['src', 'README']);
    expect(await reader.content(folder, 'src/main.c')).toMatchObject({ kind: 'text', text: 'int main;\n' });
    expect((await reader.find(folder, { query: 'read me', text: true })).matches.map((m) => m.path)).toEqual(['README']);
  });
});
