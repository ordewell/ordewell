// Part of GitWorktreeIsolation: a running task takes in what landed beside it. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fakeConfig, removeDir } from '../../testing';
import { landingMessage } from '../landingMessage';
import { renderLandingBeside } from '../promptAugment';
import { hasGit, create, git, task, roots, repo, cleanEnv, integrationOf } from './gitWorktreeIsolationKit';
import { nothingInTheWay } from './gitWorktreeRevertKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

/** The merge the task's note tells it to run, read back out of the note, run as a runner's shell would. */
function runTakeIn(note: string, cwd: string): void {
  const command = /take it in with `([^`]+)`/.exec(note)?.[1];
  if (!command) throw new Error('the note names no merge');
  execFileSync('sh', ['-c', command], { cwd, env: cleanEnv(), stdio: 'pipe' });
}

const names = (text: string): string[] => text.split('\0').filter(Boolean).sort();

describe.skipIf(!hasGit)('WorktreeIsolation: work landing beside a running task', () => {
  it('cuts each worktree from the integration tip as the task starts, not from the run\'s base', async () => {
    const dir = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(dir);
    const [first, beside] = [task(1, 'Fill in the lexer'), task(2, 'Fill in the parser')];
    const f = await iso.prepare(first, run);
    const b = await iso.prepare(beside, run);
    writeFileSync(join(f.cwd, 'lexer.py'), 'lex\n');
    expect(await iso.integrate(first, run)).toBe('merged');

    // Started beside it, the parser's worktree does not see the lexer; one started after it does.
    expect(existsSync(join(b.cwd, 'lexer.py'))).toBe(false);
    const later = await iso.prepare(task(3, 'Fill in the printer'), run);
    expect(existsSync(join(later.cwd, 'lexer.py'))).toBe(true);
    expect(run.tasks['task-3'].repos['.'].baseRef).toBe(git(dir, 'rev-parse', integrationOf(run)));
    expect(run.tasks['task-3'].repos['.'].baseRef).not.toBe(run.repos[0].baseRef);
  });

  it('takes in a sibling\'s landed work with the merge its note names, lands through it, and reads only its own work as its diff', async () => {
    const dir = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(dir);
    const [first, beside] = [task(1, 'Fill in the lexer'), task(2, 'Fill in the parser')];
    const f = await iso.prepare(first, run);
    const b = await iso.prepare(beside, run);
    writeFileSync(join(f.cwd, 'lexer.py'), 'lex\n');
    expect(await iso.integrate(first, run)).toBe('merged');

    writeFileSync(join(b.cwd, 'parser.py'), 'parse\n');
    git(b.cwd, 'add', '-A');
    git(b.cwd, 'commit', '-q', '-m', 'Fill in the parser');
    const note = renderLandingBeside({ integrationBranch: integrationOf(run), message: landingMessage('take-in', beside), repos: ['.'] });
    expect(git(b.cwd, 'log', '--oneline', `HEAD..${integrationOf(run)}`)).toContain('Merge: Fill in the lexer');
    runTakeIn(note, b.cwd);
    expect(existsSync(join(b.cwd, 'lexer.py'))).toBe(true);
    expect(git(b.cwd, 'log', '-1', '--format=%s')).toBe('Merge: Fill in the parser (take in landed work)');

    // Live, what it merged in is the lexer's, not its own: the diff starts past it.
    const live = await iso.taskDiff!(run, 'task-2', { names: true });
    expect(live.available && names(live.text)).toEqual(['parser.py']);

    writeFileSync(join(b.cwd, 'parser.py'), 'parse tokens\n');
    expect(await iso.integrate(beside, run)).toBe('merged');
    // One merge commit for the landing, onto the tip the lexer left, its second parent the task's own tip.
    const [, onto, brought] = git(dir, 'rev-list', '--parents', '-n', '1', integrationOf(run)).split(' ');
    expect(onto).toBe(run.tasks['task-1'].repos['.'].landedTip);
    expect(brought).toBe(run.tasks['task-2'].repos['.'].taskTip);
    expect(git(dir, 'show', `${integrationOf(run)}:parser.py`)).toBe('parse tokens');
    expect(git(dir, 'show', `${integrationOf(run)}:lexer.py`)).toBe('lex');

    // Landed, the same: the take-in is not read as its work.
    const landed = await iso.taskDiff!(run, 'task-2', { names: true });
    expect(landed.available && names(landed.text)).toEqual(['parser.py']);
  });

  it('reads a task that took nothing in from where its worktree was cut, as before', async () => {
    const dir = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(dir);
    const [first, beside] = [task(1, 'Fill in the lexer'), task(2, 'Fill in the parser')];
    const f = await iso.prepare(first, run);
    const b = await iso.prepare(beside, run);
    writeFileSync(join(f.cwd, 'lexer.py'), 'lex\n');
    expect(await iso.integrate(first, run)).toBe('merged');
    writeFileSync(join(b.cwd, 'parser.py'), 'parse\n');

    const live = await iso.taskDiff!(run, 'task-2', { names: true });
    expect(live.available && names(live.text)).toEqual(['parser.py']);
    expect(await iso.integrate(beside, run)).toBe('merged');
    const landed = await iso.taskDiff!(run, 'task-2', { names: true });
    expect(landed.available && names(landed.text)).toEqual(['parser.py']);
  });

  it('reverts a landed task that a sibling took in, leaving the sibling\'s own work (ADR-0054)', async () => {
    const dir = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(dir);
    const [first, beside] = [task(1, 'Fill in the lexer'), task(2, 'Fill in the parser')];
    const f = await iso.prepare(first, run);
    const b = await iso.prepare(beside, run);
    writeFileSync(join(f.cwd, 'lexer.py'), 'lex\n');
    expect(await iso.integrate(first, run)).toBe('merged');
    writeFileSync(join(b.cwd, 'parser.py'), 'parse\n');
    git(b.cwd, 'add', '-A');
    git(b.cwd, 'commit', '-q', '-m', 'Fill in the parser');
    runTakeIn(renderLandingBeside({ integrationBranch: integrationOf(run), message: landingMessage('take-in', beside), repos: ['.'] }), b.cwd);
    expect(await iso.integrate(beside, run)).toBe('merged');

    expect(await iso.revert(run, [first.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(git(dir, 'ls-tree', '--name-only', integrationOf(run)).split('\n')).toEqual(['README.md', 'parser.py']);
    expect(run.tasks[beside.id].status).toBe('merged');
  });
});
