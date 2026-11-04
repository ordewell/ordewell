import type { RunnerManifest } from '../types';
import { parseCopilotModels } from './copilotModels';

/** How Copilot is started as an ACP agent; the profile runs it and discovery asks it with the same words. */
export const COPILOT_ACP_ARGS = ['--acp', '--stdio'];

export const COPILOT_CLI_MANIFEST: RunnerManifest = {
  name: 'copilot-cli',
  displayName: 'GitHub Copilot CLI',

  runner: { command: 'copilot' },

  features: {},

  modelDiscovery: {
    // Copilot 1.0.105 offers no model over ACP, so this reads nothing today
    // and `help config` below answers; a build that lists models over ACP is
    // taken up without a change here (ADR-0040: discovery never gates a pick).
    method: 'acp',
    acp: { args: COPILOT_ACP_ARGS },
    discoveryCommands: [{ command: 'copilot', args: ['help', 'config'], parser: parseCopilotModels }],
    // `auto` lets Copilot route the task itself; the help text names it only
    // in prose, so it is added rather than discovered.
    canonicalAliases: [{ modelId: 'auto', modelLabel: 'Auto' }],
  },

  contextFile: 'AGENTS.md',
  contextFileAltPath: '.github/copilot-instructions.md',

  // No read-only mode: Copilot runs the repository's hooks under ACP, so its
  // profile claims no read-only role (ADR-0028, ADR-0046).
  // Copilot has `copilot login` but no status command, so there are no
  // `statusArgs`: a signed-out agent is learned from ACP's auth-required error,
  // which the adapter words as "not signed in" (its -32000 message).
  auth: { loginArgs: ['login'], signedOut: /Authentication required|not signed in/i },
  modes: [
    { id: 'default', label: 'Ask before actions', description: 'Edits and commands wait for your approval', safe: true },
    { id: 'allowAll', label: 'Allow all', description: 'Copilot runs edits and commands without asking (--allow-all)', autonomous: true },
  ],
};
