import type { RunnerManifest } from '../types';

/** The mode a Full attempt runs in: the only one this slice of ADR-0070 runs. */
export const ORDEWELL_FULL_MODE = 'full';

/**
 * Ordewell's own coding agent (ADR-0070). It has no command: the loop runs in
 * the Ordewell process and calls the provider APIs with the keys Ordewell
 * already holds, so it is installed wherever this code is and usable once one
 * provider key is set. Its models are every keyed provider's, as
 * `<provider>:<model>`.
 */
export const ORDEWELL_MANIFEST: RunnerManifest = {
  name: 'ordewell',
  displayName: 'Ordewell',

  runner: { inProcess: true },

  features: {},

  modelDiscovery: { method: 'providers' },

  contextFile: 'AGENTS.md',
  contextFileAltPath: 'CLAUDE.md',

  // Guarded and read-only are declared now so plans and pickers know the
  // runner's tags, but marked unavailable until their gates land (ADR-0070):
  // an attempt on either must refuse, never run as Full.
  modes: [
    { id: ORDEWELL_FULL_MODE, label: 'Full', description: 'Edits and shell commands run without asking; edits stay in the worktree and the shell holds no provider keys', autonomous: true },
    { id: 'guarded', label: 'Guarded', description: 'Edits go ahead; every shell command waits for approval', safe: true, unavailable: 'Guarded mode of the Ordewell runner is not built yet; use Full' },
    { id: 'read-only', label: 'Read-only', description: 'No edit tools; the only shell is the sealed run_command', readOnly: true, unavailable: 'read-only mode of the Ordewell runner is not built yet' },
  ],
};
