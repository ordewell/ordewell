import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';
import { landingRuns } from '../landingInterlock';

/**
 * The interlock where a run's record and the user's checkout name one folder
 * two ways, as on Windows: the checkout under an 8.3 short name
 * (C:\Users\RUNNER~1), which Node's JS realpath keeps, and the record under
 * the long name git prints. A link stands in for the short name, and the JS
 * realpath is made to keep it as Windows' does, so every platform runs it.
 */

const alias = vi.hoisted(() => ({ short: '', long: '' }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const nodePath = await import('path');
  const under = (p: string, root: string) => p === root || p.startsWith(root + nodePath.sep);
  const realpathSync = Object.assign((p: import('fs').PathLike, options?: import('fs').EncodingOption): string => {
    const real = actual.realpathSync(p, options);
    if (!alias.short || !under(nodePath.resolve(String(p)), alias.short) || !under(real, alias.long)) return real;
    return alias.short + real.slice(alias.long.length);
  }, { native: actual.realpathSync.native });
  return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

describe('landing runs under a short name git prints long (ADR-0062 G7)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-landing-short-')));
    alias.long = path.join(tmp, 'long-name');
    alias.short = path.join(tmp, 'short');
    fs.mkdirSync(path.join(alias.long, 'ws', 'api', '.git'), { recursive: true });
    fs.symlinkSync(alias.long, alias.short, process.platform === 'win32' ? 'junction' : 'dir');
  });

  afterEach(() => {
    alias.short = '';
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds the enclosing workspace\'s run in a checkout opened by its short name', () => {
    const workspace = path.join(alias.long, 'ws');
    const run: IsolationRun = {
      id: 'r1',
      workspaceRoot: workspace,
      repos: [{ path: 'api', root: path.join(workspace, 'api'), baseRef: 'a1', baseBranch: 'main', integrationBranch: 'ordewell/r1/api' }],
      shared: [],
      sharedRepos: [],
      tasks: {},
    };
    saveSession({
      tasks: [createTask({ id: 't1', order: 1, title: 'One', prompt: 'do it', assignedRunner: 'claude-code' })],
      generatedAt: '2026-01-01T00:00:00Z',
      lastUpdated: '2026-01-01T00:00:00Z',
      status: 'approved',
      runners: ['claude-code'],
      isolation: { run, resolvers: {} },
    } as LegacyPlanState, 'goal', workspace, 's1');
    const inner = path.join(alias.short, 'ws', 'api');
    expect(fs.realpathSync(inner).startsWith(alias.short)).toBe(true);

    expect(landingRuns({ workspace: inner, repo: '.', root: inner }, () => true)).toEqual([
      { workspace: fs.realpathSync.native(workspace), sessionId: 's1', runId: 'r1', repo: '.', branch: 'main', live: true, unmerged: false },
    ]);
  });
});
