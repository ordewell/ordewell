// The control arm's tree fingerprint, run against a real repository whose task
// worktree lives where Ordewell puts it (<workdir>/.ordewell/worktrees/<run>/<task>).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './lib.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const fingerprint = (workdir) => execFileSync('sh', ['-c', L.TREE_FINGERPRINT_SH, 'sh', workdir], { encoding: 'utf8' }).trim();

test('an untracked file added or rewritten in a task worktree moves the fingerprint', { skip: process.platform === 'win32' && 'the fingerprint runs in the arm\'s Linux box' }, () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-fp-'));
  try {
    git(workdir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(workdir, 'a.py'), 'x = 1\n');
    git(workdir, 'add', '.');
    git(workdir, 'commit', '-q', '-m', 'base');
    const wt = path.join(workdir, '.ordewell', 'worktrees', 'run', '1-task');
    git(workdir, 'worktree', 'add', '-q', '-b', 'task', wt);

    const base = fingerprint(workdir);
    fs.mkdirSync(path.join(wt, 'pkg'));
    fs.writeFileSync(path.join(wt, 'pkg', 'new.py'), 'y = 1\n');
    const added = fingerprint(workdir);
    assert.notEqual(added, base, 'a new untracked file in the task worktree is work');
    fs.writeFileSync(path.join(wt, 'pkg', 'new.py'), 'y = 2\n');
    assert.notEqual(fingerprint(workdir), added, 'rewriting it is work too');
    assert.equal(fingerprint(workdir), fingerprint(workdir), 'the same tree hashes the same');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
