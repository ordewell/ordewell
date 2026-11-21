/**
 * A free port for a daemon the harness starts next to a mock provider.
 *
 * Probing port 0 and closing the probe hands the OS that port back, and the
 * next `--port 0` listener (the mock) is offered it again: the release
 * rehearsal's "daemon port 35353, mock port 35353". So start the owner of a
 * port first, then pick every other port here with that port listed in `taken`.
 * A candidate is also bound once before it is returned, which refuses a port
 * somebody else holds, and the pick is retried a bounded number of times.
 */
import net from 'node:net';

/** One port the OS offers, released at once: the probe that causes the race when used before the mock starts. */
export function probePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * @param {number[]} taken ports other processes of this run already listen on
 * @param {{ attempts?: number, candidate?: () => Promise<number> }} [options] `candidate` is the port source, injectable for a test
 */
export async function freePortApart(taken, { attempts = 20, candidate = probePort } = {}) {
  for (let i = 0; i < attempts; i++) {
    const port = await candidate();
    if (taken.includes(port)) continue;
    if (await bindable(port)) return port;
  }
  throw new Error(`no free port apart from ${taken.join(', ') || 'none'} after ${attempts} attempts`);
}
