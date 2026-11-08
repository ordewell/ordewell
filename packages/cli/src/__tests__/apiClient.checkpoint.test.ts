import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../apiClient';

describe('ApiClient checkpoint answers', () => {
  const servers: http.Server[] = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  async function client(status: number, body: unknown) {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      let sent = '';
      req.on('data', (chunk) => { sent += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${sent}`.trim());
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { api: new ApiClient((server.address() as { port: number }).port, '/w'), hits };
  }

  it('approves on its own route', async () => {
    const { api, hits } = await client(200, { ok: true });
    expect(await api.approveTaskCheckpoint('s1', 't1')).toEqual({ ok: true });
    expect(hits).toEqual(['POST /api/plans/s1/tasks/t1/checkpoint/approve?workspace=%2Fw']);
  });

  it('rejects with the reason, or with an empty body when there is none', async () => {
    const { api, hits } = await client(200, { ok: true });
    await api.rejectTaskCheckpoint('s1', 't1', 'keep the table');
    await api.rejectTaskCheckpoint('s1', 't1');
    expect(hits).toEqual([
      'POST /api/plans/s1/tasks/t1/checkpoint/reject?workspace=%2Fw {"reason":"keep the table"}',
      'POST /api/plans/s1/tasks/t1/checkpoint/reject?workspace=%2Fw {}',
    ]);
  });

  it('surfaces the daemon\'s refusal when nothing waits', async () => {
    const { api } = await client(409, { error: 'The task is not waiting at a checkpoint' });
    await expect(api.approveTaskCheckpoint('s1', 't1')).rejects.toThrow('not waiting at a checkpoint');
    await expect(api.rejectTaskCheckpoint('s1', 't1', 'no')).rejects.toThrow('not waiting at a checkpoint');
  });
});
