import type { RunnerManifest } from '../types';
import { parseCopilotModels } from './copilotModels';

export const COPILOT_CLI_MANIFEST: RunnerManifest = {
  name: 'copilot-cli',
  displayName: 'GitHub Copilot CLI',

  runner: { command: 'copilot' },

  features: {},

  modelDiscovery: {
    method: 'command',
    discoveryCommands: [{ command: 'copilot', args: ['help', 'config'], parser: parseCopilotModels }],
    // `auto` lets Copilot route the task itself; the help text names it only
    // in prose, so it is added rather than discovered.
    canonicalAliases: [{ modelId: 'auto', modelLabel: 'Auto' }],
  },

  contextFile: 'AGENTS.md',
  contextFileAltPath: '.github/copilot-instructions.md',

  // No read-only mode: a planner and a read-only task are the next slice's.
  // No `auth`: Copilot has `copilot login` but no status command, so a
  // signed-out agent is learned from ACP's auth-required error.
  modes: [
    { id: 'default', label: 'Ask before actions', description: 'Edits and commands wait for your approval', safe: true },
    { id: 'allowAll', label: 'Allow all', description: 'Copilot runs edits and commands without asking (--allow-all)', autonomous: true },
  ],
};
