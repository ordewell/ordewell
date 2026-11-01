import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, type RequestListener, type Server } from 'http';
import { connect, type AddressInfo } from 'net';
import { LeaseRelay, RELAY_ENTRY } from '../leaseRelay';

/*
 * The relay's two ends, joined by the same pipes `docker run -i` gives them:
 * its entry is the very script a container runs, on this host's node. What it
 * listens on is this host's loopback here, so the host's listener and the
 * relay's take different ports, where in a container they share one.
 */

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
});

function entry(): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['-e', RELAY_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}

async function server(handler: RequestListener): Promise<number> {
  const http = createServer(handler);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return (http.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('the lease relay', () => {
  it('says when its entry has started', async () => {
    const relay = new LeaseRelay(entry());

    await expect(relay.ready).resolves.toBeUndefined();
  });

  it('carries an HTTP request to a listener on this host, and its streamed reply back', async () => {
    const hostPort = await server((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${body}\n\n`);
        setTimeout(() => res.end('data: done\n\n'), 20);
      });
    });
    const relay = new LeaseRelay(entry());
    await relay.ready;
    const relayPort = await freePort();

    await relay.forward(relayPort, hostPort);

    const reply = await fetch(`http://127.0.0.1:${relayPort}/mcp`, { method: 'POST', body: 'hello' });
    expect(await reply.text()).toBe('data: hello\n\ndata: done\n\n');
  });

  it('carries two connections at once without crossing them', async () => {
    const hostPort = await server((req, res) => { setTimeout(() => res.end(req.url), req.url === '/slow' ? 40 : 0); });
    const relay = new LeaseRelay(entry());
    await relay.ready;
    const relayPort = await freePort();
    await relay.forward(relayPort, hostPort);

    const [slow, quick] = await Promise.all(['/slow', '/quick'].map(async (path) => (await fetch(`http://127.0.0.1:${relayPort}${path}`)).text()));

    expect([slow, quick]).toEqual(['/slow', '/quick']);
  });

  it('forwards each port once, however often it is asked', async () => {
    const hostPort = await server((_req, res) => res.end('ok'));
    const relay = new LeaseRelay(entry());
    await relay.ready;
    const relayPort = await freePort();

    await relay.forward(relayPort, hostPort);
    await relay.forward(relayPort, hostPort);

    expect(await (await fetch(`http://127.0.0.1:${relayPort}/`)).text()).toBe('ok');
  });

  it('closes a connection when the listener on this host refuses it', async () => {
    const closed = await freePort();
    const relay = new LeaseRelay(entry());
    await relay.ready;
    const relayPort = await freePort();
    await relay.forward(relayPort, closed);

    await expect(new Promise((resolve) => {
      connect(relayPort, '127.0.0.1').on('close', () => resolve('closed')).on('error', () => undefined);
    })).resolves.toBe('closed');
  });

  it("ends the entry with its host's pipe, which is what ends the container", async () => {
    const child = entry();
    const relay = new LeaseRelay(child);
    await relay.ready;

    const exit = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.end();

    await expect(exit).resolves.toBe(0);
  });

  it('opens nothing the host did not forward, whatever a frame says', async () => {
    const asked: string[] = [];
    const hostPort = await server((req, res) => { asked.push(req.url ?? ''); res.end('no'); });
    const child = entry();
    const relay = new LeaseRelay(child);
    await relay.ready;

    // What a process in the container could write down the entry's stdout: an OPEN for a port never forwarded.
    const frame = Buffer.alloc(9 + 2);
    frame[0] = 2;
    frame.writeUInt32BE(77, 1);
    frame.writeUInt32BE(2, 5);
    frame.writeUInt16BE(hostPort, 9);
    child.stdout.emit('data', frame);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(asked).toEqual([]);
  });

  it('gives up on a frame longer than any connection sends', async () => {
    const child = entry();
    const relay = new LeaseRelay(child);
    await relay.ready;
    const gone = new Promise((resolve) => child.on('exit', resolve));

    const frame = Buffer.alloc(9);
    frame[0] = 3;
    frame.writeUInt32BE(0xffffffff, 5);
    child.stdout.emit('data', frame);

    await expect(gone).resolves.not.toBeUndefined();
  });

  it('reports how its entry ended, for a lease to tell its end from a kill', async () => {
    const child = entry();
    const relay = new LeaseRelay(child);
    await relay.ready;

    child.kill('SIGKILL');

    await expect(relay.ended).resolves.toBeUndefined();
  });
});
