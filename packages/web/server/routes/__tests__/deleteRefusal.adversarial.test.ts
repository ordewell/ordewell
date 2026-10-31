import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadSession, saveChildSession, saveSession } from '@ordewell/core';
import { sessionsRoute } from '../sessions';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * A delete that must be refused leaves the session open (ADR-0055 D11): a
 * child's worktree git could not let go stops it. The live session is closed
 * first, so the surface hears "Session closed." and then an error, and the
 * session it was told is gone is still on disk.
 */

const env = () => { const e = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k]; return e; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('DELETE /api/sessions/:id when a child cannot be let go', () => {
  it('does not close the session for a delete it has to refuse', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-delete-')));
    try {
      mkdirSync(ws, { recursive: true });
      git(ws, 'init', '-q', '-b', 'main');
      git(ws, 'config', 'user.name', 'T');
      git(ws, 'config', 'user.email', 't@example.com');
      writeFileSync(join(ws, 'README.md'), 'hello\n');
      git(ws, 'add', '-A');
      git(ws, 'commit', '-q', '-m', 'initial');
      const base = git(ws, 'rev-parse', 'HEAD');
      saveSession({ tasks: [], generatedAt: '2026-10-31T00:00:00.000Z', lastUpdated: '2026-10-31T00:00:00.000Z', status: 'approved', runners: ['claude-code'], conversationHistory: [] } as never, 'goal', ws, 'root');

      // A child whose task worktree exists but is no longer a worktree: git cannot keep what is in it.
      const codeRoot = join(ws, '.ordewell', 'worktrees', 'parentrun', '1-delegated');
      const worktree = join(ws, '.ordewell', 'worktrees', 'childrun', '1-a');
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, 'a.txt'), 'unlanded work\n');
      saveChildSession({
        tasks: [{ id: 'a', order: 1, title: 'A', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [] }],
        generatedAt: '2026-10-31T00:00:00.000Z', lastUpdated: '2026-10-31T00:00:00.000Z', status: 'running', runners: ['claude-code'], conversationHistory: [],
        isolation: {
          run: {
            id: 'childrun', workspaceRoot: codeRoot, stateRoot: ws,
            repos: [{ path: '.', root: codeRoot, baseRef: base, baseBranch: 'main', integrationBranch: 'ordewell/childrun/integration' }],
            shared: [], sharedRepos: [], keepsEveryLanding: true, carried: {},
            tasks: { a: { taskId: 'a', order: 1, title: 'A', branch: 'ordewell/childrun/1-a', workspace: worktree, status: 'active', repos: { '.': { worktree, linked: [] } } } },
          },
          resolvers: {},
        },
      } as never, 'sub goal', { baseDir: ws, rootSessionId: 'root', sessionId: 'child' });

      const destroy = vi.fn();
      const pool = { hasSession: vi.fn().mockReturnValue(true), destroy } as unknown as OrchestratorPool;
      const app = new Hono();
      app.route('/api/sessions', sessionsRoute(pool));

      const res = await app.request(`/api/sessions/root?workspace=${encodeURIComponent(ws)}`, { method: 'DELETE' });
      const body = (await res.json()) as { ok: boolean; message?: string };

      expect(body.ok).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
      expect(loadSession('root', ws)).not.toBeNull();
      expect(existsSync(join(worktree, 'a.txt'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
