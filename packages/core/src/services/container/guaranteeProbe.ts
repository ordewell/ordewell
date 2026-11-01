import { GUARANTEES, type Guarantee, type GuaranteeProof, type GuaranteeReport } from '../executionLease';

/** Where a cloud's metadata service answers, on any provider. */
export const METADATA = '169.254.169.254:80';

/** How a lease's network is tried, by its probe and by the host that judges it. */
export interface ProbeNetwork {
  /** `host:port`, tried straight out as a client that ignores every setting would: none may answer. */
  outside: readonly string[];
  /** A name only the world's DNS answers: one that resolves is a way out by DNS. */
  name: string;
  /** What its way out must turn down, each with a 403; null where it has no way out to ask. */
  proxy: { refused: readonly string[] } | null;
}

/** What a probe is told to look for: what it finds comes back as {@link ProbeFindings}. */
export interface ProbeAsked {
  /** Where this host's own files are. None may be there. */
  hostPaths: readonly string[];
  /** Where a write must fail. */
  deniedWrites: readonly string[];
  /** Where a write must succeed. */
  workspace: string;
  /** Variables holding a credential, as the lease's runner gets them. */
  credentials: readonly string[];
  /** A login a person signed in to, whose directory the runner reads. */
  login?: string;
  network: ProbeNetwork;
  /** A key held back from the container, as salted digests, so nothing it could read names it. */
  secrets?: { salt: string; digests: readonly string[] };
}

export interface ProbeFindings {
  hostPathsFound: string[];
  mounts: { point: string; type: string }[];
  dockerSocket: boolean;
  writesPassed: string[];
  workspaceWritable: boolean;
  kernel: string;
  memoryMax: string | null;
  swapMax: string | null;
  pidsMax: string | null;
  metadata: string;
  /** How a connection to the default route's gateway ended, or `no route`. */
  gateway: string;
  /** Each of {@link ProbeNetwork.outside}: `connected`, or how it failed. */
  outside: Record<string, string>;
  /** {@link ProbeNetwork.name}: `resolved`, or how it failed. */
  named: string;
  /** Each of what its way out must turn down: the status it answered, or how it failed. */
  proxied: Record<string, string>;
  credentialsVisible: string[];
  /** How many of {@link ProbeAsked.secrets} it found in the environment of a process it can read. */
  secretsFound: number;
  loginReadable: boolean;
}

/**
 * Run with `node -e` in the container, as the runner will run, before any
 * runner has: it reads and tries, and says what happened. It decides nothing:
 * {@link judgeProbe} does, on the host.
 */
