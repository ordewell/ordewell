import type { RunnerPluginManifest } from '../types';

export const CLAUDE_CODE_MANIFEST: RunnerPluginManifest = {
  name: 'claude-code',
  displayName: 'Claude Code',
  description: 'Anthropic Claude Code - AI coding assistant in your terminal',
  version: '1.0.0',

  runner: {
    command: 'claude',
    argsTemplate: [
      '{{if model}}', '--model', '{{model}}', '{{/if}}',
      '{{if thinking}}', '{{feature:thinkingFlags}}', '{{/if}}',
      '--permission-mode', '{{feature:permissionModeVal}}',
      '{{if headless}}', '{{feature:headless}}', '{{/if}}',
      '{{prompt}}',
    ],
    promptInArgs: true,
  },

  features: {
    modelSelection: true,
    thinkingEffort: true,
    planMode: true,
    planModeFlag: '--permission-mode',
    headlessFlag: '--dangerously-skip-permissions',
    thinkingFlag: '--thinking',
    thinkingValueEnabled: 'enabled',
    thinkingValueDisabled: 'disabled',
    thinkingValueAdaptive: 'adaptive',
    permissionModeValues: {
      // Map mode IDs to --permission-mode CLI values
      'default': 'default',
      'acceptEdits': 'acceptEdits',
      'plan': 'plan',
      'bypassPermissions': 'bypassPermissions',
      // Legacy aliases used by older tasks
      'build': 'acceptEdits',
    },
  },

  modelDiscovery: {
    method: 'command',
    // Claude Code has no `claude models` subcommand. Discovery tries three
    // sources in order, each falling through to the next on failure:
    //
    // 1. Anthropic Models API (apiDiscovery) — GET /v1/models returns the
    //    authoritative live list of models the user's account can access,
    //    including aliases the --help prose omits (e.g. haiku). Auth works for
    //    both API-key users (ANTHROPIC_API_KEY → X-Api-Key) and OAuth/claude.ai
    //    users (token from ~/.claude/.credentials.json → Authorization: Bearer).
    //    Short aliases (opus, sonnet, haiku, fable) are derived from the full
    //    model IDs, deduplicated by family keeping the latest.
    //
    // 2. `claude --help` prose (discoveryCommands) — the CLI's --model
    //    description lists example aliases. Fragile (uses "e.g.", not
    //    exhaustive) but works offline and needs no auth.
    //
    // 3. canonicalAliases — stable --model contracts (opus/sonnet/haiku/fable)
    //    merged into any successful result to fill gaps, and used as the full
    //    last-resort list when both API and CLI are unavailable.
    apiDiscovery: {
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { 'anthropic-version': '2023-06-01' },
      auth: [
        { type: 'env', varName: 'ANTHROPIC_API_KEY', header: 'X-Api-Key' },
        { type: 'file', path: '~/.claude/.credentials.json', jsonPath: 'claudeAiOauth.accessToken', header: 'Authorization', prefix: 'Bearer ' },
      ],
      parser: 'anthropic-models',
    },
    discoveryCommands: [
      { command: 'claude', args: ['--help'], parser: 'claude-help' },
    ],
    canonicalAliases: [
      { modelId: 'opus', modelLabel: 'Opus' },
      { modelId: 'sonnet', modelLabel: 'Sonnet' },
      { modelId: 'haiku', modelLabel: 'Haiku' },
      { modelId: 'fable', modelLabel: 'Fable' },
    ],
    variants: [
      { id: 'adaptive', label: 'Adaptive' },
      { id: 'low', label: 'Low effort' },
      { id: 'medium', label: 'Medium effort' },
      { id: 'high', label: 'High effort' },
      { id: 'xhigh', label: 'Extra high effort' },
      { id: 'max', label: 'Max effort' },
    ],
  },

  contextFile: 'CLAUDE.md',
  contextFileAltPath: '.claude/CLAUDE.md',

  modes: [
    { id: 'default', label: 'Ask before edits', description: 'Standard mode: asks permission before editing files', cliValue: 'default', safe: true },
    { id: 'acceptEdits', label: 'Edit automatically', description: 'Edits files without asking, still asks for risky operations', cliValue: 'acceptEdits' },
    { id: 'plan', label: 'Plan mode', description: 'Read-only analysis, no edits allowed', cliValue: 'plan' },
    { id: 'bypassPermissions', label: 'Auto mode', description: 'Skips all permission prompts — use for AI-driven autonomous runs', cliValue: 'bypassPermissions', autonomous: true },
  ],
};
