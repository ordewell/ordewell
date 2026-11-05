import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { connect, createServer, type AddressInfo, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DockerCall, DockerCli, DockerResult } from '../dockerCli';
import { EGRESS_ENTRY, SidecarEgress } from '../egressSidecar';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { fakeSecret } from '../../__tests__/fakeSecret';

/*
 * The sidecar as itself, on this host's node. A preload stands in for the
 * world, so no test needs the internet and the script holds no test seam: names
 * resolve as `RESOLVES` says, and whatever it dials lands on an echo server, with
 * the address it asked for written down.
 */
const WORLD = String.raw`
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { names, echoPort, dialed } = JSON.parse(process.env.ORDEWELL_TEST_WORLD);
os.networkInterfaces = () => ({ lo: [{ address: '127.0.0.2', family: 'IPv4', internal: true }], eth0: [{ address: '127.0.0.1', family: 'IPv4', internal: false }] });
const realLookup = dns.lookup;
dns.lookup = (name, options, done) => {
  if (net.isIP(name) || name.includes('\0')) return realLookup(name, options, done);
  const addresses = names[name];
  if (!addresses) return done(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  done(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};
const realConnect = net.connect;
net.connect = (options, ...rest) => {
  fs.appendFileSync(dialed, options.host + ':' + options.port + '\n');
  return realConnect({ host: '127.0.0.1', port: echoPort }, ...rest);
};
`;

interface Sidecar { port: number; process: ChildProcess; dialed: () => string[] }

const live: { child?: ChildProcess; server?: Server; dir?: string }[] = [];
afterEach(() => {
  for (const { child, server, dir } of live.splice(0)) {
    child?.kill('SIGKILL');
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const RESOLVES: Record<string, string[]> = {
  'registry.npmjs.org': ['104.16.0.34'],
  'a.example.com': ['93.184.216.34'],
  'example.com': ['93.184.216.34'],
  'evilexample.com': ['93.184.216.34'],
  'v6.example.org': ['2606:4700::6810:84e5'],
  'loopback.example.org': ['127.0.0.1'],
  'private.example.org': ['10.0.0.5'],
  'vm.example.org': ['192.168.5.2'],
  'bridge.example.org': ['172.17.0.1'],
  'metadata.example.org': ['169.254.169.254'],
  'carrier.example.org': ['100.64.0.1'],
  'six.example.org': ['::1'],
  'link.example.org': ['fe80::1'],
  'unique.example.org': ['fd00::1'],
  'mapped.example.org': ['::ffff:127.0.0.1'],
  'teredo.example.org': ['2001:0:a00:1::1'],
  'v6-beside-teredo.example.org': ['2001:4860:4860::8888'],
  'mixed.example.org': ['93.184.216.34', '127.0.0.1'],
};

const REBOUND = Object.keys(RESOLVES).filter((name) => name.endsWith('.example.org') && !name.startsWith('v6'));

async function sidecar(allow: readonly string[]): Promise<Sidecar> {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-egress-'));
  const echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => { echo.listen(0, '127.0.0.1', resolve); });
  const dialed = join(dir, 'dialed');
  writeFileSync(dialed, '');
  const world = join(dir, 'world.cjs');
  writeFileSync(world, WORLD);
  const child = spawn(process.execPath, ['-r', world, '-e', EGRESS_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORDEWELL_EGRESS: JSON.stringify({ port: 0, allow }), ORDEWELL_TEST_WORLD: JSON.stringify({ names: RESOLVES, echoPort: (echo.address() as AddressInfo).port, dialed }) },
  });
  live.push({ child, server: echo, dir });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once('data', (line: Buffer) => resolve(Number(/^ready (\d+)/.exec(line.toString())?.[1])));
    child.once('close', () => reject(new Error('the sidecar ended before it listened')));
  });
  return { port, process: child, dialed: () => readFileSync(dialed, 'utf8').split('\n').filter(Boolean) };
}

/** One request, as a client's first bytes, and everything it was answered until the far end closes or goes quiet. */
function asked(port: number, head: string, after?: (write: (text: string) => void) => void): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let said = '';
    const quiet = setTimeout(() => socket.destroy(), 300);
    socket.on('connect', () => socket.write(head));
    socket.on('data', (chunk) => {
      said += chunk.toString();
      quiet.refresh();
      if (said.includes('\r\n\r\n') && after) {
        after((text) => socket.write(text));
        after = undefined;
      }
    });
    socket.on('close', () => resolve(said));
    socket.on('error', () => undefined);
  });
}

const connectTo = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