export const PROBE_SCRIPT = String.raw`
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const asked = JSON.parse(process.env.ORDEWELL_PROBE);
const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
const exists = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };
function writes(dir) {
  const file = dir.replace(/\/$/, '') + '/.ordewell-probe';
  try { fs.writeFileSync(file, 'probe'); fs.unlinkSync(file); return true; } catch { return false; }
}
const connects = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 1200 });
  const done = (answer) => { socket.destroy(); resolve(answer); };
  socket.on('connect', () => done('connected'));
  socket.on('timeout', () => done('timed out'));
  socket.on('error', (err) => done(err.code ?? 'failed'));
});
const split = (target) => { const at = target.lastIndexOf(':'); return [target.slice(0, at), Number(target.slice(at + 1))]; };
const resolves = (name) => new Promise((resolve) => {
  const limit = setTimeout(() => resolve('timed out'), 1500);
  dns.lookup(name, (err) => { clearTimeout(limit); resolve(err ? err.code ?? 'failed' : 'resolved'); });
});
const proxied = (target, proxy) => new Promise((resolve) => {
  if (!proxy) return resolve('no proxy');
  const { hostname, port } = new URL(proxy);
  const socket = net.connect({ host: hostname, port: Number(port), timeout: 3000 });
  const done = (answer) => { socket.destroy(); resolve(answer); };
  let said = '';
  socket.on('connect', () => socket.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'));
  socket.on('data', (chunk) => { said += chunk; if (said.includes('\r\n')) done(said.split(' ')[1] ?? 'unreadable'); });
  socket.on('timeout', () => done('timed out'));
  socket.on('error', (err) => done(err.code ?? 'failed'));
  socket.on('end', () => done('unreadable'));
});
const tried = async (targets, attempt) => Object.fromEntries(await Promise.all(targets.map(async (target) => [target, await attempt(target)])));
function secretsFound() {
  if (!asked.secrets) return 0;
  const digest = (value) => crypto.createHash('sha256').update(asked.secrets.salt + value).digest('hex');
  const environments = fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).map((pid) => read('/proc/' + pid + '/environ') ?? '');
  const values = new Set(environments.flatMap((environment) => environment.split('\0')).map((entry) => entry.slice(entry.indexOf('=') + 1)));
  return asked.secrets.digests.filter((wanted) => [...values].some((value) => digest(value) === wanted)).length;
}
function gatewayOf() {
  const route = (read('/proc/net/route') ?? '').split('\n').slice(1).map((line) => line.trim().split(/\s+/)).find((fields) => fields[1] === '00000000');
  if (!route) return null;
  return route[2].match(/../g).reverse().map((byte) => parseInt(byte, 16)).join('.');
}
const mounts = (read('/proc/self/mountinfo') ?? '').split('\n').filter(Boolean).map((line) => {
  const [before, after] = line.split(' - ');
  return { point: before.split(' ')[4], type: (after ?? '').split(' ')[0] };
});
(async () => {
  const gateway = gatewayOf();
  const [metadata, reached, outside, named, viaProxy] = await Promise.all([
    connects(...split('${METADATA}')),
    gateway ? connects(gateway, 9) : 'no route',
    tried(asked.network.outside, (target) => connects(...split(target))),
    resolves(asked.network.name),
    tried(asked.network.proxy?.refused ?? [], (target) => proxied(target, process.env.HTTPS_PROXY)),
  ]);
  process.stdout.write(JSON.stringify({
    hostPathsFound: asked.hostPaths.filter(exists),
    mounts,
    dockerSocket: exists('/var/run/docker.sock') || exists('/run/docker.sock'),
    writesPassed: asked.deniedWrites.filter(writes),
    workspaceWritable: writes(asked.workspace),
    kernel: [read('/proc/sys/kernel/ostype'), read('/proc/sys/kernel/osrelease')].join(' '),
    memoryMax: read('/sys/fs/cgroup/memory.max'),
    swapMax: read('/sys/fs/cgroup/memory.swap.max'),
    pidsMax: read('/sys/fs/cgroup/pids.max'),
    metadata,
    gateway: reached,
    outside,
    named,
    proxied: viaProxy,
    credentialsVisible: asked.credentials.filter((name) => process.env[name] !== undefined),
    secretsFound: secretsFound(),
    loginReadable: asked.login !== undefined && exists(asked.login),
  }));
})();
`;

/** A mount a host's folder arrives through, whatever it is called. */
const SHARED_FILESYSTEM = /^(virtiofs|9p|nfs4?|cifs|smb3?|vboxsf|fuse\..*|fakeowner)$/;

