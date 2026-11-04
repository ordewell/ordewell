import { clineCredentials } from '../../services/harness/clineCredentials';
import type { RunnerManifest } from '../types';

/** How Cline is started as an ACP agent; the profile runs it and discovery asks it with the same words. */
export const CLINE_ACP_ARGS = ['--acp'];

/**
 * Left to choose, Cline may start or join a hub daemon that outlives the
 * process and serves other sessions; `local` keeps the session inside the
 * process Ordewell starts and stops.
 */
export const CLINE_ACP_ENV: Readonly<Record<string, string>> = { CLINE_SESSION_BACKEND_MODE: 'local' };

/**
 * Cline keeps its provider's key in its own store, which an ACP start does not
 * read, so every start is handed the key in its env, discovery's too
 * (ADR-0060, R9).
 */
export const CLINE_CREDENTIALS = clineCredentials();

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
    // Cline lists its provider's models in `session/new` once it has the key,
    // so ACP answers and there is no command to fall back to (ADR-0040:
    // discovery never gates a pick).
    method: 'acp',
    acp: { args: CLINE_ACP_ARGS, env: CLINE_ACP_ENV, credentials: CLINE_CREDENTIALS },
    discoveryCommands: [],
  },

  // `cline auth` signs in to a Cline account or stores a provider's key; there
  // is no status command. A signed-out agent is learned from ACP's
  // auth-required error, which the adapter words as "not signed in".
  auth: { loginArgs: ['auth'], signedOut: /Authentication required|not signed in/i },
  // Cline's only permission switch is `--auto-approve`, which the profile
  // passes on every start, so a setting Cline kept from an earlier run never
  // decides (ADR-0001).
  modes: [
    { id: 'default', label: 'Ask before actions', description: 'Edits and commands wait for your approval', safe: true },
    // Read-only is the profile's restricted start (ADR-0046), not Cline's own
    // `plan` session mode, which nothing sets. Cline's file reads name no
    // path Ordewell could judge, so they are refused and it reads through
    // Ordewell's commands.
    { id: 'plan', label: 'Read-only', description: 'Ordewell commands with Cline\'s own tools off; lands nothing', readOnly: true },
    { id: 'autoApprove', label: 'Allow all', description: 'Cline runs edits and commands without asking (--auto-approve true)', autonomous: true },
  ],
};
