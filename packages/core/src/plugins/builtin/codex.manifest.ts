import type { RunnerPluginManifest } from '../types';

export const CODEX_MANIFEST: RunnerPluginManifest = {
  name: 'codex',
  displayName: 'Codex',
  description: 'OpenAI Codex CLI - AI coding agent in your terminal',
  version: '1.0.0',

  runner: {
    command: 'codex',
    // Headless surfaces (CLI/web) use the non-interactive `exec` subcommand
    // (`--skip-git-repo-check`: task workspaces aren't always git repos, and
    // exec hard-fails outside one by default); interactive surfaces (VS Code
    // terminal) launch the TUI with the prompt as its positional argument.
    // Reasoning effort has no dedicated flag — it travels as a `-c` config
    // override (see {{feature:reasoningEffortConfig}}). Both `exec` and the
    // TUI accept `-m`, `-c`, and `--sandbox`.
    argsTemplate: [
      '{{if headlessSession}}', 'exec', '--skip-git-repo-check', '{{/if}}',
      '{{if model}}', '-m', '{{model}}', '{{/if}}',
      '{{if thinking}}', '{{feature:reasoningEffortConfig}}', '{{/if}}',
      '--sandbox', '{{feature:permissionModeVal}}',
      '{{prompt}}',
    ],
    promptInArgs: true,
  },

  features: {
    modelSelection: true,
    thinkingEffort: true,
    planMode: true,
    planModeFlag: '--sandbox',
    permissionModeValues: {
      // Map mode IDs to --sandbox CLI values. `codex exec` is non-interactive
      // and has no approval flag, so the sandbox axis is the whole permission
      // story for headless runs.
      'agent': 'workspace-write',
      'plan': 'read-only',
      'fullAccess': 'danger-full-access',
      // Legacy alias used by older tasks
      'build': 'workspace-write',
    },
  },

  modelDiscovery: {
    // Codex has no `codex models` subcommand (see docs/adr/0004). Discovery
    // tries three sources in order, each falling through to the next:
    //
    // 1. `codex app-server` stdio JSON-RPC (`initialize` → `model/list`) —
    //    the live catalog: ids, display names, hidden flags, and per-model
    //    supported reasoning efforts (the variants).
    // 2. `~/.codex/models_cache.json` — the same catalog, written by Codex
    //    itself on its own runs; fresh as of the user's last Codex session.
    // 3. canonicalAliases — stable `-m` slugs as the last resort, with the
    //    static common-denominator variants below.
    method: 'hardcoded',
    appServer: {
      command: 'codex',
      args: ['app-server'],
      cacheFile: '~/.codex/models_cache.json',
    },
    canonicalAliases: [
      { modelId: 'gpt-5.6-sol', modelLabel: 'GPT-5.6-Sol' },
      { modelId: 'gpt-5.6-terra', modelLabel: 'GPT-5.6-Terra' },
      { modelId: 'gpt-5.6-luna', modelLabel: 'GPT-5.6-Luna' },
      { modelId: 'gpt-5.5', modelLabel: 'GPT-5.5' },
      { modelId: 'gpt-5.4', modelLabel: 'GPT-5.4' },
      { modelId: 'gpt-5.4-mini', modelLabel: 'GPT-5.4-Mini' },
    ],
    // Fallback-only common denominator: every current Codex model supports at
    // least these four rungs. Live discovery replaces them with each model's
    // real supportedReasoningEfforts (which may add max/ultra).
    variants: [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Xhigh' },
    ],
  },

  contextFile: 'AGENTS.md',

  modes: [
    { id: 'agent', label: 'Agent', description: 'Workspace-write sandbox: edits files inside the workspace', cliValue: 'workspace-write', safe: true },
    { id: 'plan', label: 'Plan', description: 'Read-only sandbox for analysis and exploration', cliValue: 'read-only' },
    { id: 'fullAccess', label: 'Full access', description: 'No sandbox — full disk and network access for autonomous runs', cliValue: 'danger-full-access', autonomous: true },
  ],
};
