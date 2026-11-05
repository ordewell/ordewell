import type { RunnerManifest } from '../types';
import { parseOpenCodeModels, parseOpenCodeModelsApi, parseOpenCodeModelsVerbose } from './openCodeModels';

export const OPENCODE_MANIFEST: RunnerManifest = {
  name: 'opencode',
  displayName: 'OpenCode',

  runner: { command: 'opencode' },

  features: {
    permissionModeValues: { plan: 'build' },
    modeSettings: {
      approvals: { build: 'auto' },
    },
  },

  modelDiscovery: {
    method: 'command',
    discoveryCommands: [
      // v1 prints per-model variants under --verbose; v2 rejects the flag (a
      // fast non-zero exit) and serves the same catalog, variants included, over
      // `api model.list`. v1 is asked first so it never reaches the `api` form.
      { command: 'opencode', args: ['models', '--verbose'], parser: parseOpenCodeModelsVerbose },
      { command: 'opencode', args: ['api', 'model.list'], parser: parseOpenCodeModelsApi },
      { command: 'opencode', args: ['models'], parser: parseOpenCodeModels },
    ],
    // No fallbackModels: the list must always reflect what `opencode models`
    // actually reports for THIS user (their configured providers only). A
    // hardcoded fallback previously leaked models the user didn't have.
    // No static variants — per-model variants come from the first two commands above
    providerQualifiedIds: true,
  },

  contextFile: 'AGENTS.md',
  contextFileAltPath: '.opencode/AGENTS.md',

  // OpenCode signs in per provider, choosing one in its own prompt, so
  // Ordewell has no single login to run and no status to ask.
  signIn: 'run opencode auth login and choose a provider',

  modes: [
    { id: 'build', label: 'Build', description: 'Full access agent for development work', cliValue: 'build', autonomous: true, safe: true },
    { id: 'plan', label: 'Read-only', description: 'Native reads and Ordewell commands; lands nothing', cliValue: 'build', readOnly: true },
  ],
};
