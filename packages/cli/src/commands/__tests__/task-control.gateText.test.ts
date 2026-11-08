import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { handleForceStart } from '../task-control';
import { wireRoute } from '../../__tests__/wireRoute';

const PLAN = {
  meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 2, status: 'running', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 'ops-3', order: 3, title: 'Deploy', type: 'ai', ops: true, status: 'pending' }] },
};
const GATE = { mergeGate: [{ id: 'fix-1', order: 1, title: 'Fix' }, { id: 'bump-2', order: 2, title: 'Bump' }] };

describe('the question before a start past the merge gate, pinned before its text moves to core', () => {
  it('names every unmerged dependency by order and title', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wireRoute(req.url).endsWith('/merge-gate') ? GATE : wireRoute(req.url).includes('/sessions/') ? PLAN : { ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const questions: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleForceStart(['--session-id', 'session-1', '3'], new ApiClient(port), async (q) => { questions.push(q); return true; });

    expect(questions).toEqual(['This task waits for Merge all: the work of #1 Fix, #2 Bump is not merged into your branch yet, so it would act without it. Starting it now is kept on the task. Start it anyway?']);
    vi.restoreAllMocks();
    server.close();
  });
});
