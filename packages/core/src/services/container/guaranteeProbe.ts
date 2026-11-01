import { GUARANTEES, type Guarantee, type GuaranteeProof, type GuaranteeReport } from '../executionLease';

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
  gateway: string;
  credentialsVisible: string[];
  loginReadable: boolean;
}

/**
 * Run with `node -e` in the container, as the runner will run, before any
 * runner has: it reads and tries, and says what happened. It decides nothing:
 * {@link judgeProbe} does, on the host.
 */
export const PROBE_SCRIPT = String.raw`
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
  const [metadata, reached] = await Promise.all([connects('169.254.169.254', 80), gateway ? connects(gateway, 9) : 'no route']);
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
    credentialsVisible: asked.credentials.filter((name) => process.env[name] !== undefined),
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
}

/**
 * What a probe's findings prove (ADR-0059 L3). `net.allowlist` is never proven
 * here: an open path has no allowlist, whatever a connection did, and the egress
 * sidecar of L7 is what can prove it. So this lease alone is no network guarantee.
 */
export function judgeProbe(found: ProbeFindings, expected: ProbeExpected, at: string): GuaranteeReport {
  const proof = (proven: boolean, by: string): GuaranteeProof => ({ proven, by, at });
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
    'net.allowlist': proof(false, `nothing limits this lease's network: its gateway answered "${found.gateway}", and only the egress sidecar can prove an allowlist`),
    'net.noMetadata': proof(found.metadata !== 'connected', `a connection to 169.254.169.254:80: ${found.metadata}`),
    'cred.unreadable': proof(
      found.credentialsVisible.length === 0 && !found.loginReadable,
      found.credentialsVisible.length > 0 ? `the runner can read ${found.credentialsVisible.join(', ')}`
        : found.loginReadable ? "the runner can read the person's own sign-in"
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
