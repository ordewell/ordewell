import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { LegacyPlanState } from '../../models/Task';
import { createTask } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * The workspace reader against real repositories (ADR-0064): confinement with
 * no daemon, then each view scope. Expected values are what the files and the
 * git commands written here hold, never the reader's own computation.
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

function write(root: string, files: Record<string, string | Buffer>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

function repo(root: string, files: Record<string, string | Buffer>): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });

describe.skipIf(!hasGit)('workspace reader confinement (ADR-0064 R3)', () => {
  let tmp: string;
  let workspace: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reader-')));
    workspace = path.join(tmp, 'ws');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside\n');
    repo(workspace, {
      'src/a.ts': 'export const a = 1;\n',
      '.ordewell/skills/review/SKILL.md': '# Review\n',
      '.gitignore': 'dist/\n',
    });
    write(workspace, { '.ordewell/sessions/s1.json': '{}', 'sub/.git/config': '[core]\n' });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.each([
    ['../secret.txt'],
    ['src/../../secret.txt'],
    [''],
    ['.git/config'],
    ['sub/.git/config'],
    ['.ordewell/sessions/s1.json'],
    ['.ordewell/skills/../sessions/s1.json'],
  ])('refuses %j', async (file) => {
    await expect(reader.content({ workspace }, file)).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('refuses an absolute path, even one inside the workspace', async () => {
    await expect(reader.content({ workspace }, path.join(workspace, 'src/a.ts'))).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('reads a skill, the one part of .ordewell a person is shown', async () => {
    const read = await reader.content({ workspace }, '.ordewell/skills/review/SKILL.md');
    expect(read).toMatchObject({ kind: 'text', text: '# Review\n' });
  });

  it('refuses a symlink that leads out of the scope, and lists it as a link', async () => {
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(workspace, 'src/out.txt'));
    fs.symlinkSync(path.join(workspace, '.git'), path.join(workspace, 'src/gitdir'));
    await expect(reader.content({ workspace }, 'src/out.txt')).rejects.toMatchObject({ code: 'path_refused' });
    await expect(reader.content({ workspace }, 'src/gitdir/config')).rejects.toMatchObject({ code: 'path_refused' });
    await expect(reader.tree({ workspace }, 'src/gitdir')).rejects.toMatchObject({ code: 'path_refused' });
    const listed = await reader.tree({ workspace }, 'src');
    expect(listed.entries.find((e) => e.name === 'out.txt')).toMatchObject({ kind: 'symlink' });
  });

  it('follows a symlink that stays inside the scope', async () => {
    fs.symlinkSync('a.ts', path.join(workspace, 'src/alias.ts'));
    expect(await reader.content({ workspace }, 'src/alias.ts')).toMatchObject({ kind: 'text', text: 'export const a = 1;\n' });
  });

  it('refuses .git at any depth and lists only skills under .ordewell', async () => {
    const root = await reader.tree({ workspace }, '');
    expect(root.entries.map((e) => e.name)).not.toContain('.git');
    expect(root.entries.map((e) => e.name)).toContain('.ordewell');
    expect((await reader.tree({ workspace }, '.ordewell')).entries.map((e) => e.name)).toEqual(['skills']);
    expect((await reader.tree({ workspace }, 'sub')).entries.map((e) => e.name)).toEqual([]);
    await expect(reader.tree({ workspace }, '.git')).rejects.toMatchObject({ code: 'path_refused' });
    await expect(reader.tree({ workspace }, '.ordewell/sessions')).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('answers a missing file as not found', async () => {
    await expect(reader.content({ workspace }, 'src/none.ts')).rejects.toMatchObject({ code: 'path_not_found' });
  });
});

describe.skipIf(!hasGit)('workspace reader on the checkout (ADR-0064 R5)', () => {
  let tmp: string;
  let workspace: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reader-')));
    workspace = path.join(tmp, 'ws');
    repo(workspace, {
      'README.md': '# Hello\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/gone.ts': 'old\n',
      'img/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
      '.gitignore': 'dist/\n*.log\n',
    });
    write(workspace, { 'src/a.ts': 'export const a = 10;\n', 'src/new.ts': 'fresh\n', 'dist/out.js': 'built\n', 'debug.log': 'x\n', 'notes/todo.md': 'todo\n' });
    fs.rmSync(path.join(workspace, 'src/gone.ts'));
    write(workspace, { 'src/b.ts': 'export const b = 20;\n' });
    git(workspace, 'add', 'src/b.ts');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads a text file with its hash and names what it read', async () => {
    const read = await reader.content({ workspace }, 'src/a.ts');
    const bytes = fs.readFileSync(path.join(workspace, 'src/a.ts'));
    expect(read).toEqual({
      at: { repo: '.', scope: 'checkout', source: 'disk', commit: git(workspace, 'rev-parse', 'HEAD').trim(), branch: 'main' },
      path: 'src/a.ts', kind: 'text', text: 'export const a = 10;\n',
      hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    });
  });

  it('answers a binary file with its size and no text', async () => {
    expect(await reader.content({ workspace }, 'img/logo.png')).toMatchObject({ kind: 'binary', size: 10 });
    expect(await reader.content({ workspace }, 'img/logo.png')).not.toHaveProperty('text');
  });

  it('answers invalid UTF-8 as binary', async () => {
    write(workspace, { 'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
    expect(await reader.content({ workspace }, 'latin1.txt')).toMatchObject({ kind: 'binary', size: 4 });
  });

  it('answers a file over the cap as too large, with its size', async () => {
    const small = createWorkspaceReader({ config: { workspaceRepos: [] }, maxFileBytes: 16 });
    write(workspace, { 'big.txt': 'x'.repeat(17) });
    expect(await small.content({ workspace }, 'big.txt')).toMatchObject({ kind: 'too-large', size: 17, limit: 16 });
    expect(await small.content({ workspace }, 'README.md')).toMatchObject({ kind: 'text' });
  });

  it('lists one directory with each entry\'s git status and ignored entries marked', async () => {
    const root = await reader.tree({ workspace }, '');
    const byName = Object.fromEntries(root.entries.map((e) => [e.name, e]));
    expect(root.entries.map((e) => e.name)).toEqual(['dist', 'img', 'notes', 'src', '.gitignore', 'debug.log', 'README.md']);
    expect(byName.src).toMatchObject({ path: 'src', kind: 'directory', ignored: false, status: 'M' });
    expect(byName.notes).toMatchObject({ kind: 'directory', status: '?' });
    expect(byName.dist).toMatchObject({ kind: 'directory', ignored: true });
    expect(byName['debug.log']).toMatchObject({ kind: 'file', ignored: true });
    expect(byName['README.md'].status).toBeUndefined();
    expect(byName.img.status).toBeUndefined();

    const src = await reader.tree({ workspace }, 'src');
    expect(Object.fromEntries(src.entries.map((e) => [e.name, e.status ?? null]))).toEqual({ 'a.ts': 'M', 'b.ts': 'M', 'gone.ts': 'D', 'new.ts': '?' });
    expect(src.entries.find((e) => e.name === 'gone.ts')).toMatchObject({ path: 'src/gone.ts', kind: 'file' });
    // Nothing below a listed directory is read: one level at a time.
    expect(src.dir).toBe('src');
  });

  it('finds files by name, tracked and untracked, never ignored ones', async () => {
    const found = await reader.find({ workspace }, { query: '.TS' });
    expect(found).toMatchObject({ mode: 'name', query: '.TS', truncated: false });
    expect(found.matches.map((m) => m.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
    expect((await reader.find({ workspace }, { query: 'out.js' })).matches).toEqual([]);
  });

  it('caps what it finds and says so', async () => {
    const found = await reader.find({ workspace }, { query: 'ts', limit: 2 });
    expect(found.matches).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });

  it('finds text in files with its line', async () => {
    write(workspace, { 'notes/todo.md': 'one\nexport const b is mentioned\n' });
    const found = await reader.find({ workspace }, { query: 'EXPORT CONST B', text: true });
    expect(found.mode).toBe('text');
    expect(found.matches).toEqual([
      { path: 'notes/todo.md', line: 2, preview: 'export const b is mentioned' },
      { path: 'src/b.ts', line: 1, preview: 'export const b = 20;' },
    ]);
    expect((await reader.find({ workspace }, { query: 'built', text: true })).matches).toEqual([]);
    expect((await reader.find({ workspace }, { query: 'export', text: true, limit: 1 })).truncated).toBe(true);
  });

  it('answers the checkout\'s status as git porcelain names it', async () => {
    git(workspace, 'mv', 'README.md', 'READ.md');
    const status = await reader.status({ workspace });
    expect(status.staged).toEqual([{ path: 'READ.md', status: 'R', from: 'README.md' }, { path: 'src/b.ts', status: 'M' }]);
    expect(status.unstaged).toEqual([{ path: 'src/a.ts', status: 'M' }, { path: 'src/gone.ts', status: 'D' }]);
    expect(status.untracked).toEqual(['notes/todo.md', 'src/new.ts']);
    expect(status.conflicted).toEqual([]);
  });

  it('lists the files of a diff first, then one file\'s patch on request', async () => {
    const all = await reader.diff({ workspace }, {});
    expect(all.files).toEqual([
      { path: 'src/a.ts', status: 'M', added: 1, removed: 1 },
      { path: 'src/b.ts', status: 'M', added: 1, removed: 1 },
      { path: 'src/gone.ts', status: 'D', added: 0, removed: 1 },
    ]);
    expect(all.patch).toBeUndefined();
    const staged = await reader.diff({ workspace }, { kind: 'staged' });
    expect(staged.files.map((f) => f.path)).toEqual(['src/b.ts']);
    const unstaged = await reader.diff({ workspace }, { kind: 'unstaged' });
    expect(unstaged.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/gone.ts']);
    const one = await reader.diff({ workspace }, { path: 'src/a.ts' });
    expect(one.patch).toBe(git(workspace, 'diff', 'HEAD', '--', 'src/a.ts'));
    expect(one.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('diffs two commits and counts a binary file as binary', async () => {
    const first = git(workspace, 'rev-parse', 'HEAD').trim();
    write(workspace, { 'img/logo.png': Buffer.from([0x89, 0x00, 0x01]) });
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '-m', 'second');
    const second = git(workspace, 'rev-parse', 'HEAD').trim();
    const diff = await reader.diff({ workspace }, { from: first, to: second });
    expect(diff).toMatchObject({ from: first, to: second });
    expect(diff.files.find((f) => f.path === 'img/logo.png')).toEqual({ path: 'img/logo.png', status: 'M', added: null, removed: null });
    await expect(reader.diff({ workspace }, { from: '--output=/tmp/x' })).rejects.toMatchObject({ code: 'refused' });
    await expect(reader.diff({ workspace }, { path: '../x' })).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('answers a missing directory as not found', async () => {
    await expect(reader.tree({ workspace }, 'nowhere')).rejects.toMatchObject({ code: 'path_not_found' });
  });
});

describe.skipIf(!hasGit)('workspace reader history and branches', () => {
  let tmp: string;
  let workspace: string;
  const shas: string[] = [];

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reader-')));
    workspace = path.join(tmp, 'ws');
    shas.length = 0;
    repo(workspace, { 'a.txt': 'one\n' });
    shas.push(git(workspace, 'rev-parse', 'HEAD').trim());
    for (const n of [2, 3, 4]) {
      write(workspace, { 'a.txt': `${n}\n`, [`f${n}.txt`]: 'x\n' });
      git(workspace, 'add', '-A');
      git(workspace, 'commit', '-q', '-m', `commit ${n}`, '-m', `body ${n}`);
      shas.push(git(workspace, 'rev-parse', 'HEAD').trim());
    }
    git(workspace, 'branch', 'feature', shas[1]);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('pages the log with each commit\'s parents', async () => {
    const page = await reader.log({ workspace }, { limit: 2 });
    expect(page.commits.map((c) => c.sha)).toEqual([shas[3], shas[2]]);
    expect(page.commits[0]).toMatchObject({ parents: [shas[2]], subject: 'commit 4', author: 'Test', email: 'test@example.com' });
    expect(page.commits[0].refs).toContain('main');
    expect(page.cursor).not.toBeNull();
    const next = await reader.log({ workspace }, { limit: 2, cursor: page.cursor ?? undefined });
    expect(next.commits.map((c) => c.sha)).toEqual([shas[1], shas[0]]);
    expect(next.commits[1].parents).toEqual([]);
    expect(next.cursor).toBeNull();
  });

  it('reads the log of any ref', async () => {
    const page = await reader.log({ workspace }, { ref: 'feature' });
    expect(page).toMatchObject({ ref: 'feature', cursor: null });
    expect(page.commits.map((c) => c.sha)).toEqual([shas[1], shas[0]]);
    await expect(reader.log({ workspace }, { ref: '--all' })).rejects.toMatchObject({ code: 'refused' });
  });

  it('reads one commit: its body, its files, and one file\'s patch', async () => {
    const detail = await reader.commit({ workspace }, shas[2]);
    expect(detail.commit).toMatchObject({ sha: shas[2], parents: [shas[1]], subject: 'commit 3', body: 'body 3' });
    expect(detail.files).toEqual([
      { path: 'a.txt', status: 'M', added: 1, removed: 1 },
      { path: 'f3.txt', status: 'A', added: 1, removed: 0 },
    ]);
    expect(detail.patch).toBeUndefined();
    const one = await reader.commit({ workspace }, shas[2], 'a.txt');
    expect(one.patch).toBe(git(workspace, 'diff', shas[1], shas[2], '--', 'a.txt'));
    const root = await reader.commit({ workspace }, shas[0]);
    expect(root.files).toEqual([{ path: 'a.txt', status: 'A', added: 1, removed: 0 }]);
  });

  it('names the branches, the current one, upstream ahead and behind, and the worktrees', async () => {
    const remote = path.join(tmp, 'remote.git');
    git(tmp, 'clone', '-q', '--bare', workspace, remote);
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    git(workspace, 'reset', '-q', '--hard', shas[2]);
    write(workspace, { 'b.txt': 'new\n' });
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '-m', 'local');
    const linked = path.join(tmp, 'linked');
    git(workspace, 'worktree', 'add', '-q', linked, 'feature');

    const branches = await reader.branches({ workspace });
    expect(branches).toMatchObject({ repo: '.', current: 'main', detached: false });
    expect(branches.local.find((b) => b.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main', ahead: 1, behind: 1 });
    expect(branches.local.find((b) => b.name === 'feature')).toMatchObject({ sha: shas[1], current: false, upstream: null });
    expect(branches.remote.map((b) => b.name)).toContain('origin/main');
    expect(branches.ordewell).toEqual([]);
    // Git lists a worktree by its own name of the folder: on Windows with forward slashes, and long where the temp folder's name is 8.3 short.
    expect(branches.worktrees.every((w) => path.isAbsolute(w.path))).toBe(true);
    expect(branches.worktrees.map((w) => ({ ...w, path: fs.realpathSync.native(w.path) }))).toEqual([
      { path: fs.realpathSync.native(workspace), branch: 'main', head: git(workspace, 'rev-parse', 'HEAD').trim(), main: true },
      { path: fs.realpathSync.native(linked), branch: 'feature', head: shas[1], main: false },
    ]);
  });

  it('gives each branch its tip\'s committer date and subject, whatever characters the subject holds', async () => {
    const subjects = ['feat: "quoted" it\'s 100% $(x) `y` \\ ; | ✓ \u00e9\tnext', 'two\nlines\n\nthe body'];
    write(workspace, { 'odd.txt': '1\n' });
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '-m', subjects[0]);
    git(workspace, 'branch', 'odd');
    write(workspace, { 'odd.txt': '2\n' });
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '-m', subjects[1]);
    git(workspace, 'branch', 'folded');
    const remote = path.join(tmp, 'remote.git');
    git(tmp, 'clone', '-q', '--bare', workspace, remote);
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'fetch', '-q', 'origin');

    const branches = await reader.branches({ workspace });
    const odd = branches.local.find((b) => b.name === 'odd');
    expect(odd?.subject).toBe(subjects[0]);
    expect(odd?.date).toBe(git(workspace, 'log', '-1', '--format=%cI', 'odd').trim());
    // git folds a subject of several lines into one, so a record never spans lines.
    expect(branches.local.find((b) => b.name === 'folded')?.subject).toBe('two lines');
    expect(branches.local.find((b) => b.name === 'feature')).toMatchObject({ subject: 'commit 2', sha: shas[1] });
    expect(branches.remote.find((b) => b.name === 'origin/main')).toMatchObject({ subject: 'two lines', date: git(workspace, 'log', '-1', '--format=%cI', 'main').trim() });
    expect(branches.local.every((b) => /^\d{4}-\d\d-\d\dT/.test(b.date))).toBe(true);
  });

  it('names a workspace\'s repositories, each with its branch', async () => {
    const group = path.join(tmp, 'group');
    repo(path.join(group, 'api'), { 'x.txt': 'x\n' });
    repo(path.join(group, 'web'), { 'y.txt': 'y\n' });
    git(path.join(group, 'web'), 'checkout', '-q', '-b', 'topic');
    const repos = await reader.repos(group);
    expect(repos.repos).toEqual([
      { repo: 'api', branch: 'main', detached: false, head: git(path.join(group, 'api'), 'rev-parse', 'HEAD').trim(), upstream: null, ahead: 0, behind: 0 },
      { repo: 'web', branch: 'topic', detached: false, head: git(path.join(group, 'web'), 'rev-parse', 'HEAD').trim(), upstream: null, ahead: 0, behind: 0 },
    ]);
    await expect(reader.tree({ workspace: group }, '')).rejects.toMatchObject({ code: 'refused' });
    expect((await reader.tree({ workspace: group, repo: 'web' }, '')).entries.map((e) => e.name)).toEqual(['y.txt']);
    expect(await reader.content({ workspace: group, repo: 'api' }, 'x.txt')).toMatchObject({ at: { repo: 'api', branch: 'main' }, text: 'x\n' });
    await expect(reader.content({ workspace: group, repo: '../ws' }, 'a.txt')).rejects.toMatchObject({ code: 'refused' });
  });
});

describe.skipIf(!hasGit)('workspace reader on a run\'s scopes (ADR-0064 R2)', () => {
  let tmp: string;
  let workspace: string;
  let run: IsolationRun;
  let integration: string;
  let base: string;
  const session = 'sess-1';
  const isolation = createWorktreeIsolation({
    config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
    resolvePath: async () => process.env.PATH ?? '',
  });
  const task = (n: number) => createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: 'x' });
  const save = () => saveSession({ tasks: [task(1), task(2), task(3)], runners: ['claude-code'], status: 'approved', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, session);
  const at = (scope: 'integration' | 'task', taskId?: string) => ({ workspace, scope, sessionId: session, ...(taskId ? { taskId } : {}) });

  beforeAll(async () => {
    if (!hasGit) return;
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reader-run-')));
    workspace = path.join(tmp, 'ws');
    repo(workspace, { 'README.md': '# Run\n', 'src/a.ts': 'export const a = 1;\n' });
    run = await isolation.startRun(workspace);
    base = run.repos[0].baseRef;
    integration = run.repos[0].integrationBranch;

    const one = await isolation.prepare(task(1), run);
    write(one.cwd, { 'src/a.ts': 'export const a = 2;\n', 'src/t1.ts': 'one\n' });
    expect(await isolation.integrate(task(1), run)).toBe('merged');

    const two = await isolation.prepare(task(2), run);
    write(two.cwd, { 'src/t2.ts': 'export const two = "needle";\n' });

    const three = await isolation.prepare(task(3), run);
    write(three.cwd, { 'src/t3.ts': 'three\n' });
    git(three.cwd, 'add', '-A');
    git(three.cwd, 'commit', '-q', '-m', 'task three');
    // Pruned: its worktree went, its branch stayed.
    git(workspace, 'worktree', 'remove', '--force', three.cwd);
    save();
  });

  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads the integration branch from git objects, never the disk', async () => {
    const read = await reader.content(at('integration'), 'src/a.ts');
    expect(read).toMatchObject({
      at: { repo: '.', scope: 'integration', source: 'commit', commit: git(workspace, 'rev-parse', integration).trim(), branch: integration },
      kind: 'text', text: git(workspace, 'show', `${integration}:src/a.ts`),
    });
    // The checkout is untouched by the run.
    expect(await reader.content({ workspace }, 'src/a.ts')).toMatchObject({ text: 'export const a = 1;\n' });
  });

  it('lists the integration tree with what each task landed', async () => {
    const src = await reader.tree(at('integration'), 'src');
    expect(src.entries.map((e) => [e.name, e.status ?? null, e.taskId ?? null])).toEqual([['a.ts', 'M', 't1'], ['t1.ts', 'A', 't1']]);
    const root = await reader.tree(at('integration'), '');
    expect(root.entries.find((e) => e.name === 'src')).toMatchObject({ kind: 'directory', status: 'M' });
  });

  it('diffs the run against its base per file', async () => {
    const all = await reader.diff(at('integration'), {});
    expect(all).toMatchObject({ from: base, to: git(workspace, 'rev-parse', integration).trim() });
    const numstat = git(workspace, 'diff', '--numstat', base, integration).trim().split('\n').map((l) => l.split('\t'));
    expect(all.files.map((f) => [String(f.added), String(f.removed), f.path])).toEqual(numstat);
    const one = await reader.diff(at('integration'), { path: 'src/a.ts' });
    expect(one.patch).toBe(git(workspace, 'diff', base, integration, '--', 'src/a.ts'));
  });

  it('finds by name and text in a commit scope', async () => {
    expect((await reader.find(at('integration'), { query: 't1' })).matches).toEqual([{ path: 'src/t1.ts' }]);
    expect((await reader.find(at('integration'), { query: 'A = 2', text: true })).matches).toEqual([{ path: 'src/a.ts', line: 1, preview: 'export const a = 2;' }]);
  });

  it('reads a live task from its worktree on disk', async () => {
    const record = run.tasks.t2;
    const read = await reader.content(at('task', 't2'), 'src/t2.ts');
    expect(read).toMatchObject({ at: { scope: 'task', source: 'disk', branch: record.branch }, text: 'export const two = "needle";\n' });
    const src = await reader.tree(at('task', 't2'), 'src');
    expect(src.entries.find((e) => e.name === 't2.ts')).toMatchObject({ status: '?', taskId: 't2' });
    expect(src.entries.map((e) => e.name)).toContain('t1.ts');
    expect((await reader.find(at('task', 't2'), { query: 'needle', text: true })).matches.map((m) => m.path)).toEqual(['src/t2.ts']);
  });

  it('reads a pruned task from its branch, then answers gone once the branch is deleted too', async () => {
    const branch = run.tasks.t3.branch;
    const read = await reader.content(at('task', 't3'), 'src/t3.ts');
    expect(read).toMatchObject({ at: { scope: 'task', source: 'commit', commit: git(workspace, 'rev-parse', branch).trim(), branch }, text: 'three\n' });
    expect((await reader.tree(at('task', 't3'), 'src')).entries.find((e) => e.name === 't3.ts')).toMatchObject({ status: 'A', taskId: 't3' });
    git(workspace, 'branch', '-D', branch);
    await expect(reader.content(at('task', 't3'), 'src/t3.ts')).rejects.toMatchObject({ code: 'gone' });
  });

  it('answers gone for a session or a task it has no record of, and never falls back', async () => {
    await expect(reader.tree({ workspace, scope: 'integration', sessionId: 'nope' }, '')).rejects.toMatchObject({ code: 'gone' });
    await expect(reader.tree(at('task', 'nope'), '')).rejects.toMatchObject({ code: 'gone' });
    await expect(reader.tree({ workspace, scope: 'task', sessionId: session }, '')).rejects.toMatchObject({ code: 'refused' });
    await expect(reader.tree({ workspace, scope: 'integration' }, '')).rejects.toMatchObject({ code: 'refused' });
  });

  it('answers gone for a read-only task: Ordewell runs no git in its worktree', async () => {
    const t2 = run.tasks.t2;
    const sealed = { ...run, tasks: { ...run.tasks, t9: { ...t2, taskId: 't9', readOnly: true } } };
    saveSession({ tasks: [task(9)], runners: ['claude-code'], status: 'approved', isolation: { run: sealed, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, 'sess-ro');
    await expect(reader.tree({ workspace, scope: 'task', sessionId: 'sess-ro', taskId: 't9' }, '')).rejects.toMatchObject({ code: 'gone' });
  });

  it('caps a file read from a commit and never follows a link in one', async () => {
    const small = createWorkspaceReader({ config: { workspaceRepos: [] }, maxFileBytes: 4 });
    const size = Number(git(workspace, 'cat-file', '-s', `${integration}:src/a.ts`).trim());
    expect(await small.content(at('integration'), 'src/a.ts')).toMatchObject({ kind: 'too-large', size, limit: 4 });
    await expect(reader.content(at('integration'), 'src')).rejects.toMatchObject({ code: 'path_not_found' });
    await expect(reader.content(at('integration'), 'src/none.ts')).rejects.toMatchObject({ code: 'path_not_found' });
    await expect(reader.content(at('integration'), '.git/config')).rejects.toMatchObject({ code: 'path_refused' });
  });

  it('confines a task scope to its worktree', async () => {
    const worktree = run.tasks.t2.repos['.'].worktree;
    fs.symlinkSync(path.join(workspace, 'README.md'), path.join(worktree, 'src/escape.md'));
    try {
      await expect(reader.content(at('task', 't2'), 'src/escape.md')).rejects.toMatchObject({ code: 'path_refused' });
      await expect(reader.content(at('task', 't2'), '../README.md')).rejects.toMatchObject({ code: 'path_refused' });
    } finally {
      // The worktree is shared with the tests below, whose task diff it would join.
      fs.rmSync(path.join(worktree, 'src/escape.md'));
    }
  });

  it('links Ordewell branches and worktrees to their run and task', async () => {
    const branches = await reader.branches({ workspace });
    expect(branches.local.map((b) => b.name)).toEqual(['main']);
    expect(branches.local[0].landingFor).toContainEqual({ sessionId: session, runId: run.id });
    const byName = Object.fromEntries(branches.ordewell.map((b) => [b.name, b.owner]));
    expect(byName[integration]).toEqual({ sessionId: session, runId: run.id });
    expect(byName[run.tasks.t2.branch]).toEqual({ sessionId: session, runId: run.id, taskId: 't2' });
    const worktree = fs.realpathSync.native(run.tasks.t2.repos['.'].worktree);
    expect(branches.worktrees.find((w) => fs.realpathSync.native(w.path) === worktree)).toMatchObject({ branch: run.tasks.t2.branch, owner: { sessionId: session, runId: run.id, taskId: 't2' } });
  });

  it('reads a task\'s diff through the run\'s own task diff, names first', async () => {
    const names = await reader.taskDiff(workspace, session, 't2', { names: true });
    expect(names).toEqual({ available: true, text: 'src/t2.ts' });
    const one = await reader.taskDiff(workspace, session, 't2', { path: 'src/t2.ts' });
    expect(one.available && one.text).toContain('+export const two = "needle";');
    await expect(reader.taskDiff(workspace, 'nope', 't2', {})).rejects.toMatchObject({ code: 'gone' });
  });
});