/** The kernel's own, and Docker's for any container. Nothing there is a folder of the host's. */
const KERNEL_MOUNT = /^\/(proc|sys|dev)(\/|$)/;
const DOCKER_MOUNTS = new Set(['/', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/sbin/docker-init', '/usr/sbin/docker-init', '/usr/libexec/docker/docker-init']);

/** What the lease expects it mounted; anything else is a mount it cannot account for. */
export interface ProbeExpected {
  mounts: readonly string[];
  memoryBytes: number;
  pids: number;
  /** This host's kernel, to tell from the one the probe ran on. */
  hostKernel: string;
  network: ProbeNetwork;
  /** Connections this host's own listener took while the probe ran: only a container could have made them. */
  loopbackHits: number;
  /** Its key stays at this host's gateway, so the probe looked for it. */
  gated?: boolean;
}

/**
 * Why the network of a lease is not limited, or null. A target the probe says
 * nothing of counts against it: a probe that stopped early proves nothing, and
 * a proxy only proves what it turned down, so one that never answered fails too.
 */
function networkLeak(found: ProbeFindings, { network, loopbackHits }: ProbeExpected): string | null {
  if (loopbackHits > 0) return `a connection from the container reached this host's loopback, ${loopbackHits} times`;
  const reached = network.outside.filter((target) => (found.outside[target] ?? 'connected') === 'connected');
  if (reached.length > 0) return `a connection reached ${reached.join(', ')}`;
  if (found.gateway !== 'no route') return `the container has a route out: its gateway answered "${found.gateway}"`;
  if (found.named === 'resolved') return `${network.name} resolved, so DNS is a way out`;
  const passed = (network.proxy?.refused ?? []).filter((target) => found.proxied[target] !== '403');
  if (passed.length > 0) return `its way out did not turn down ${passed.map((target) => `${target} ("${found.proxied[target]}")`).join(', ')}`;
  return null;
}

/** What a probe's findings prove (ADR-0059 L3): a guarantee is what was tried and stopped, never how the lease was built. */
export function judgeProbe(found: ProbeFindings, expected: ProbeExpected, at: string): GuaranteeReport {
  const proof = (proven: boolean, by: string): GuaranteeProof => ({ proven, by, at });
  const leak = networkLeak(found, expected);
  const metadataVia = expected.network.proxy ? found.proxied[METADATA] : '403';
  const strange = found.mounts.filter(({ point, type }) => SHARED_FILESYSTEM.test(type) || !(KERNEL_MOUNT.test(point) || DOCKER_MOUNTS.has(point) || expected.mounts.includes(point)));
  const report: Record<Guarantee, GuaranteeProof> = {
    'fs.hostHidden': proof(
      found.hostPathsFound.length === 0 && strange.length === 0 && !found.dockerSocket,
      found.dockerSocket ? 'a Docker socket is inside the container'
        : found.hostPathsFound.length > 0 ? `this host's ${found.hostPathsFound.join(', ')} can be read inside the container`
          : strange.length > 0 ? `mounted beyond what the lease asked for: ${strange.map((m) => `${m.point} (${m.type})`).join(', ')}`
            : "no path of this host exists inside the container, and every mount is the lease's own",
    ),
    'fs.writeScope': proof(
      found.workspaceWritable && found.writesPassed.length === 0,
      found.writesPassed.length > 0 ? `a write reached ${found.writesPassed.join(', ')}`
        : found.workspaceWritable ? 'writes to the root filesystem and the mirror fail, and the workspace takes one'
          : 'the workspace took no write',
    ),
    'net.allowlist': proof(leak === null, leak ?? 'no address outside answered, no name outside resolved, and its way out turned down what is off its list'),
    'net.noMetadata': proof(
      found.metadata !== 'connected' && metadataVia === '403',
      metadataVia === '403' ? `a connection to ${METADATA}: ${found.metadata}` : `its proxy answered "${metadataVia}" for ${METADATA}`,
    ),
    'cred.unreadable': proof(
      found.credentialsVisible.length === 0 && found.secretsFound === 0 && !found.loginReadable,
      found.credentialsVisible.length > 0 ? `the runner can read ${found.credentialsVisible.join(', ')}`
        : found.secretsFound > 0 ? 'a key its gateway should hold is in the container'
          : found.loginReadable ? "the runner can read the person's own sign-in"
            : expected.gated ? "the key stays at this host's gateway, and its value is in no environment the container can read"
              : 'this lease carries no credential',
    ),
    'kernel.separate': proof(found.kernel !== expected.hostKernel, `the container runs ${found.kernel}, this host ${expected.hostKernel}`),
    'limits.memory': proof(
      found.memoryMax === String(expected.memoryBytes) && found.swapMax === '0' && found.pidsMax === String(expected.pids),
      `the container's cgroup says memory ${found.memoryMax}, swap ${found.swapMax}, processes ${found.pidsMax}`,
    ),
  };
  return Object.fromEntries(GUARANTEES.map((guarantee) => [guarantee, report[guarantee]])) as GuaranteeReport;
}
