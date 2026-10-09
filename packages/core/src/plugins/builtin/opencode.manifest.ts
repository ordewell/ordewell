import type { RunnerManifest } from '../types';

export const OPENCODE_MANIFEST: RunnerManifest = {
  name: 'opencode',
  displayName: 'OpenCode',

  runner: { command: 'opencode' },

  features: {
    modeSettings: {
      approvals: { build: 'auto' },
    },
  },

  modelDiscovery: {
    method: 'command',
    discoveryCommands: [
      { command: 'opencode', args: ['models', '--verbose'], parser: 'opencode-models-verbose' },
      { command: 'opencode', args: ['models'], parser: 'opencode-models' },
    ],
    // No fallbackModels: the list must always reflect what `opencode models`
    // actually reports for THIS user (their configured providers only). A
    // hardcoded fallback previously leaked models the user didn't have.
    // No static variants — per-model variants are fetched from opencode models --verbose
  },

  contextFile: 'AGENTS.md',
  contextFileAltPath: '.opencode/AGENTS.md',

  modes: [
    { id: 'build', label: 'Build', description: 'Full access agent for development work', cliValue: 'build', autonomous: true, safe: true },
    { id: 'plan', label: 'Plan', description: 'Read-only agent for analysis and exploration', cliValue: 'plan' },
  ],
};
