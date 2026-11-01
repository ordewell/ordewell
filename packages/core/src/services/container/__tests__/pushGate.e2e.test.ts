import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultExecFile, type GitInvoker } from '../../gitExec';
import { hooksLandingWouldRun, PushRefused, restoreSnapshot, takeThroughGate } from '../pushGate';

/*
 * The gate is what a hostile container meets, so it is driven with real git and
 * bundles built as a hostile container would build them. No Docker: what a
 * bundle holds is all a container controls.
 */

const GIT: GitInvoker = { exec: defaultExecFile, resolvePath: async () => process.env.PATH ?? '' };
const REF = 'refs/ordewell/export/t1-1';

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-gate-')));
  dirs.push(dir);
  return dir;
}

function identify(cwd: string): void {
  git(cwd, 'config', 'user.name', 'T');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

/** The host's repository, and the clone standing in for a container's workspace. */
function setup(): { host: string; box: string; base: string; out: string } {
  const host = tempDir();
  git(host, 'init', '-q', '-b', 'main');
  identify(host);
  writeFileSync(join(host, 'a.txt'), 'hello\n');
  git(host, 'add', '-A');
  git(host, 'commit', '-q', '-m', 'initial');
  const box = tempDir();
  git(box, 'clone', '-q', host, '.');
  identify(box);
  return { host, box, base: git(host, 'rev-parse', 'HEAD'), out: tempDir() };
}

/** A snapshot commit over what the workspace holds, on `ref`, bundled as the export script bundles it. */
function bundle(box: string, out: string, base: string, ref = REF): string {
  git(box, 'add', '-A');
  const snapshot = git(box, 'commit-tree', git(box, 'write-tree'), '-p', 'HEAD', '-m', 'snapshot');
  git(box, 'reset', '-q');
  git(box, 'update-ref', ref, snapshot);
  const file = join(out, 'work.bundle');
  git(box, 'bundle', 'create', '-q', file, ref, `^${base}`);
  return file;
}

const ticket = (base: string) => ({ ref: REF, base });

describe('the push gate (ADR-0059 L6)', () => {
  it("takes the attempt's ref and nothing else moves", async () => {
    const { host, box, base, out } = setup();
    writeFileSync(join(box, 'b.txt'), 'work\n');
    const refsBefore = git(host, 'for-each-ref');

    const taken = await takeThroughGate(GIT, host, bundle(box, out, base), ticket(base));

    expect(git(host, 'cat-file', '-p', `${taken}:b.txt`)).toBe('work');
    expect(git(host, 'for-each-ref')).toBe(refsBefore);
    expect(git(host, 'rev-parse', 'main')).toBe(base);
  });

  it('refuses another ref, whatever it is called', async () => {
    const { host, box, base, out } = setup();
    writeFileSync(join(box, 'b.txt'), 'work\n');

    for (const ref of ['refs/heads/main', 'refs/ordewell/export/t2-1']) {
      await expect(takeThroughGate(GIT, host, bundle(box, out, base, ref), ticket(base))).rejects.toBeInstanceOf(PushRefused);
    }
    expect(git(host, 'rev-parse', 'main')).toBe(base);
  });

  it("refuses a bundle holding a second ref beside the attempt's", async () => {
    const { host, box, base, out } = setup();
    writeFileSync(join(box, 'b.txt'), 'work\n');
    bundle(box, out, base);
    const file = join(out, 'two.bundle');
    git(box, 'update-ref', 'refs/heads/main', git(box, 'rev-parse', REF));
    git(box, 'bundle', 'create', '-q', file, REF, 'refs/heads/main', `^${base}`);

    await expect(takeThroughGate(GIT, host, file, ticket(base))).rejects.toThrow(/refs\/heads\/main/);
    expect(git(host, 'rev-parse', 'main')).toBe(base);
  });

  it('refuses history that does not stand on the attempt\'s base', async () => {
    const { host, box, base, out } = setup();
    git(box, 'checkout', '-q', '--orphan', 'other');
    writeFileSync(join(box, 'b.txt'), 'work\n');
    git(box, 'add', '-A');
    git(box, 'commit', '-q', '-m', 'unrelated');
    const snapshot = git(box, 'commit-tree', git(box, 'write-tree'), '-p', 'HEAD', '-m', 'snapshot');
    git(box, 'update-ref', REF, snapshot);
    const file = join(out, 'orphan.bundle');
    git(box, 'bundle', 'create', '-q', file, REF);

    await expect(takeThroughGate(GIT, host, file, ticket(base))).rejects.toThrow(/does not stand on/);
    expect(git(host, 'for-each-ref', 'refs/ordewell')).toBe('');
  });

  /** A bundle holding a tree with a `.git` directory in it. */
  function dotgitBundle({ box, base, out }: { box: string; base: string; out: string }): string {
    // `git add` will not take this path, so the tree is written as a container could write it.
    const blob = git(box, 'rev-parse', 'HEAD:a.txt');
    const hooks = execFileSync('git', ['mktree'], { cwd: box, env: env(), input: `100755 blob ${blob}\tpost-merge\n`, encoding: 'utf8' }).trim();
    const dotgit = execFileSync('git', ['mktree'], { cwd: box, env: env(), input: `040000 tree ${hooks}\thooks\n`, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['mktree'], { cwd: box, env: env(), input: `040000 tree ${dotgit}\t.git\n100644 blob ${blob}\ta.txt\n`, encoding: 'utf8' }).trim();
    const snapshot = git(box, 'commit-tree', tree, '-p', 'HEAD', '-m', 'snapshot');
    git(box, 'update-ref', REF, snapshot);
    const file = join(out, 'dotgit.bundle');
    git(box, 'bundle', 'create', '-q', file, REF, `^${base}`);
    return file;
  }

  it('refuses a tree that would write into a `.git` directory', async () => {
    const gate = setup();

    await expect(takeThroughGate(GIT, gate.host, dotgitBundle(gate), ticket(gate.base))).rejects.toBeInstanceOf(PushRefused);
    expect(git(gate.host, 'for-each-ref', 'refs/ordewell')).toBe('');
  });

  it('refuses it on a git whose fetch from a bundle checks nothing, as 2.40 and older', async () => {
    const gate = setup();
    const unchecked: GitInvoker = {
      ...GIT,
      exec: (file, args, opts) => defaultExecFile(file, args.filter((arg, i) => !arg.includes('fsckObjects') && !args[i + 1]?.includes('fsckObjects')), opts),
    };

    await expect(takeThroughGate(unchecked, gate.host, dotgitBundle(gate), ticket(gate.base))).rejects.toThrow(/hasDotgit/);
    expect(git(gate.host, 'for-each-ref', 'refs/ordewell')).toBe('');
  });

  it('refuses what is not a bundle at all', async () => {
    const { host, base, out } = setup();
    const file = join(out, 'junk.bundle');
    writeFileSync(file, 'not a bundle\n');

    await expect(takeThroughGate(GIT, host, file, ticket(base))).rejects.toBeInstanceOf(PushRefused);
  });
});

describe('a snapshot restored into a host worktree', () => {
  it("fast-forwards to the attempt's commits and leaves the rest uncommitted, for Landing to commit", async () => {
    const { host, box, base, out } = setup();
    writeFileSync(join(box, 'committed.txt'), 'by the agent\n');
    git(box, 'add', '-A');
    git(box, 'commit', '-q', '-m', 'The agent commits');
    const agentCommit = git(box, 'rev-parse', 'HEAD');
    writeFileSync(join(box, 'a.txt'), 'changed\n');
    writeFileSync(join(box, 'untracked.txt'), 'new\n');
    const taken = await takeThroughGate(GIT, host, bundle(box, out, base), ticket(base));
    const worktree = join(tempDir(), 'task');
    git(host, 'worktree', 'add', '-q', '-b', 'task', worktree, base);

    await restoreSnapshot(GIT, worktree, taken, []);

    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(agentCommit);
    expect(git(worktree, 'status', '--porcelain').split('\n').map((line) => line.trim()).sort()).toEqual(['?? untracked.txt', 'M a.txt']);
    expect(readFileSync(join(worktree, 'committed.txt'), 'utf8')).toBe('by the agent\n');
  });

  it('removes what the attempt removed, and keeps what Ordewell linked in', async () => {
    const { host, box, base, out } = setup();
    git(box, 'rm', '-q', 'a.txt');
    const taken = await takeThroughGate(GIT, host, bundle(box, out, base), ticket(base));
    const worktree = join(tempDir(), 'task');
    git(host, 'worktree', 'add', '-q', '-b', 'task', worktree, base);
    writeFileSync(join(worktree, '.env'), 'linked by the bootstrap\n');
    writeFileSync(join(worktree, 'stale.txt'), 'left by an earlier restore\n');

    await restoreSnapshot(GIT, worktree, taken, ['.env']);

    expect(existsSync(join(worktree, 'a.txt'))).toBe(false);
    expect(existsSync(join(worktree, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('linked by the bootstrap\n');
  });

  it("runs none of the repository's hooks", async () => {
    const { host, box, base, out } = setup();
    writeFileSync(join(box, 'committed.txt'), 'by the agent\n');
    git(box, 'add', '-A');
    git(box, 'commit', '-q', '-m', 'The agent commits');
    const taken = await takeThroughGate(GIT, host, bundle(box, out, base), ticket(base));
    const worktree = join(tempDir(), 'task');
    git(host, 'worktree', 'add', '-q', '-b', 'task', worktree, base);
    const canary = join(out, 'hook-ran');
    mkdirSync(join(host, '.git', 'hooks'), { recursive: true });
    for (const hook of ['post-merge', 'post-checkout', 'reference-transaction']) {
      writeFileSync(join(host, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${canary}"\n`);
      chmodSync(join(host, '.git', 'hooks', hook), 0o755);
    }

    await restoreSnapshot(GIT, worktree, taken, []);

    expect(existsSync(canary)).toBe(false);
  });
});

describe('the hooks a landing would run on this host', () => {
  const executable = (file: string) => {
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  };

  it('finds none in a new repository, whose hooks are samples', async () => {
    const { host } = setup();

    await expect(hooksLandingWouldRun(GIT, host)).resolves.toEqual([]);
  });

  it("finds the repository's own, from a worktree of it", async () => {
    const { host, base } = setup();
    const worktree = join(tempDir(), 'task');
    git(host, 'worktree', 'add', '-q', '-b', 'task', worktree, base);
    mkdirSync(join(host, '.git', 'hooks'), { recursive: true });
    executable(join(host, '.git', 'hooks', 'pre-commit'));

    await expect(hooksLandingWouldRun(GIT, worktree)).resolves.toEqual(['pre-commit']);
  });

  it('finds them where `core.hooksPath` says, in a folder of the repository a task can write', async () => {
    const { host } = setup();
    mkdirSync(join(host, '.husky'));
    executable(join(host, '.husky', 'post-merge'));
    writeFileSync(join(host, '.husky', 'README.md'), 'not a hook\n');
    git(host, 'config', 'core.hooksPath', '.husky');

    await expect(hooksLandingWouldRun(GIT, host)).resolves.toEqual(['post-merge']);
  });

  it('leaves out what git would not run, and what a landing never fires', async () => {
    const { host } = setup();
    mkdirSync(join(host, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(host, '.git', 'hooks', 'pre-commit'), 'not executable\n');
    executable(join(host, '.git', 'hooks', 'pre-push'));

    await expect(hooksLandingWouldRun(GIT, host)).resolves.toEqual([]);
  });
});
