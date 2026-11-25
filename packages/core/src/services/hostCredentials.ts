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
