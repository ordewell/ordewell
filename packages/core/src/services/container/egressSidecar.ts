import type { ChildProcess } from 'child_process';
import { settleWithin } from '../harness/settleWithin';
import type { IssuedLogin } from './credentialBroker';
import { envArgs } from './containerSettings';
import type { DockerCli } from './dockerCli';
import { ModelGateway } from './modelGateway';
import { LineTail } from '../../utils/lineTail';
import { redactAgentText } from '../../utils/redactSecrets';

/**
 * What an egress sidecar runs (ADR-0059 L7), handed to `node -e`, so it needs
 * nothing of an image but the node a lease's image has. A forward proxy that
 * opens one kind of thing, a CONNECT to port 443 of a host on the lease's list,
 * and reads none of what passes through it: TLS stays end to end.
 *
 * A name is resolved here, and the answer checked and dialed as it stands, so a
 * listed name cannot be rebound to this sidecar's other network, which reaches
 * the engine's host and every container on the bridge. It listens on the one
 * network it has as it starts, the lease's: the bridge joins after, and nothing on
 * that is its client. Its stdin is its lease, as the relay's is: when the host goes
 * the pipe closes and `--rm` takes it.
 */
export const EGRESS_ENTRY = String.raw`
const dns = require('dns');
const net = require('net');
const os = require('os');
const { port, allow } = JSON.parse(process.env.ORDEWELL_EGRESS);
const four = new net.BlockList();
const six = new net.BlockList();
const FOUR = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]];
for (const [address, prefix] of FOUR) four.addSubnet(address, prefix, 'ipv4');
// All but global unicast, then its parts that hold an IPv4 address or none. A list of its own: one list reads an IPv4 address as mapped, inside ::/3.
const SIX = [['::', 3], ['4000::', 2], ['8000::', 1], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16]];
for (const [address, prefix] of SIX) six.addSubnet(address, prefix, 'ipv6');
const listed = (host) => allow.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry));
const isPrivate = ({ address, family }) => (family === 6 ? six.check(address, 'ipv6') : four.check(address, 'ipv4'));
function answer(client, status, why) {
  client.end('HTTP/1.1 ' + status + '\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(why) + '\r\nConnection: close\r\n\r\n' + why);
}
const refuse = (client, why) => answer(client, '403 Forbidden', why + '\n');
function tunnel(client, host, early) {
  dns.lookup(host, { all: true }, (err, addresses) => {
    if (err || addresses.length === 0 || addresses.some(isPrivate)) return refuse(client, host + ' has no public address.');
    const upstream = net.connect({ host: addresses[0].address, port: 443 });
    let joined = false;
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.once('connect', () => {
      joined = true;
      upstream.setTimeout(0);
      client.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (early.length > 0) upstream.write(early);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => undefined);
    upstream.once('close', () => (joined ? client.destroy() : answer(client, '502 Bad Gateway', host + ' did not answer.\n')));
    client.once('close', () => upstream.destroy());
  });
}
function handle(client, head, early) {
  const [line] = head.toString('latin1').split('\r\n');
  // A DNS name and nothing else: dns.lookup throws on a NUL, and here that would end the sidecar.
  const asked = /^CONNECT ([\w.-]+):(\d+) HTTP\/1\.[01]$/.exec(line);
  if (!asked) return refuse(client, 'Only a CONNECT to a host on this task\'s list leaves here.');
  const host = asked[1].toLowerCase().replace(/\.$/, '');
  if (asked[2] !== '443' || !listed(host)) return refuse(client, asked[1] + ':' + asked[2] + ' is not on this task\'s list: add the host to containers.allow.');
  tunnel(client, host, early);
}
const server = net.createServer((client) => {
  let read = Buffer.alloc(0);
  client.setTimeout(15000, () => client.destroy());
  client.on('error', () => undefined);
  const reading = (chunk) => {
    read = Buffer.concat([read, chunk]);
    const end = read.indexOf('\r\n\r\n');
    // Past any CONNECT a client has reason to send.
    if (end < 0 && read.length > 16384) return client.destroy();
    if (end < 0) return;
    client.off('data', reading);
    client.pause();
    handle(client, read.subarray(0, end), read.subarray(end + 4));
  };
  client.on('data', reading);
});
const [inside] = Object.values(os.networkInterfaces()).flat().filter(({ family, internal }) => family === 'IPv4' && !internal);
server.listen(port, inside.address, () => process.stdout.write('ready ' + server.address().port + '\n'));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
`;

const EGRESS_PORT = 3128;
const SIDECAR_START_MS = 60_000;
/** What its start error shows of the sidecar's stderr, of a larger tail kept whole so redaction reads every line it shows (see LineTail). */
const STDERR_LIMITS = { keepChars: 8000, showChars: 2000 };

