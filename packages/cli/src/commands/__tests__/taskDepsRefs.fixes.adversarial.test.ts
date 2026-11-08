import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { wireRoute } from '../../__tests__/wireRoute';

/**
 * Adversarial, round two, on `ordewell task-deps`: the first round added the
 * dependencies a task holds outside the earlier-sibling list to the listing.
 * Neighbours: one held outside it that is the task's own parent, and a
 * dependency value the user types as a unique id prefix — CONTEXT.md says the
 * CLI reads the user's prefix wherever they type a reference.
 */

interface Recorded { method: string; url: string; body: { dependencies?: string[] } }

const PLAN = {
  tasks: [
    {
      id: 'alpha-1', order: 1, title: 'Research', type: 'ai', status: 'completed', dependencies: [],
      assignedRunner: 'claude-code', subtasks: [
        { id: 'alpha-1a', order: 1, title: 'Draft', type: 'ai', status: 'pending', dependencies: ['alpha-1'], assignedRunner: 'claude-code' },
      ],
    },
    { id: 'beta-2', order: 2, title: 'Implement', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code' },
    { id: 'gamma-3', order: 3, title: 'Sign off', type: 'user', status: 'pending', dependencies: [], assignedRunner: '' },
  ],
};

async function fakeDaemon(plan: unknown = PLAN): Promise<{ port: number; close: () => void; sent: Recorded[] }> {
  const sent: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.method !== 'GET') sent.push({ method: req.method!, url: wireRoute(req.url), body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (wireRoute(req.url).includes('/api/sessions/')) return res.end(JSON.stringify({ meta: { id: 'session-1', goal: 'g' }, plan }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close(), sent };
}

async function capture(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(String(m)); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(String(m)); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  let exitCode: number | null = null;
  try {
    await fn();
  } catch (e: unknown) {
    const match = ((e as Error).message || '').match(/^exit:(\d+)$/);
    if (match) exitCode = Number(match[1]);
    else throw e;
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

describe('adversarial: task-deps outside the earlier-sibling list, and a prefix value', () => {
  it('shows a held dependency that is the task\'s own parent, which the sibling list never offers', async () => {
    const d = await fakeDaemon();
    try {
      const { handleTaskDeps } = await import('../task-assign');
      const { stdout } = await capture(() => handleTaskDeps(['--session-id', 'session-1', '1.1'], new ApiClient(d.port)));
      expect(stdout).toContain('* alpha-1  #1 Research');
    } finally { d.close(); }
  });

  it('resolves a dependency value the user typed as a unique id prefix', async () => {
    const d = await fakeDaemon();
    try {
      const { handleTaskDeps } = await import('../task-assign');
      const { stderr, exitCode } = await capture(() => handleTaskDeps(['--session-id', 'session-1', '3', 'bet'], new ApiClient(d.port)));

      expect(stderr).toBe('');
      expect(exitCode).toBeNull();
      expect(d.sent).toEqual([{ method: 'PUT', url: '/api/plans/session-1/tasks/gamma-3', body: { dependencies: ['beta-2'] } }]);
    } finally { d.close(); }
  });
});
