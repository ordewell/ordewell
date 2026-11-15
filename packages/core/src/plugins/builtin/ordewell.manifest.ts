import type { RunnerManifest } from '../types';

/** The runner's modes (ADR-0070), each enforced by Ordewell itself: the runner has no permission system of its own. */
export const ORDEWELL_FULL_MODE = 'full';
export const ORDEWELL_GUARDED_MODE = 'guarded';
export const ORDEWELL_READ_ONLY_MODE = 'read-only';

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

  // The tags are what ModeResolver maps the plan's levels onto: Full is the
  // autonomous mode, Guarded the safe one, and a read-only task the readOnly one.
  modes: [
    { id: ORDEWELL_FULL_MODE, label: 'Full', description: 'Edits and shell commands run without asking; edits stay in the worktree and the shell holds no provider keys', autonomous: true },
    { id: ORDEWELL_GUARDED_MODE, label: 'Guarded', description: 'Reads and edits in the worktree go ahead; every shell command waits for approval', safe: true },
    { id: ORDEWELL_READ_ONLY_MODE, label: 'Read-only', description: 'No edit, write or shell tools; the only shell is the sealed run_command', readOnly: true },
  ],
};
