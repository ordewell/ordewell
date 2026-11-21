import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { freePortApart, probePort } from './free-port.mjs';

const listen = (port = 0) =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });

describe('freePortApart', () => {
  it('never hands back the mock\'s port, even when the source offers it first', async (t) => {
    // The release-rehearsal failure: the OS offered the mock's own port as the candidate.
    const mock = await listen();
    t.after(() => mock.close());
    const { port: mockPort } = mock.address();
    const offers = [mockPort, mockPort];
    const port = await freePortApart([mockPort], { candidate: async () => offers.shift() ?? probePort() });
    assert.notEqual(port, mockPort);
    assert.equal(offers.length, 0, 'it asked again after each refused candidate');
  });

  it('refuses a candidate somebody else holds although it was not listed', async (t) => {
    const other = await listen();
    t.after(() => other.close());
    const { port: held } = other.address();
    const offers = [held];
    const port = await freePortApart([], { candidate: async () => offers.shift() ?? probePort() });
    assert.notEqual(port, held);
  });

  it('gives up after a bounded number of candidates', async () => {
    await assert.rejects(freePortApart([7], { attempts: 3, candidate: async () => 7 }), /no free port/);
  });

  it('returns a bindable port with the default source', async () => {
    const port = await freePortApart([]);
    (await listen(port)).close();
  });
});