describe('the egress sidecar (ADR-0059 L7)', () => {
  it('opens a tunnel to a listed host, and carries bytes both ways', async () => {
    const { port, dialed } = await sidecar(['registry.npmjs.org']);

    const said = await asked(port, connectTo('registry.npmjs.org:443'), (write) => write('ping'));

    expect(said).toMatch(/^HTTP\/1\.1 200 /);
    expect(said).toMatch(/ping$/);
    expect(dialed()).toEqual(['104.16.0.34:443']);
  });

  it('reads a host as DNS does, whatever its case or a trailing dot', async () => {
    const { port } = await sidecar(['registry.npmjs.org']);

    expect(await asked(port, connectTo('REGISTRY.npmjs.org.:443'))).toMatch(/^HTTP\/1\.1 200 /);
  });

  it('holds a public IPv6 answer to the same list', async () => {
    const { port, dialed } = await sidecar(['v6.example.org']);

    expect(await asked(port, connectTo('v6.example.org:443'))).toMatch(/^HTTP\/1\.1 200 /);
    expect(dialed()).toEqual(['2606:4700::6810:84e5:443']);
  });

  it('holds a public address beside the range Teredo takes', async () => {
    const { port, dialed } = await sidecar(['v6-beside-teredo.example.org']);

    expect(await asked(port, connectTo('v6-beside-teredo.example.org:443'))).toMatch(/^HTTP\/1\.1 200 /);
    expect(dialed()).toEqual(['2001:4860:4860::8888:443']);
  });

  it('refuses a NUL in a host with a plain answer, and lives to answer the next request', async () => {
    const { port, dialed } = await sidecar(['*.example.com']);

    expect(await asked(port, connectTo('a\0.example.com:443'))).toMatch(/^HTTP\/1\.1 403 /);
    expect(await asked(port, connectTo('a.example.com:443'))).toMatch(/^HTTP\/1\.1 200 /);
    expect(dialed()).toEqual(['93.184.216.34:443']);
  });

  it.each([
    ['a host off the list', 'example.com:443'],
    ['an address, which is on no list', '1.1.1.1:443'],
    ["this host's loopback by its name", 'host.docker.internal:45871'],
    ['the metadata service', '169.254.169.254:80'],
  ])('turns down %s and dials nothing', async (_case, target) => {
    const { port, dialed } = await sidecar(['registry.npmjs.org']);

    expect(await asked(port, connectTo(target))).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed()).toEqual([]);
  });

  it('turns down another port of a listed host', async () => {
    const { port, dialed } = await sidecar(['registry.npmjs.org']);

    expect(await asked(port, connectTo('registry.npmjs.org:22'))).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed()).toEqual([]);
  });

  it('reads a wildcard as subdomains only', async () => {
    const { port } = await sidecar(['*.example.com']);

    expect(await asked(port, connectTo('a.example.com:443'))).toMatch(/^HTTP\/1\.1 200 /);
    expect(await asked(port, connectTo('example.com:443'))).toMatch(/^HTTP\/1\.1 403 /);
    expect(await asked(port, connectTo('evilexample.com:443'))).toMatch(/^HTTP\/1\.1 403 /);
  });

  it.each(REBOUND)('turns down a listed name that answers with a private address: %s', async (name) => {
    const { port, dialed } = await sidecar([name]);

    expect(await asked(port, connectTo(`${name}:443`))).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed()).toEqual([]);
  });

  it('turns down a name that does not resolve', async () => {
    const { port, dialed } = await sidecar(['nowhere.example.net']);

    expect(await asked(port, connectTo('nowhere.example.net:443'))).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed()).toEqual([]);
  });

  it('turns down plain HTTP, whatever its host: only a tunnel of a listed host leaves', async () => {
    const { port, dialed } = await sidecar(['registry.npmjs.org']);

    expect(await asked(port, 'GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed()).toEqual([]);
  });

  it('ends a request that never finishes its head, past any a client sends', async () => {
    const { port } = await sidecar(['registry.npmjs.org']);

    const ended = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.on('connect', () => socket.write('x'.repeat(64 * 1024)));
      socket.on('close', () => resolve(true));
      socket.on('error', () => resolve(true));
      setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    });

    expect(ended).toBe(true);
  });

  it('goes with its host: when the pipe closes, it exits', async () => {
    const { process: child } = await sidecar([]);

    child.stdin?.end();

    await vi.waitFor(() => expect(child.exitCode).toBe(0));
  });
});

describe('a route that could not be opened', () => {
  it('takes down the network it made when the sidecar never starts, so a failed probe leaves nothing', async () => {
    const calls: string[] = [];
    const cli: DockerCli = {
      call: async (args: readonly string[], _opts?: DockerCall): Promise<DockerResult> => {
        calls.push(args.join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
      entry: async () => { throw new Error('docker would not start'); },
    };

    await expect(new SidecarEgress(cli).open({ name: 'ordewell-probe-x', labels: [], limits: [], image: 'img', allow: [], gated: null })).rejects.toThrow('docker would not start');

    expect(calls).toEqual(['network create --internal ordewell-probe-x-net', 'network rm ordewell-probe-x-net']);
  });

  it("keeps a key out of the start error of a sidecar that ended before it listened, which quotes its stderr", async () => {
    const key = fakeSecret('openai');
    const entry = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const cli: DockerCli = {
      call: async (): Promise<DockerResult> => ({ code: 0, stdout: '', stderr: '' }),
      entry: async () => entry as unknown as ChildProcess,
    };
    const opened = new SidecarEgress(cli).open({ name: 'ordewell-probe-y', labels: [], limits: [], image: 'img', allow: [], gated: null });
    await new Promise((resolve) => setImmediate(resolve));
    entry.stderr.write(`node: bad option\nOPENAI_API_KEY=${key}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    entry.emit('close', 1, null);

    const err = await opened.then(() => null, (e: Error) => e);
    expect(err?.message).toContain('The egress sidecar ended before it listened: node: bad option');
    expect(err?.message).not.toContain(key.slice(-12));
  });
});
