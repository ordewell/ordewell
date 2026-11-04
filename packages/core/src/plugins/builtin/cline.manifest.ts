import type { RunnerManifest } from '../types';

/** How Cline is started as an ACP agent; the profile runs it and discovery asks it with the same words. */
export const CLINE_ACP_ARGS = ['--acp'];

/**
 * Cline's CLI over ACP. Its id is `cline`, which no API vendor and no other
 * runner has: a runner and a vendor must never share an id.
 */
export const CLINE_MANIFEST: RunnerManifest = {
  name: 'cline',
  displayName: 'Cline',

  runner: { command: 'cline' },

  features: {},

  modelDiscovery: {
    // Cline lists its provider's models in `session/new`, so ACP answers and
    // there is no command to fall back to (ADR-0040: discovery never gates a pick).
    method: 'acp',
    acp: { args: CLINE_ACP_ARGS },
    discoveryCommands: [],
  },

  // `cline auth` signs in to a Cline account or stores a provider's key; there
  // is no status command. A signed-out agent is learned from ACP's
  // auth-required error, which the adapter words as "not signed in".
  auth: { loginArgs: ['auth'], signedOut: /Authentication required|not signed in/i },
  // Cline's only permission switch is `--auto-approve`, which the profile
  // passes on every start, so a setting Cline kept from an earlier run never
  // decides (ADR-0001). Its `plan` session mode is not offered as read-only:
  // no recording shows it refusing a write and a command (ADR-0046).
  modes: [
    { id: 'default', label: 'Ask before actions', description: 'Edits and commands wait for your approval', safe: true },
    { id: 'autoApprove', label: 'Allow all', description: 'Cline runs edits and commands without asking (--auto-approve true)', autonomous: true },
  ],
};
