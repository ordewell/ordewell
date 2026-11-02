import { ANTHROPIC_API, MODEL_APIS, type ModelApi } from './modelGateway';

/*
 * The name Claude Code reads a subscription's token from, and the shapes such a
 * token takes under any other name: an OAuth access or refresh token, or the
 * credentials file a sign-in writes.
 */
const SUBSCRIPTION_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
const SUBSCRIPTION_VALUE = /^sk-ant-o[ar]t|claudeAiOauth/;

/** Where a person's own sign-in talks to Anthropic, and which a broker's lease never needs: its model traffic takes the gateway. */
export const SIGN_IN_HOSTS: readonly string[] = ['api.anthropic.com', 'claude.ai', 'platform.claude.com'];

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

/** What a lease's login comes to. */
export interface IssuedLogin {
  /** The API key and where it goes, held on this host by the lease's gateway. */
  gated: { key: string; upstream: string; api: ModelApi } | null;
  /** What no gateway can carry, for the runner by name, which it can read. */
  handed: Record<string, string>;
}

function upstreamOf(url: string | undefined, api: ModelApi): string {
  if (url === undefined) return api.upstream;
  const protocol = URL.canParse(url) ? new URL(url).protocol : '';
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error(`${api.baseUrlVariable} must be an http or https address.`);
  return url;
}

function refuseOutranking(variables: readonly string[], { keyVariable, outranksKey }: ModelApi): void {
  const outranking = variables.includes(keyVariable) ? outranksKey.find((variable) => variables.includes(variable)) : undefined;
  if (outranking) throw new Error(`${outranking} outranks ${keyVariable} in the runner it serves, so the two do not make one login: name one or the other.`);
}

/**
 * Holds API keys and cloud-provider credentials for leases, and never a Claude
 * subscription's: Anthropic's terms forbid a product collecting, storing or
 * intermediating one (ADR-0059 L7). An API key stops at the gateway. What a cloud
 * provider's client signs with has to reach it, so a lease with one reports
 * `cred.unreadable` unproven. A login is one for a session's every runner, so a
 * key that serves another runner's API stays here: nothing gates it for this one,
 * and handing it over by name would put it in the clear.
 */
export class CredentialBroker {
  constructor(private readonly source: Record<string, string | undefined>) {}

  issue(variables: readonly string[], api: ModelApi = ANTHROPIC_API): IssuedLogin {
    const others = MODEL_APIS.filter((other) => other !== api).flatMap(({ keyVariable, baseUrlVariable, outranksKey }) => [keyVariable, baseUrlVariable, ...outranksKey]);
    const held = Object.fromEntries(variables.filter((variable) => !others.includes(variable)).map((variable) => [variable, this.hold(variable)]));
    const { [api.keyVariable]: key, [api.baseUrlVariable]: url, ...handed } = held;
    if (key !== undefined) {
      refuseOutranking(variables, api);
      return { gated: { key, upstream: upstreamOf(url, api), api }, handed };
    }
    if (api.keyOnly || Object.keys(held).length === 0) throw new Error(`The container's login holds nothing for ${api.name}: name ${api.keyVariable} in it.`);
    return { gated: null, handed: held };
  }

  /** That every variable is there and none undoes a key, for a surface that asks with no runner in mind: which of them serves which runner waits for {@link issue}. */
  check(variables: readonly string[]): void {
    for (const variable of variables) this.hold(variable);
    for (const api of MODEL_APIS) refuseOutranking(variables, api);
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
