/** The runners the welcome window checks for, in the order it lists them. */
export const KNOWN_RUNNERS = ['claude-code', 'codex', 'opencode'] as const;

export const RUNNER_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export interface RunnerLine {
  id: string;
  /** `missing`: the daemon found no such binary; the rest is its login verdict. */
  state: 'signed-in' | 'signed-out' | 'unknown' | 'missing';
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const state = auth?.state === 'signed-in' || auth?.state === 'signed-out' ? auth.state : 'unknown';
    found.set(entry.id, { id: entry.id, state, ...(typeof auth?.detail === 'string' ? { detail: auth.detail } : {}) });
  }
  return KNOWN_RUNNERS.map((id) => found.get(id) ?? { id, state: 'missing' });
}