/** One lease, as its way out needs it. */
export interface EgressLease {
  /** Its container's name, which what it needs is named from. */
  name: string;
  /** `docker` arguments naming whose it is, for a clean-up to find. */
  labels: readonly string[];
  /** The limits every container takes. */
  limits: readonly string[];
  image: string;
  /** The hosts it opens. */
  allow: readonly string[];
  /** The API key its model traffic goes under, which stays on this host. */
  gated: IssuedLogin['gated'];
}

/** One lease's way out, made before its container and gone after it. */
export interface EgressRoute {
  runArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Whether a proxy answers here, for the probe to ask. */
  proxied: boolean;
  /** A listener on this host's loopback for the relay to carry, and what a runner holds to use it. */
  gateway: { port: number; env: Readonly<Record<string, string>> } | null;
  close(): Promise<void>;
}

/** How a lease's container reaches beyond itself. Proven by the probe, whichever path it is: nothing here is taken on trust (L3). */
export interface EgressPath {
  open(lease: EgressLease): Promise<EgressRoute>;
}

/** No network at all: a lease with nothing to reach, as a sealed run has none (ADR-0056 M9). */
export const NO_WAY_OUT: EgressRoute = { runArgs: ['--network', 'none'], env: {}, proxied: false, gateway: null, close: async () => undefined };

/** Each spelling a client reads. A relay's listener is on the container's own loopback, so a client must not ask the proxy for it. */
function proxyEnv(url: string): Record<string, string> {
  return {
    HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  };
}

function listening(entry: ChildProcess): Promise<void> {
  const tail = new LineTail(STDERR_LIMITS);
  entry.stderr?.on('data', (chunk: Buffer) => tail.append(chunk.toString()));
  return new Promise<void>((resolve, reject) => {
    entry.stdout?.once('data', () => resolve());
    entry.once('error', reject);
    entry.once('close', () => {
      const said = tail.read(redactAgentText);
      reject(new Error(`The egress sidecar ended before it listened${said ? `: ${said}` : '.'}`));
    });
  });
}

/**
 * The egress of L7: an internal network, which the measured ways out do not
 * cross (ADR-0059 L7), one sidecar on it and on the bridge, and the model gateway
 * on this host. A client that ignores the proxy then fails rather than leaks. The
 * network outlives a host that dies, so it is labelled for a clean-up to find; the
 * sidecar goes with its pipe, and the gateway with its host.
 */
export class SidecarEgress implements EgressPath {
  constructor(private readonly cli: DockerCli) {}

  async open({ name, labels, limits, image, allow, gated }: EgressLease): Promise<EgressRoute> {
    const network = `${name}-net`;
    const sidecar = `${name}-egress`;
    const made = await this.cli.call(['network', 'create', '--internal', ...labels, network]);
    if (made.code !== 0) throw new Error(`Could not make the lease's network: ${made.stderr.trim()}`);
    const told = envArgs({ ORDEWELL_EGRESS: JSON.stringify({ port: EGRESS_PORT, allow }) });
    const entry = await this.cli.entry([
      'run', '-i', '--rm', '--name', sidecar, ...labels, ...limits, '--network', network, ...told.args,
      image, 'node', '-e', EGRESS_ENTRY,
    ], { env: told.env }).catch(async (err: unknown) => {
      await this.cli.call(['network', 'rm', network]);
      throw err;
    });
    const gateway = gated ? new ModelGateway(gated) : null;
    let closing: Promise<void> | null = null;
    const close = () => closing ??= (async () => {
      entry.stdin?.end();
      await this.cli.call(['rm', '-f', sidecar]);
      await this.cli.call(['network', 'rm', network]);
      await gateway?.close();
    })();
    try {
      const port = await gateway?.listen();
      await settleWithin(listening(entry), { timeoutMs: SIDECAR_START_MS, onTimeout: () => { throw new Error('The egress sidecar did not start in time.'); } });
      const joined = await this.cli.call(['network', 'connect', 'bridge', sidecar]);
      if (joined.code !== 0) throw new Error(`Could not give the egress sidecar its way out: ${joined.stderr.trim()}`);
      return {
        runArgs: ['--network', network],
        env: proxyEnv(`http://${sidecar}:${EGRESS_PORT}`),
        proxied: true,
        gateway: gateway && port !== undefined ? { port, env: { [gated!.api.keyVariable]: gateway.token, [gated!.api.baseUrlVariable]: `http://127.0.0.1:${port}${gated!.api.basePath}` } } : null,
        close,
      };
    } catch (err) {
      await close();
      throw err;
    }
  }
}
