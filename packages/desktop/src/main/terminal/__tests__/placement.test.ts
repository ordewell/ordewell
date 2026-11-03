import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSystemPlacement, parseScope, placeTerminal, type PlacementDeps } from '../placement';

let root: string;
let worktree: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ow-term-'));
  worktree = mkdtempSync(join(tmpdir(), 'ow-term-wt-'));
  mkdirSync(join(root, 'api'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

const session = (state: string) => ({ run: { tasks: [{ id: 't1', order: 2, isolation: { state } }] } });
const branches = (path: string) => ({
  worktrees: [
    { path: '/main/checkout', main: true, branch: 'main', head: null },
    { path, main: false, branch: 'ordewell/x', head: null, owner: { sessionId: 's1', runId: 'r', taskId: 't1' } },
    { path: '/other', main: false, branch: 'ordewell/y', head: null, owner: { sessionId: 's1', runId: 'r', taskId: 't9' } },
  ],
});

function deps(state: string, wt = worktree): PlacementDeps & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (routeId: string) => (
    routeId === 'sessions.get' ? { ok: true, data: session(state) } : { ok: true, data: branches(wt) }
  ));
  return { ...fileSystemPlacement, call };
}

const taskScope = { kind: 'task', sessionId: 's1', taskId: 't1' };

describe('parseScope', () => {
  it('takes the three shapes and nothing else', () => {
    expect(parseScope({ kind: 'checkout', extra: 1 })).toEqual({ kind: 'checkout' });
    expect(parseScope({ kind: 'integration', sessionId: 's' })).toEqual({ kind: 'integration', sessionId: 's' });
    expect(parseScope(taskScope)).toEqual(taskScope);
    for (const bad of [null, 'checkout', { kind: 'task', sessionId: 's' }, { kind: 'task', sessionId: '', taskId: 't' }, { kind: 'nope' }, [], { kind: 'integration' }]) {
      expect(parseScope(bad)).toBeUndefined();
    }
  });
});

describe('placeTerminal', () => {
  it('opens in the repo folder of the user\'s checkout, asking the daemon nothing', async () => {
    const d = deps('active');
    const placed = await placeTerminal(d, root, 'api', { kind: 'checkout' });
    expect(placed.ok && placed.cwd.endsWith('api')).toBe(true);
    const rootPlaced = await placeTerminal(d, root, '.', { kind: 'checkout' });
    expect(rootPlaced.ok).toBe(true);
    expect(d.call).not.toHaveBeenCalled();
  });

  it('refuses a repo that leaves the workspace or is not there', async () => {
    const d = deps('active');
    for (const repo of ['..', '../x', '/etc', 'missing', '', 7]) {
      expect((await placeTerminal(d, root, repo, { kind: 'checkout' })).ok).toBe(false);
    }
  });

  it('refuses a scope that is not one', async () => {
    expect((await placeTerminal(deps('active'), root, '.', { kind: 'shell' })).ok).toBe(false);
  });

  it('refuses the integration branch', async () => {
    const placed = await placeTerminal(deps('active'), root, '.', { kind: 'integration', sessionId: 's1' });
    expect(!placed.ok && placed.message).toMatch(/no worktree/);
  });

  it('refuses a task worktree while the task runs, reading the session as it is now', async () => {
    const d = deps('active');
    const placed = await placeTerminal(d, root, '.', taskScope);
    expect(!placed.ok && placed.message).toContain('Task #2 is running');
    expect(d.call).toHaveBeenCalledWith('sessions.get', { id: 's1', workspace: root });
    expect(d.call).not.toHaveBeenCalledWith('git.branches', expect.anything());
  });

  it('opens in the worktree the daemon names for a stopped task, not one the page names', async () => {
    const d = deps('integrated');
    const placed = await placeTerminal(d, root, 'api', { ...taskScope, path: '/etc' });
    expect(placed).toEqual({ ok: true, cwd: worktree, scope: taskScope });
    expect(d.call).toHaveBeenCalledWith('git.branches', { workspace: root, repo: 'api' });
  });

  it('refuses when the task has no worktree on disk', async () => {
    expect((await placeTerminal(deps('conflict', join(root, 'gone')), root, '.', taskScope)).ok).toBe(false);
    const none: PlacementDeps = { ...fileSystemPlacement, call: async (id) => (id === 'sessions.get' ? { ok: true, data: session('kept') } : { ok: true, data: { worktrees: [] } }) };
    const placed = await placeTerminal(none, root, '.', taskScope);
    expect(!placed.ok && placed.message).toMatch(/no worktree/);
  });

  it('refuses when the run cannot be read', async () => {
    const down: PlacementDeps = { ...fileSystemPlacement, call: async () => ({ ok: false }) };
    expect((await placeTerminal(down, root, '.', taskScope)).ok).toBe(false);
  });

  it('never opens in the main checkout through a task scope', async () => {
    const call = vi.fn(async (id: string) => (id === 'sessions.get'
      ? { ok: true, data: session('landed') }
      : { ok: true, data: { worktrees: [{ path: worktree, main: true, owner: { sessionId: 's1', taskId: 't1' } }] } }));
    expect((await placeTerminal({ ...fileSystemPlacement, call }, root, '.', taskScope)).ok).toBe(false);
  });
});
