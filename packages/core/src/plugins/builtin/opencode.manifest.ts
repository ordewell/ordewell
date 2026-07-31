import type { RunnerPluginManifest } from '../types';

export const OPENCODE_MANIFEST: RunnerPluginManifest = {
  name: 'opencode',
  displayName: 'OpenCode',
  description: 'OpenCode CLI - open-source AI coding agent',
  version: '1.0.0',

  runner: {
    command: 'opencode',
    // Interactive surfaces (VS Code terminal) launch the full TUI with
    // `--prompt`; headless surfaces (CLI/web) use the streaming `run`
    // subcommand. `--variant` is ONLY accepted by `run` — the TUI rejects it
    // as an unknown flag and exits before any work, which Ordewell reads as
    // task completion. The TUI receives the variant through
    // OPENCODE_CONFIG_CONTENT instead (see below).
    argsTemplate: [
      '{{if headlessSession}}', 'run', '{{/if}}',
      '{{if model}}', '--model', '{{model}}', '{{/if}}',
      '--agent', '{{mode}}',
      '{{if variant}}', '--variant', '{{thinkingEffort}}', '{{/if}}',
      '{{if buildMode}}', '--auto', '{{/if}}',
      '{{if interactive}}', '--prompt', '{{/if}}',
      '{{prompt}}',
    ],
    // Deep-merged over the user's opencode.json for this process only. An
    // agent-scoped variant alone is NOT enough for the TUI — its remembered
    // last-used variant silently wins — so the config also disables the
    // model's other variants (see resolveOpencodeVariantConfig). Never set a
    // top-level `model`/`variant` here: that can switch the active provider
    // and make sessions fail while still exiting 0.
    env: {
      OPENCODE_CONFIG_CONTENT: '{{if interactiveVariant}}{{opencodeVariantConfig}}{{/if}}',
    },
    promptInArgs: true,
    requiresTty: true,
  },

  features: {
    modelSelection: true,
    thinkingEffort: true,
    planMode: true,
    planModeFlag: 'plan',
    buildModeFlag: 'build',
    headlessFlag: '--auto',
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
