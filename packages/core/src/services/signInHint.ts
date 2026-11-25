import type { AiProvider } from '../interfaces/IConfig';
import { commandLine } from '../models/ScriptTask';
import { runnerCommand, type RunnerManifest } from '../plugins/types';
import { VENDORS } from './apiProviders';

/**
 * A key Ordewell hands an agent in place of its own sign-in (ADR-0060, R9): the
 * vendor a person picks in the key entry, and the others that would do too.
 */
export interface KeySignInRoute {
  provider: AiProvider;
  /** A noun phrase for the other vendors that work, e.g. "any OpenAI-compatible provider". */
  others?: string;
}

/**
 * Every way into one signed-out agent, as data, so the daemon, the terminal,
 * the headless CLI and VS Code all word it from the same source (ADR-0052).
 * Built from the manifest and the connector's profile; it crosses the wire
 * with the runner's verdict.
 */
export interface RunnerSignIn {
  runner: string;
  label: string;
  /** The agent's own login, which Ordewell can run for the person. */
  login?: string[];
  key?: { provider: AiProvider; label: string; others?: string };
  /** How the agent signs in where Ordewell runs nothing for it, as a clause. */
  byHand?: string;
  /**
   * Its credential hook found no key Ordewell could hand it (ADR-0060, R9):
   * the agent was never asked, so this is no sign-out, and a way in counts
   * only if it leaves a key that hook reads.
   */
  needsKey?: true;
}

/**
 * A key-less agent whose own setup is the only way to store a key Ordewell
 * reads (Cline's `cline auth`): Ordewell's key entry has no route to it, so
 * its login is offered as that setup, never as a sign-in or a key entry.
 */
export function setsUpKey(signIn: RunnerSignIn | undefined): signIn is RunnerSignIn & { login: string[] } {
  return signIn?.needsKey === true && !signIn.key && (signIn.login?.length ?? 0) > 0;
}

/**
 * A runner's credential hook found no key to start it with (ADR-0060, R9).
 * Its message is the hook's own and names no credential, so discovery keeps
 * it as the reason the runner lists nothing; a hook that throws anything else
 * is told as the runner's sign-in hint instead, since its words could quote
 * what it read.
 */
export class RunnerCredentialRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerCredentialRefusal';
  }
}

/**
 * An agent's own refusal to start because its user is signed out, as its
 * protocol said it (ACP's auth-required error), never read from its words.
 * The message is the hint every surface words (ADR-0052); `signIn` is what a
 * host records for the planner gate, so the first refusal already blocks the
 * next send (#49 F2).
 */
export class RunnerSignedOutError extends Error {
  constructor(readonly signIn: RunnerSignIn, message: string) {
    super(message);
    this.name = 'RunnerSignedOutError';
  }
}

/** How one surface spells the ways in a sign-in hint points at. */
export interface SignInSyntax {
  /** The surface's own way to run the agent's login, or null where that is the agent's command itself. */
  login(runner: string): string | null;
  /** Setting a key for the vendor, where `label` is its name in the key entry. */
  chooseKey(provider: AiProvider, label: string): string;
  /** What the person does with `chooseKey`: "run" a command unless the surface says otherwise, e.g. "use" a button. */
  keyVerb?: string;
}

// `/login` hands the terminal to the runner's own login (ADR-0009). Named
// with its runner, since the hint may be about an agent that is not the planner.
// `/key-set` opens the key entry, which offers every provider (ADR-0052).
export const TERMINAL_UI_SIGN_IN: SignInSyntax = {
  login: (runner) => `/login ${runner}`,
  chooseKey: (_provider, label) => `/key-set and choose ${label}`,
};

export const HEADLESS_CLI_SIGN_IN: SignInSyntax = {
  // The CLI runs no login of its own: the agent's command is the way in.
  login: () => null,
  chooseKey: (provider) => `ordewell key set ${provider} <key>`,
};

/** The ways into a runner, from its manifest and, for an ACP agent, its profile's key route. */
export function signInOf(manifest: RunnerManifest, keyRoute?: KeySignInRoute): RunnerSignIn {
  const command = runnerCommand(manifest);
  const login = command !== undefined && manifest.auth?.loginArgs.length ? [command, ...manifest.auth.loginArgs] : undefined;
  const key = keyRoute
    ? { provider: keyRoute.provider, label: VENDORS[keyRoute.provider].label, ...(keyRoute.others ? { others: keyRoute.others } : {}) }
    : undefined;
  return {
    runner: manifest.name,
    label: manifest.displayName,
    ...(login ? { login } : {}),
    ...(key ? { key } : {}),
    ...(manifest.signIn ? { byHand: manifest.signIn } : {}),
  };
}

