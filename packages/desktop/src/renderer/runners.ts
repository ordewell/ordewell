import type { AiProvider } from '@ordewell/core';
import { RUNNER_IDS, RUNNER_LABELS, VENDORS, type RunnerSignIn } from '@ordewell/core/plan-utils';

/** The runners the welcome window checks for, in the order core declares them. */
export const KNOWN_RUNNERS: readonly string[] = RUNNER_IDS;

export interface RunnerLine {
  id: string;
  /** The runner's name from core's manifest, for a row that must not keep its own table. */
  name?: string;
  /**
   * `missing`: the daemon found no such binary. `off`: installed, but turned
   * off in Settings. The rest is its login verdict.
   */
  state: 'signed-in' | 'signed-out' | 'unknown' | 'missing' | 'off';
  detail?: string;
  /** Why an installed agent cannot be started (too old, or no spawnable file), in core's words. */
  unavailable?: string;
  /** The CLI's own `--version`, when the daemon could read one. */
  version?: string;
  /** The runner's own sign-in, `[command, ...args]` (ADR-0052). */
  loginCommand?: string[];
  /** Every way into the agent, so a key-based one names the key entry (ADR-0052). */
  signIn?: RunnerSignIn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((part): part is string => typeof part === 'string') ? value : undefined;
}

/** A verdict's `signIn` as core sends it, narrowed so a page never trusts a hand-made shape. */
function signInOf(value: unknown): RunnerSignIn | undefined {
  if (!isRecord(value) || typeof value.runner !== 'string' || typeof value.label !== 'string') return undefined;
  const login = stringList(value.login);
  const key = isRecord(value.key) && typeof value.key.provider === 'string' && Object.hasOwn(VENDORS, value.key.provider) && typeof value.key.label === 'string'
    ? {
      provider: value.key.provider as AiProvider,
      label: value.key.label,
      ...(typeof value.key.others === 'string' ? { others: value.key.others } : {}),
    }
    : undefined;
  return {
    runner: value.runner,
    label: value.label,
    ...(login ? { login } : {}),
    ...(key ? { key } : {}),
    ...(typeof value.byHand === 'string' ? { byHand: value.byHand } : {}),
  };
}

/**
 * GET /api/runners lists only the runners installed on the daemon's host, so
 * one it leaves out is one this machine does not have.
 */
export function parseRunners(data: unknown): RunnerLine[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.runners)) return undefined;
  const found = new Map<string, RunnerLine>();
  for (const entry of data.runners) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    const auth = isRecord(entry.auth) ? entry.auth : undefined;
    const signedState = auth?.state === 'signed-in' || auth?.state === 'signed-out' ? auth.state : 'unknown';
    const loginCommand = stringList(auth?.loginCommand);
    const signIn = signInOf(auth?.signIn);
    found.set(entry.id, {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : RUNNER_LABELS[entry.id] ?? entry.id,
      state: entry.enabled === false ? 'off' : signedState,
      ...(typeof auth?.detail === 'string' ? { detail: auth.detail } : {}),
      ...(entry.usable === false ? { unavailable: typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : 'Ordewell cannot start it.' } : {}),
      ...(typeof entry.version === 'string' && entry.version !== '' ? { version: entry.version } : {}),
      ...(loginCommand ? { loginCommand } : {}),
      ...(signIn ? { signIn } : {}),
    });
  }
  return [
    ...KNOWN_RUNNERS.map((id): RunnerLine => found.get(id) ?? { id, name: RUNNER_LABELS[id] ?? id, state: 'missing' }),
    ...[...found.values()].filter((line) => !KNOWN_RUNNERS.includes(line.id)),
  ];
}
