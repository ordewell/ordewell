import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../apiClient';

describe('ApiClient when the daemon dies mid-reply', () => {
  const servers: http.Server[] = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  it('rejects instead of never settling when the body is cut off', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
      // The daemon's crash: the socket closes before the chunked terminator.
      setTimeout(() => res.socket?.destroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };

    const outcome = await Promise.race([
      new ApiClient(port, '/work/app')
        .execute('session-1', { command: 'retry_task', task: 't1', from: 'fresh' })
        .then(() => 'resolved', () => 'rejected'),
      new Promise<string>((done) => setTimeout(() => done('never settled'), 2000)),
    ]);

    expect(outcome).toBe('rejected');
  });
});
