import { describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import { createServer, type AddressInfo, type Socket } from 'net';
import { judgeProbe, METADATA, PROBE_SCRIPT, type ProbeExpected, type ProbeFindings } from '../guaranteeProbe';

/** As a lease with a sidecar asks: the two ways out a bridge container was measured to reach, and what its proxy must turn down. */
const OUT = '1.1.1.1:443';
const LOOPBACK = 'host.docker.internal:45871';
const expected: ProbeExpected = {
  mounts: ['/task', '/mirror', '/tmp'], memoryBytes: 1024, pids: 8192, hostKernel: 'Darwin 25.4.0',
  network: { outside: [OUT, LOOPBACK], name: 'example.com', proxy: { refused: [OUT, LOOPBACK, METADATA] } },
  loopbackHits: 0,
};

/** A container as a Docker lease leaves it: every guarantee this lease can prove, proven. */
const clean: ProbeFindings = {
  hostPathsFound: [],
  mounts: [{ point: '/', type: 'overlay' }, { point: '/proc', type: 'proc' }, { point: '/etc/hosts', type: 'ext4' }, { point: '/task', type: 'ext4' }, { point: '/mirror', type: 'ext4' }, { point: '/tmp', type: 'tmpfs' }],
  dockerSocket: false,
  writesPassed: [],
  workspaceWritable: true,
  kernel: 'Linux 6.8.0',
  memoryMax: '1024',
  swapMax: '0',
  pidsMax: '8192',
  metadata: 'ENETUNREACH',
  gateway: 'no route',
  outside: { [OUT]: 'ENETUNREACH', [LOOPBACK]: 'EAI_AGAIN' },
  named: 'EAI_AGAIN',
  proxied: { [OUT]: '403', [LOOPBACK]: '403', [METADATA]: '403' },
  credentialsVisible: [],
  secretsFound: 0,
  loginReadable: false,
};

const judge = (over: Partial<ProbeFindings>, asked: Partial<ProbeExpected> = {}) => judgeProbe({ ...clean, ...over }, { ...expected, ...asked }, '2026-11-01T00:00:00.000Z');

describe('what a probe proves (ADR-0059 L3)', () => {
  it('proves what the findings show, and how and when', () => {
    const report = judge({});
    expect(report['fs.hostHidden']).toMatchObject({ proven: true, at: '2026-11-01T00:00:00.000Z' });
    expect(report['fs.writeScope'].proven).toBe(true);
    expect(report['limits.memory'].proven).toBe(true);
    expect(report['kernel.separate'].proven).toBe(true);
    expect(report['net.noMetadata'].proven).toBe(true);
    expect(report['cred.unreadable'].proven).toBe(true);
  });

  it.each<[string, Partial<ProbeFindings>, RegExp]>([
    ['a canary of the host that can be read', { hostPathsFound: ['/Users/me/canary'] }, /canary/],
    ['a folder of the host through a shared filesystem', { mounts: [{ point: '/task', type: 'virtiofs' }] }, /virtiofs/],
    ['a mount the lease never asked for', { mounts: [{ point: '/Users', type: 'ext4' }] }, /\/Users/],
    ['the Docker socket', { dockerSocket: true }, /socket/],
  ])('does not prove the host hidden with %s', (_case, over, why) => {
    expect(judge(over)['fs.hostHidden']).toMatchObject({ proven: false, by: expect.stringMatching(why) });
  });

  it('does not prove the write scope when a write got past it', () => {
    expect(judge({ writesPassed: ['/mirror'] })['fs.writeScope']).toMatchObject({ proven: false, by: expect.stringContaining('/mirror') });
  });

  it('does not prove the write scope when the workspace takes no write', () => {
    expect(judge({ workspaceWritable: false })['fs.writeScope'].proven).toBe(false);
  });

  it.each<[string, Partial<ProbeFindings>]>([
    ['a higher memory limit', { memoryMax: '2048' }],
    ['no memory limit', { memoryMax: 'max' }],
    ['swap past the limit', { swapMax: '1024' }],
    ['a cgroup it cannot read', { memoryMax: null }],
    ['a different process limit', { pidsMax: 'max' }],
  ])('does not prove the limits with %s', (_case, over) => {
    expect(judge(over)['limits.memory'].proven).toBe(false);
  });

  it('proves the allowlist only from what nothing reached and the proxy turned down', () => {
    expect(judge({})['net.allowlist']).toMatchObject({ proven: true, by: expect.stringContaining('turned down') });
  });

  // What a bridge container did when measured on Colima, one way out at a time.
  it.each<[string, Partial<ProbeFindings>, RegExp]>([
    ['an address outside that answered', { outside: { ...clean.outside, [OUT]: 'connected' } }, /1\.1\.1\.1:443/],
    ["this host's loopback that answered", { outside: { ...clean.outside, [LOOPBACK]: 'connected' } }, /host\.docker\.internal/],
    ['a route out', { gateway: 'ECONNREFUSED' }, /route/],
    ['a name that resolved, which is a way out by DNS', { named: 'resolved' }, /DNS/],
    ['a proxy that let an address through', { proxied: { ...clean.proxied, [OUT]: '200' } }, /1\.1\.1\.1:443/],
    ['a proxy that never answered', { proxied: { ...clean.proxied, [OUT]: 'ECONNREFUSED' } }, /1\.1\.1\.1:443/],
    ['a target the probe says nothing of', { outside: { [OUT]: 'ENETUNREACH' } }, /host\.docker\.internal/],
  ])('does not prove the allowlist with %s', (_case, over, why) => {
    expect(judge(over)['net.allowlist']).toMatchObject({ proven: false, by: expect.stringMatching(why) });
  });

  it("believes this host's own listener over what a container says of itself", () => {
    expect(judge({}, { loopbackHits: 1 })['net.allowlist']).toMatchObject({ proven: false, by: expect.stringContaining('loopback') });
  });

  it('proves it for a lease with no way out at all, which has no proxy to ask', () => {
    expect(judge({ proxied: {} }, { network: { ...expected.network, proxy: null } })['net.allowlist'].proven).toBe(true);
  });

  it('does not prove the metadata service out of reach once one answers', () => {
    expect(judge({ metadata: 'connected' })['net.noMetadata'].proven).toBe(false);
  });

  it('does not prove it out of reach while the proxy would carry a request there', () => {
    expect(judge({ proxied: { ...clean.proxied, [METADATA]: '200' } })['net.noMetadata']).toMatchObject({ proven: false, by: expect.stringContaining('proxy') });
  });

  it('does not prove a credential unreadable while the runner can read it', () => {
    expect(judge({ credentialsVisible: ['ANTHROPIC_API_KEY'] })['cred.unreadable']).toMatchObject({ proven: false, by: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(judge({ loginReadable: true })['cred.unreadable'].proven).toBe(false);
  });

  it('does not prove a key held at the gateway while its value is in the container', () => {
    expect(judge({ secretsFound: 1 }, { gated: true })['cred.unreadable']).toMatchObject({ proven: false, by: expect.stringContaining('gateway') });
  });

  it('proves a key held at the gateway from having looked for it', () => {
    expect(judge({}, { gated: true })['cred.unreadable']).toMatchObject({ proven: true, by: expect.stringContaining('gateway') });
  });

  it("does not prove a separate kernel on one the host shares", () => {
    expect(judge({ kernel: 'Darwin 25.4.0' })['kernel.separate'].proven).toBe(false);
  });
});

describe('the probe script', () => {
  const NO_NETWORK = { outside: [], name: 'localhost', proxy: null };

  it('says what it finds as JSON, on any machine with node', () => {
    const run = spawnSync(process.execPath, ['-e', PROBE_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ORDEWELL_PROBE: JSON.stringify({ hostPaths: ['/definitely/not/here', process.execPath], deniedWrites: ['/definitely/not/here'], workspace: '/definitely/not/here', credentials: ['ORDEWELL_TEST_SET', 'ORDEWELL_TEST_UNSET'], login: process.execPath, network: NO_NETWORK }), ORDEWELL_TEST_SET: '1' },
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ hostPathsFound: [process.execPath], writesPassed: [], workspaceWritable: false, credentialsVisible: ['ORDEWELL_TEST_SET'], loginReadable: true });
  });

  /** One run against listeners on this host's loopback, as the container's own network would answer it. */
  async function probed(network: unknown, env: Record<string, string> = {}) {
    const run = await new Promise<string>((resolve) => {
      execFile(process.execPath, ['-e', PROBE_SCRIPT], { env: { ...process.env, ...env, ORDEWELL_PROBE: JSON.stringify({ hostPaths: [], deniedWrites: [], workspace: '/definitely/not/here', credentials: [], network }) } }, (_err, stdout) => resolve(stdout));
    });
    return JSON.parse(run) as ProbeFindings;
  }

  const listening = (answer: (socket: Socket) => void) => new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = createServer(answer).listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });

  it('tries each target and says how it ended', async () => {
    const open = await listening((socket) => socket.end());
    const closed = await listening(() => undefined);
    closed.close();

    const found = await probed({ outside: [`127.0.0.1:${open.port}`, `127.0.0.1:${closed.port}`], name: 'localhost', proxy: null });

    expect(found.outside).toEqual({ [`127.0.0.1:${open.port}`]: 'connected', [`127.0.0.1:${closed.port}`]: 'ECONNREFUSED' });
    expect(found.named).toBe('resolved');
    open.close();
  });

  it('asks the way out the runner would use, and reads the status it answers', async () => {
    const asked: string[] = [];
    const proxy = await listening((socket) => socket.once('data', (head) => {
      asked.push(head.toString().split('\r\n')[0]);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }));

    const found = await probed({ outside: [], name: 'localhost', proxy: { refused: ['1.1.1.1:443'] } }, { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` });

    expect(asked).toEqual(['CONNECT 1.1.1.1:443 HTTP/1.1']);
    expect(found.proxied).toEqual({ '1.1.1.1:443': '403' });
    proxy.close();
  });

  it('says so where no way out answers', async () => {
    const found = await probed({ outside: [], name: 'localhost', proxy: { refused: ['1.1.1.1:443'] } }, { HTTPS_PROXY: '' });

    expect(found.proxied).toEqual({ '1.1.1.1:443': 'no proxy' });
  });
});
