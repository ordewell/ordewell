import { randomBytes } from 'crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { release, tmpdir, type as osType } from 'os';
import { join } from 'path';
import type { GuaranteeReport } from '../executionLease';
import { containerLimits, envArgs, PIDS_LIMIT, type ContainerSettings } from './containerSettings';
import { ALL_SIGN_IN_HOSTS } from './containerRunners';
import type { DockerCli } from './dockerCli';
import type { EgressPath, EgressRoute } from './egressSidecar';
import { judgeProbe, METADATA, PROBE_SCRIPT, type ProbeAsked, type ProbeExpected, type ProbeFindings, type ProbeNetwork } from './guaranteeProbe';
import { MIRROR_ROOT, TASK_ROOT } from './taskWorkspace';

/** What was measured to reach this host's loopback from a bridge container, on each engine that has a name for it. */
const HOST_NAMES = ['host.docker.internal', 'host.lima.internal', 'host.containers.internal'];

/** Out on the internet by number, and a name only the world's DNS answers (ADR-0059 L3). */
const OUTSIDE = '1.1.1.1:443';
const OUTSIDE_NAME = 'example.com';

/** Past a probe's own timeouts. A killed `docker run` leaves its container running, which is why {@link proveEngine} names one. */
const PROBE_MS = 120_000;

/** What a check plants on this host for a container not to find: unlike what a probe says, a connection it took cannot be a lie. */
export interface Canaries {
  file: string;
  loopbackHits: () => number;
  port: number;
}

function plantFile(): { file: string; remove: () => void } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ordewell-canary-'));
  const file = join(dir, 'canary');
  writeFileSync(file, randomBytes(16).toString('hex'));
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function listenOnLoopback(): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = createServer((socket) => {
    hits += 1;
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, hits: () => hits, close: () => server.close() }));
  });
}

/** Both canaries for as long as `use` runs, and neither past it, whatever it throws. */
export async function withCanaries<T>(use: (canaries: Canaries) => Promise<T>): Promise<T> {
  const planted = plantFile();
  try {
    const loopback = await listenOnLoopback();
    try {
      return await use({ file: planted.file, port: loopback.port, loopbackHits: loopback.hits });
    } finally {
      loopback.close();
    }
  } finally {
    planted.remove();
  }
}

export function networkAsked(route: EgressRoute, port: number): ProbeNetwork {
  const outside = [OUTSIDE, ...HOST_NAMES.map((name) => `${name}:${port}`)];
  return { outside, name: OUTSIDE_NAME, proxy: route.proxied ? { refused: [...outside, METADATA] } : null };
}

export function probeExpected(settings: ContainerSettings, mounts: readonly string[]): Pick<ProbeExpected, 'mounts' | 'memoryBytes' | 'pids' | 'hostKernel'> {
  return { mounts, memoryBytes: settings.memoryBytes, pids: PIDS_LIMIT, hostKernel: `${osType()} ${release()}` };
}

export function probeFindings(stdout: string, stderr: string): ProbeFindings {
  try {
    return JSON.parse(stdout) as ProbeFindings;
  } catch {
    throw new Error(`The container's guarantees could not be proven: its probe said nothing readable${stderr.trim() ? ` (${stderr.trim()})` : ''}.`);
  }
}

export interface ProofDeps {
  cli: DockerCli;
  egress: EgressPath;
  /** Whose it is, for a clean-up to find what a host that died left behind. */
  labels: readonly string[];
}

/**
 * What a throwaway container proves, on the way out a lease would take, for a
 * surface to report before any task runs. It leaves nothing: its container is
 * named so it can be removed before the network it sits on, which will not go
 * while a container is attached, and `--rm` does not cover a CLI that was killed.
 */
export async function proveEngine(settings: ContainerSettings, { cli, egress, labels }: ProofDeps): Promise<GuaranteeReport> {
  return withCanaries(async ({ file, port, loopbackHits }) => {
    const name = `ordewell-probe-${randomBytes(4).toString('hex')}`;
    const allow = [...settings.allow, ...(settings.login.kind === 'own-sign-in' ? ALL_SIGN_IN_HOSTS : [])];
    const route = await egress.open({ name, labels: [...labels], limits: containerLimits(settings), image: settings.image, allow, gated: null });
    const box = `${name}-check`;
    try {
      const network = networkAsked(route, port);
      const flags = [...containerLimits(settings), ...route.runArgs, '--tmpfs', `${TASK_ROOT}:uid=1000,gid=1000`, ...envArgs(route.env)];
      const asked: ProbeAsked = { hostPaths: [file], deniedWrites: ['/', '/usr', '/etc', MIRROR_ROOT], workspace: TASK_ROOT, credentials: [], network };
      const ran = await cli.call(['run', '--rm', '--name', box, ...labels, ...flags, '-e', `ORDEWELL_PROBE=${JSON.stringify(asked)}`, settings.image, 'node', '-e', PROBE_SCRIPT], { timeoutMs: PROBE_MS });
      return judgeProbe(probeFindings(ran.stdout, ran.stderr), { ...probeExpected(settings, [TASK_ROOT, '/tmp']), network, loopbackHits: loopbackHits(), loginUntried: true }, new Date().toISOString());
    } finally {
      await cli.call(['rm', '-f', box]);
      await route.close();
    }
  });
}
