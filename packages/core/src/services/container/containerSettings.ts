import { GUARANTEES, type Guarantee } from '../executionLease';
import { parseLogin, type LeaseLogin } from './credentialBroker';

/** Package caches a container keeps in the engine, by name, never by a host's path, and the variable that points a tool at one. */
export const CACHE_VARIABLES = {
  npm: 'npm_config_cache',
  pip: 'PIP_CACHE_DIR',
  cargo: 'CARGO_HOME',
  go: 'GOMODCACHE',
} as const;

export type CacheName = keyof typeof CACHE_VARIABLES;

const isCache = (name: unknown): name is CacheName => typeof name === 'string' && Object.hasOwn(CACHE_VARIABLES, name);
const isGuarantee = (name: unknown): name is Guarantee => GUARANTEES.includes(name as Guarantee);

/** What a container proves on every engine. `kernel.separate` needs a VM, and the network and credentials need L7. */
const DEFAULT_REQUIRED: readonly Guarantee[] = ['fs.hostHidden', 'fs.writeScope', 'limits.memory'];
const DEFAULT_MEMORY = '4g';
const DEFAULT_CACHES: readonly CacheName[] = ['npm'];

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** The `containers` setting, read: set in the file only, and no surface offers it. */
export interface ContainerSettings {
  /** The image the user built: Ordewell publishes none (ADR-0059 L5). */
  image: string;
  /** Docker's own words for the memory limit, which is also the limit on memory and swap together. */
  memory: string;
  memoryBytes: number;
  /** Which login it runs under, which a person chooses: it has no default. */
  login: LeaseLogin;
  caches: readonly CacheName[];
  /** Guarantees an open fails without (L3). */
  required: readonly Guarantee[];
}

function bytesOf(memory: string): number | null {
  const match = /^(\d+)([bkmg])$/i.exec(memory);
  return match ? Number(match[1]) * UNITS[match[2].toLowerCase()] : null;
}

/**
 * A setting it cannot use refuses every container, where the rest of the
 * settings file falls back to a default: having asked for a container, a user
 * must not get the host instead on a typing mistake.
 */
export function parseContainerSettings(raw: unknown): ContainerSettings | { refused: string } {
  if (typeof raw !== 'object' || raw === null) return { refused: 'the containers setting must be an object' };
  const { image, memory = DEFAULT_MEMORY, login, caches = DEFAULT_CACHES, required = DEFAULT_REQUIRED } = raw as Record<string, unknown>;
  if (typeof image !== 'string' || image === '') return { refused: 'containers.image must name the image you built' };
  const memoryBytes = typeof memory === 'string' ? bytesOf(memory) : null;
  if (typeof memory !== 'string' || memoryBytes === null) return { refused: 'containers.memory must be a size such as "4g"' };
  if (!Array.isArray(caches) || !caches.every(isCache)) return { refused: `containers.caches may name ${Object.keys(CACHE_VARIABLES).join(', ')}` };
  if (!Array.isArray(required) || !required.every(isGuarantee)) return { refused: `containers.required may name ${GUARANTEES.join(', ')}` };
  const chosen = parseLogin(login);
  if ('refused' in chosen) return chosen;
  return { image, memory, memoryBytes, login: chosen, caches, required };
}
