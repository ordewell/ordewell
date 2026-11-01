/*
 * The name Claude Code reads a subscription's token from, and the shapes such a
 * token takes under any other name: an OAuth access or refresh token, or the
 * credentials file a sign-in writes.
 */
const SUBSCRIPTION_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
const SUBSCRIPTION_VALUE = /^sk-ant-o[ar]t|claudeAiOauth/;

/**
 * Which login a container runs under, which a person chooses and nothing here
 * guesses: `broker`, API keys or cloud credentials from this host's environment,
 * or `own-sign-in`, the person's own sign-in to the unmodified binary, made
 * inside a container and kept in a volume Ordewell never reads (ADR-0059 L7).
 */
export type LeaseLogin =
  | { kind: 'broker'; variables: readonly string[] }
  | { kind: 'own-sign-in' };

/** The `login` of the `containers` setting; an unusable one refuses the lease, and never falls back to another. */
export function parseLogin(raw: unknown): LeaseLogin | { refused: string } {
  if (raw === undefined) return { refused: 'containers.login is not set: choose "broker" with the variables to hand over, or "own-sign-in"' };
  if (typeof raw === 'object' && raw !== null && 'kind' in raw) {
    if (raw.kind === 'own-sign-in') return { kind: 'own-sign-in' };
    if (raw.kind === 'broker' && 'variables' in raw && Array.isArray(raw.variables) && raw.variables.length > 0 && raw.variables.every((name): name is string => typeof name === 'string')) {
      return { kind: 'broker', variables: raw.variables };
    }
  }
  return { refused: 'containers.login must be {"kind":"broker","variables":[...]} or {"kind":"own-sign-in"}' };
}

/**
 * Holds API keys and cloud-provider credentials for leases, and never a Claude
 * subscription's: Anthropic's terms forbid a product collecting, storing or
 * intermediating one (ADR-0059 L7). What a lease gets today is the variable
 * itself, which its runner can read, so such a lease reports `cred.unreadable`
 * unproven; the gateway of L7 is where a key stops reaching the container.
 */
export class CredentialBroker {
  constructor(private readonly source: Record<string, string | undefined>) {}

  issue(variables: readonly string[]): Record<string, string> {
    return Object.fromEntries(variables.map((variable) => [variable, this.hold(variable)]));
  }

  private hold(variable: string): string {
    const value = this.source[variable];
    if (variable === SUBSCRIPTION_VARIABLE || value !== undefined && SUBSCRIPTION_VALUE.test(value)) {
      throw new Error(`${variable} holds a Claude subscription's token, which Ordewell never carries: use an API key, or the "own-sign-in" login.`);
    }
    if (value === undefined || value === '') throw new Error(`${variable} is not set, and the container's login names it.`);
    return value;
  }
}