/**
 * "X is not signed in." and every way in the surface can offer, its own first,
 * then the agent's; for an agent that only lacks a key it can be handed, what
 * it lacks instead, since saying it is signed out would blame the agent.
 */
export function describeSignIn(signIn: RunnerSignIn, syntax: SignInSyntax): string {
  const ways = describeSignInWays(signIn, syntax);
  return `${describeSignInLead(signIn)}${ways ? ` ${ways}` : ''}`;
}

/** The hint's first sentence alone: what keeps the agent out, before any way in. */
export function describeSignInLead(signIn: RunnerSignIn): string {
  return setsUpKey(signIn) ? `${signIn.label} has no provider API key Ordewell can hand it.` : `${signIn.label} is not signed in.`;
}

/**
 * What a host says when the agent's own login exited cleanly and the recheck
 * still finds it blocked (ADR-0052): for an agent that only lacks a key, that
 * Ordewell still holds none it can hand over and the setup to run again, since
 * the agent itself was never asked and reported nothing.
 */
export function describeLoginStillBlocked(label: string, signIn: RunnerSignIn | undefined, syntax: SignInSyntax): string {
  if (!setsUpKey(signIn)) return `${label} still reports not logged in.`;
  return `The ${label} setup finished, but Ordewell still has no provider API key it can hand ${label}. ${describeSignInWays(signIn, syntax)}`;
}

/**
 * The ways in alone, as one sentence, or '' where there are none: for an agent
 * whose sign-in nobody could read, which saying "not signed in" would misstate.
 */
export function describeSignInWays(signIn: RunnerSignIn, syntax: SignInSyntax): string {
  if (setsUpKey(signIn)) {
    // An account the setup signs in to leaves no key the hook reads, so only a provider's key is named.
    const own = commandLine(signIn.login);
    const surface = syntax.login(signIn.runner);
    const run = surface ? `Set it up with ${surface}, or run ${own},` : `Run ${own}`;
    return `${run} and choose an API provider and enter its key; an account sign-in alone is not enough.`;
  }
  const routes: string[] = [];
  if (signIn.login) {
    const own = commandLine(signIn.login);
    const surface = syntax.login(signIn.runner);
    // The headless CLI's way in is the agent's command; naming it twice would
    // read as two routes where there is one.
    routes.push(surface ? `sign in with ${surface}, or run ${own}` : `run ${own} to sign in`);
  }
  if (signIn.key) {
    const others = signIn.key.others ? ` (or ${signIn.key.others})` : '';
    routes.push(`${syntax.keyVerb ?? 'run'} ${syntax.chooseKey(signIn.key.provider, signIn.key.label)}${others} to hand it a key`);
  }
  if (signIn.byHand) routes.push(signIn.byHand);
  if (routes.length === 0) return '';
  const ways = routes.join(', or ');
  return `${ways[0].toUpperCase()}${ways.slice(1)}.`;
}

/**
 * A verdict's ways in. One built without `signIn` (by a producer older than
 * it, or a test's hand) still names the login command it carried.
 */
export function signInOfVerdict(
  runner: string,
  label: string,
  auth: { loginCommand?: string[]; signIn?: RunnerSignIn } | undefined,
): RunnerSignIn | undefined {
  if (!auth) return undefined;
  return auth.signIn ?? { runner, label, ...(auth.loginCommand?.length ? { login: auth.loginCommand } : {}) };
}

/**
 * What a runner's row says about its sign-in, or null where it has nothing to
 * say. A signed-out agent gets the hint; one whose sign-in nobody could read
 * gets its login only, since a key or a by-hand route is no news to someone
 * who may be signed in already (ADR-0052).
 */
export function describeRunnerSignIn(
  auth: { state: 'signed-in' | 'signed-out' | 'unknown'; signIn?: RunnerSignIn } | undefined,
  syntax: SignInSyntax,
): string | null {
  const signIn = auth?.signIn;
  if (!signIn) return null;
  if (auth.state === 'signed-out') return describeSignInWays(signIn, syntax) ? describeSignIn(signIn, syntax) : null;
  if (auth.state === 'unknown' && signIn.login) return describeSignInWays({ runner: signIn.runner, label: signIn.label, login: signIn.login }, syntax);
  return null;
}

/**
 * What a button beside a signed-out agent does: run its login, open the key
 * entry, or nothing, where the person can only follow the words.
 */
export function signInAction(signIn: RunnerSignIn | undefined): 'login' | 'key' | null {
  if (signIn?.login) return 'login';
  if (signIn?.key) return 'key';
  return null;
}
