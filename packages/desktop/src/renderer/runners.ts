/** The runners the welcome window checks for, in the order it lists them. */
export const KNOWN_RUNNERS = ['claude-code', 'codex', 'opencode'] as const;

export interface RunnerLine {
  id: string;
  /**
   * `missing`: the daemon found no such binary. `off`: installed, but turned
   * off in Settings. The rest is its login verdict.
   */
  state: 'signed-in' | 'signed-out' | 'unknown' | 'missing' | 'off';
  detail?: string;
  /** The CLI's own `--version`, when the daemon could read one. */
  version?: string;
  /** The runner's own sign-in, `[command, ...args]` (ADR-0052). */
  loginCommand?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((part): part is string => typeof part === 'string') ? value : undefined;
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
    found.set(entry.id, {
      id: entry.id,
      state: entry.enabled === false ? 'off' : signedState,
      ...(typeof auth?.detail === 'string' ? { detail: auth.detail } : {}),
      ...(typeof entry.version === 'string' && entry.version !== '' ? { version: entry.version } : {}),
      ...(loginCommand ? { loginCommand } : {}),
    });
  }
  return KNOWN_RUNNERS.map((id) => found.get(id) ?? { id, state: 'missing' });
}
