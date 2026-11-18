import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { LegacyPlanState } from '../../models/Task';
import { createTask } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { landingMessage } from '../landingMessage';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * A task's scope after it took in a sibling's landed work (ADR-0013): what it
 * merged in is the sibling's, so the host's "changed by this task" view starts
 * at its fork point, as its diff does. Expected values are the files this test
 * writes and what git says of the merge, never the reader's own computation.
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' }).trim();

const tmps: string[] = [];
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true }); });

const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });
const isolation = createWorktreeIsolation({
  config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
  resolvePath: async () => process.env.PATH ?? '',
});

/** A run where the lexer landed beside the parser, and the parser committed its own work, then took the lexer in. */
async function tookIn(): Promise<{ workspace: string; run: IsolationRun; parser: string; at: { workspace: string; scope: 'task'; sessionId: string; taskId: string } }> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reader-takein-')));
  tmps.push(tmp);
  const workspace = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  git(workspace, 'init', '-q', '-b', 'main');
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Run\n');
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export {};\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');

  const lexer = createTask({ id: 't1', order: 1, title: 'Fill in the lexer', prompt: 'x' });
  const parser = createTask({ id: 't2', order: 2, title: 'Fill in the parser', prompt: 'x' });
  const run = await isolation.startRun(workspace);
  const one = await isolation.prepare(lexer, run);
  const two = await isolation.prepare(parser, run);
  fs.writeFileSync(path.join(one.cwd, 'src', 'lexer.ts'), 'lex\n');
  expect(await isolation.integrate(lexer, run)).toBe('merged');

  fs.writeFileSync(path.join(two.cwd, 'src', 'parser.ts'), 'parse\n');
  git(two.cwd, 'add', '-A');
  git(two.cwd, 'commit', '-q', '-m', 'Fill in the parser');
  git(two.cwd, 'merge', '--no-edit', '-m', landingMessage('take-in', parser), run.repos[0].integrationBranch);
  saveSession({ tasks: [lexer, parser], runners: ['claude-code'], status: 'approved', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, 'sess-take-in');
  return { workspace, run, parser: two.cwd, at: { workspace, scope: 'task', sessionId: 'sess-take-in', taskId: 't2' } };
}

describe.skipIf(!hasGit)('workspace reader: a task that took in landed work', () => {
  it('reads a live task\'s changes from its fork point, so the sibling it took in is not its own', async () => {
    const { at, parser, run } = await tookIn();
    const all = await reader.diff(at, {});
    expect(all.files.map((f) => f.path)).toEqual(['src/parser.ts']);
    // The take-in's second parent is the integration tip it merged: that is where the task's own work starts now.
    expect(all.from).toBe(git(parser, 'rev-parse', 'HEAD^2'));
    expect(all.from).not.toBe(run.tasks.t2.repos['.'].baseRef);

    const src = await reader.tree(at, 'src');
    expect(src.entries.map((e) => [e.name, e.status ?? null, e.taskId ?? null])).toEqual([['index.ts', null, null], ['lexer.ts', null, null], ['parser.ts', 'A', 't2']]);
  });

  it('reads a task\'s changes past the take-in even when its runner moved the integration branch onto its own tip', async () => {
    const { at, parser, run } = await tookIn();
    const merged = git(parser, 'rev-parse', 'HEAD^2');
    fs.writeFileSync(path.join(parser, 'src', 'guarded.ts'), 'x\n');
    git(parser, 'add', '-A');
    git(parser, 'commit', '-q', '-m', 'guarded');
    git(parser, 'update-ref', `refs/heads/${run.repos[0].integrationBranch}`, 'HEAD');
    const all = await reader.diff(at, {});
    expect(all.from).toBe(merged);
    expect(all.files.map((f) => f.path)).toEqual(['src/guarded.ts', 'src/parser.ts']);
  });

  it('reads a pruned task\'s branch from its fork point too', async () => {
    const { at, parser, workspace } = await tookIn();
    const merged = git(parser, 'rev-parse', 'HEAD^2');
    git(workspace, 'worktree', 'remove', '--force', parser);
    const all = await reader.diff(at, {});
    expect(all).toMatchObject({ at: { source: 'commit' }, from: merged });
    expect(all.files.map((f) => f.path)).toEqual(['src/parser.ts']);
  });
});
