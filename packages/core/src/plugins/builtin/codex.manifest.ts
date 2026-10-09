import type { RunnerManifest } from '../types';

export const CODEX_MANIFEST: RunnerManifest = {
  name: 'codex',
  displayName: 'Codex',

  runner: { command: 'codex' },

  features: {
    permissionModeValues: {
      'agent': 'workspace-write',
      'plan': 'read-only',
      'fullAccess': 'danger-full-access',
      // Legacy alias used by older tasks
      'build': 'workspace-write',
    },
    modeSettings: {
      approvalPolicy: {
        'agent': 'on-request',
        'plan': 'never',
        'fullAccess': 'never',
        'build': 'on-request',
      },
      approvalsReviewer: {
        'agent': 'auto_review',
        'build': 'auto_review',
      },
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
    { id: 'agent', label: 'Agent', description: 'Workspace-write sandbox: edits files inside the workspace, and Codex\'s reviewer subagent assesses each approval request', cliValue: 'workspace-write', safe: true },
    { id: 'plan', label: 'Plan', description: 'Read-only sandbox for analysis and exploration', cliValue: 'read-only' },
    { id: 'fullAccess', label: 'Full access', description: 'No sandbox — full disk and network access for autonomous runs', cliValue: 'danger-full-access', autonomous: true },
  ],
};
