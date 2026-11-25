/**
 * Provider credentials a host holds outside its process environment, lent to
 * the built-in runner alone (ADR-0070). VS Code keeps the keys a user enters
 * in its SecretStorage: put into the extension host's environment they would
 * reach every process it spawns, a coding agent's included, and every other
 * extension running beside it. So the extension registers a reader here, and
 * the runner's listing, defaults, catalog and start read their provider
 * through `withHostCredentials`; nothing spawned is handed them. A host that
 * registers none, the daemon whose keys are its environment, reads that alone.
 * The reader is shown the environment it lends over, so a credential it holds
 * only as a fallback can give way to one that environment already has.
 */
export type HostCredentialReader = (env: Readonly<Record<string, string | undefined>>) => Readonly<Record<string, string>>;

let reader: HostCredentialReader | undefined;

/** Registers the host's reader, asked afresh on every look so a key just stored is seen at once; undefined removes it. */
export function setHostCredentials(read: HostCredentialReader | undefined): void {
  reader = read;
}

/**
 * `env` with the host's credentials over it, as the built-in runner reads its
 * provider: what the host holds wins, as the host's own planner config reads it.
 */
export function withHostCredentials<E extends Readonly<Record<string, string | undefined>>>(env: E): E {
  const held = reader?.(env);
  return held && Object.keys(held).length > 0 ? { ...env, ...held } : env;
}

let sharedReader: HostCredentialReader | undefined;

/**
 * Registers the reader of the provider keys a host has in Ordewell's shared
 * store (`~/.ordewell/.env`, which Desktop and `/key-set` write) but keeps out
 * of its environment, as VS Code does; undefined removes it. The CLI and the
 * daemon load that file into their environment, so they register none. It
 * answers, under the environment a spawn would start with, each saved key the
 * environment has none for, paired with the endpoint saved beside it or the
 * provider's default, never a key the host keeps privately. Only an agent's
 * own credential hook that accepts such a pair (Cline's, ADR-0060 R9) asks
 * it, and what it answers reaches that hook alone.
 */
export function setSharedProviderCredentials(read: HostCredentialReader | undefined): void {
  sharedReader = read;
}

/** The shared store's keys `env` lacks, as the registered reader answers them, read afresh; none where no reader is registered. */
export function sharedProviderCredentials(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return sharedReader?.(env) ?? {};
}
