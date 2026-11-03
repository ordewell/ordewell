import { GUARANTEES, type Guarantee } from '../executionLease';
import { parseLogin, type LeaseLogin } from './credentialBroker';
import { HOME_DIR } from './taskWorkspace';

/** Limits every container takes, a helper's and a sidecar's too; memory is the setting's. One count, so a fork bomb stays in its cgroup. */
export const PIDS_LIMIT = 8192;

/** The image's unprivileged user. Named volumes take their owner from the image, so a task image is built for this one. */
const CONTAINER_USER = '1000:1000';

/** Package caches a container keeps in the engine, by name, never by a host's path, and the variable that points a tool at one. */
export const CACHE_VARIABLES = {
  npm: 'npm_config_cache',
  pip: 'PIP_CACHE_DIR',
  cargo: 'CARGO_HOME',
  go: 'GOMODCACHE',
} as const;

export type CacheName = keyof typeof CACHE_VARIABLES;

/** What a cache is filled from: naming a cache says a task installs from there, so it is on the list unless `allow` says otherwise. */
const REGISTRIES: Record<CacheName, readonly string[]> = {
  npm: ['registry.npmjs.org'],
  pip: ['pypi.org', 'files.pythonhosted.org'],
  cargo: ['index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
};

/** A name, or its subdomains by `*.`. An address is no entry: nothing on the list may be private, and a number hides that. */
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/i;

const isCache = (name: unknown): name is CacheName => typeof name === 'string' && Object.hasOwn(CACHE_VARIABLES, name);
const isGuarantee = (name: unknown): name is Guarantee => GUARANTEES.includes(name as Guarantee);
const isHost = (name: unknown): name is string => typeof name === 'string' && HOST.test(name) && !/^[\d.]+$/.test(name);

/** What a container proves on every engine. `kernel.separate` needs a VM, and `cred.unreadable` a login that can stop short of the runner. */
const DEFAULT_REQUIRED: readonly Guarantee[] = ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata'];
const DEFAULT_MEMORY = '4g';
const DEFAULT_CACHES: readonly CacheName[] = ['npm'];

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** The `containers` setting, read. A checkout's surfaces set it (`changeContainers`); the settings file holds the rest. */
export interface ContainerSettings {
  /** The image the user built: Ordewell publishes none (ADR-0059 L5). */
  image: string;
  /** Docker's own words for the memory limit, which is also the limit on memory and swap together. */
  memory: string;
  memoryBytes: number;
  /** Which login it runs under, which a person chooses: it has no default. */
  login: LeaseLogin;
  caches: readonly CacheName[];
  /** The hosts a lease's sidecar opens: what `allow` names, or the registries of its caches. */
  allow: readonly string[];
  /** Guarantees an open fails without (L3). */
  required: readonly Guarantee[];
}

/** Limits and hardening for every container of a lease, in the order `docker run` reads them. */
export function containerLimits(settings: ContainerSettings): string[] {
  return [
    '--init', '--pids-limit', String(PIDS_LIMIT), '--memory', settings.memory, '--memory-swap', settings.memory,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--user', CONTAINER_USER,
  ];
}

/** Not secrets: what is goes by name, in the CLI's environment. */
export const envArgs = (variables: Readonly<Record<string, string>>): string[] => Object.entries(variables).flatMap(([variable, value]) => ['-e', `${variable}=${value}`]);

/** A throwaway container with no network and no runner in it, for what is done to a volume. Not free of an attempt's code: see `EXPORT_SCRIPT`. */
export function helperArgs(settings: ContainerSettings, volumes: readonly string[], variables: Readonly<Record<string, string>> = {}, labels: readonly string[] = []): string[] {
  return ['run', '--rm', '-i', ...labels, ...containerLimits(settings), '--network', 'none', ...volumes.flatMap((volume) => ['-v', volume]), ...envArgs({ HOME: HOME_DIR, ...variables }), settings.image];
}

function bytesOf(memory: string): number | null {
  const match = /^(\d+)([bkmg])$/i.exec(memory);
  const bytes = match ? Number(match[1]) * UNITS[match[2].toLowerCase()] : 0;
  return bytes > 0 ? bytes : null;
}

/** It sits in a `docker run`, after the options, where a leading dash would be one more of them. */
export const isImage = (image: unknown): image is string => typeof image === 'string' && /^[a-z0-9][\w.:/@-]*$/i.test(image);

/**
 * A setting it cannot use refuses every container, where the rest of the
 * settings file falls back to a default: having asked for a container, a user
 * must not get the host instead on a typing mistake.
 */
export function parseContainerSettings(raw: unknown): ContainerSettings | { refused: string } {
  if (typeof raw !== 'object' || raw === null) return { refused: 'the containers setting must be an object' };
  const { image, memory = DEFAULT_MEMORY, login, caches = DEFAULT_CACHES, allow, required = DEFAULT_REQUIRED } = raw as Record<string, unknown>;
  if (!isImage(image)) return { refused: 'containers.image must name the image you built' };
  const memoryBytes = typeof memory === 'string' ? bytesOf(memory) : null;
  if (typeof memory !== 'string' || memoryBytes === null) return { refused: 'containers.memory must be a size such as "4g"' };
  if (!Array.isArray(caches) || !caches.every(isCache)) return { refused: `containers.caches may name ${Object.keys(CACHE_VARIABLES).join(', ')}` };
  if (allow !== undefined && (!Array.isArray(allow) || !allow.every(isHost))) return { refused: 'containers.allow must list host names, such as "github.com" or "*.example.com"' };
  if (!Array.isArray(required) || !required.every(isGuarantee)) return { refused: `containers.required may name ${GUARANTEES.join(', ')}` };
  const chosen = parseLogin(login);
  if ('refused' in chosen) return chosen;
  return { image, memory, memoryBytes, login: chosen, caches, allow: (allow as readonly string[] | undefined)?.map((host) => host.toLowerCase()) ?? caches.flatMap((cache) => REGISTRIES[cache]), required };
}
