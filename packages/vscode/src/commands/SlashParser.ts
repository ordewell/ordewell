import * as vscode from 'vscode';
import { listSessions, loadSession } from '@ordewell/core';
import type { AiProvider, PlannerBackendId, RunnerRegistry, ModelResolver, SettingsService, DiscoveredModel, PlannerModelRecall } from '@ordewell/core';
import type { ApiProvider } from '../adapters/SecretStore';
import type { ChatViewProvider, PlannerBackend } from '../providers/ChatViewProvider';
import type { VendorModelOption } from '../plan/PlannerModelSwitch';
import { configureModelAllowlist } from './configureModelAllowlist';
import { isBuiltinSlashCommand, resolveSlashAlias, slashHelp } from '@ordewell/ui/protocol';
import { runPlannerWizard } from './plannerWizard';

// A '/' text whose first word the table does not name is a discovered skill
// (or unknown) invocation: the caller routes it to handleSendMessage, so the
// Session's own /skill-name substitution gets to resolve it rather than it
// being swallowed here as "Unknown command".
export function isKnownSlashCommand(text: string): boolean {
  return isBuiltinSlashCommand(text);
}

export interface SlashDeps {
  config: { orchestratorModel: string; aiProvider: PlannerBackendId; plannerThinkingEffort?: string };
  modelResolver: { pickerOptions(): Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>; refresh(): Promise<unknown>; invalidate(): void; refreshRunnerModels(): void; modelsForRunners(runners: string[]): Promise<Partial<Record<string, DiscoveredModel[]>>>; };
  /** Every planner the user could pick, with the reason an unusable one can't be (ADR-0009). */
  plannerBackends(): Promise<PlannerBackend[]>;
  /** Re-push planner provider/model/effort to the webview after a change. */
  refreshPlannerState(): Promise<void>;
  /** Hand the terminal to a runner's own login; omitted names the active planner. */
  loginPlanner(runner?: string): Promise<void>;
  runnerRegistry: { list(): { manifest: { displayName: string; name: string } }[] };
  chatProvider: ChatViewProvider;
  settingsService: { getModelAllowlist(runner: string): string[] | undefined; setModelAllowlist(runner: string, ids: string[] | undefined): void; };
  sendRunnerAndModels(): Promise<void>;
  runApiKeyWizard(provider?: ApiProvider): Promise<void>;
  /** What the planner should land on for `provider`: its remembered model, else the catalog's first. */
  recallPlannerModel(provider: PlannerBackendId, harnessModels: DiscoveredModel[] | undefined, vendorOptions: VendorModelOption[] | undefined): PlannerModelRecall;
  /** Switch backend, model and effort in one change and remember the pick. */
  applyPlannerChoice(provider: PlannerBackendId, modelId: string, effort: string): Promise<void>;
  log(msg: string): void;
}

/**
 * `/planner <id>` switches straight to that backend and its remembered model;
 * bare `/planner` walks harness, model and effort in one stepped quick pick
 * (ADR-0009). Unusable harness planners are listed with the preflight's reason
 * — a picker that hides a missing CLI leaves the user guessing why it vanished.
 */
async function pickPlanner(arg: string | undefined, deps: SlashDeps): Promise<void> {
  if (!arg) {
    await runPlannerWizard({
      current: () => ({
        provider: deps.config.aiProvider,
        model: deps.config.orchestratorModel,
        effort: deps.config.plannerThinkingEffort ?? '',
      }),
      plannerBackends: deps.plannerBackends,
      modelsForRunner: async (runner) => (await deps.modelResolver.modelsForRunners([runner]))[runner] ?? [],
      vendorModels: async (provider) => (await deps.modelResolver.pickerOptions()).filter((o) => o.apiProvider === provider),
      recall: deps.recallPlannerModel,
      applyChoice: deps.applyPlannerChoice,
    });
    return;
  }
  const chosen = (await deps.plannerBackends()).find((b) => b.id === arg.toLowerCase());
  if (!chosen) {
    vscode.window.showWarningMessage(`Unknown planner: ${arg}. Run /planner with no argument to see the list.`);
    return;
  }
  if (!chosen.usable) {
    vscode.window.showWarningMessage(chosen.reason ?? `${chosen.label} is not available.`);
    return;
  }
  await vscode.commands.executeCommand('ordewell.setPlanner', chosen.id);
}

export async function handleSlashCommand(text: string, deps: SlashDeps): Promise<void> {
  const parts = text.trim().split(/\s+/);
  // Resolve a familiar alias to the command it spells before dispatch, so an
  // alias takes the exact same branch — same picker, same empty/cancel/load
  // behaviour — as its target, and there is only one implementation to keep.
  const cmd = resolveSlashAlias(parts[0]);
  const args = parts.slice(1);

  if (cmd === '/refresh') {
    // Full refresh: drop every resolver cache (runner discovery + provider
    // catalogs) so the re-discovery below reflects the current environment.
    deps.modelResolver.invalidate();
    await deps.sendRunnerAndModels();
    vscode.window.showInformationMessage('Refreshed.');
    return;
  }
  if (cmd === '/planner') {
    await pickPlanner(args[0], deps);
    return;
  }
  if (cmd === '/login') {
    // Joined, not just `args[0]`: a display label is two words ("Claude Code").
    const named = args.join(' ').trim();
    const runner = named
      ? deps.runnerRegistry.list().find(({ manifest }) => manifest.name === named
        || manifest.displayName.toLowerCase() === named.toLowerCase())?.manifest.name
      : undefined;
    if (named && !runner) {
      vscode.window.showWarningMessage(`Unknown coding agent: ${named}. Run /planner to see the coding agents.`);
      return;
    }
    await deps.loginPlanner(runner);
    return;
  }
  if (cmd === '/key') {
    const allProviders = ['google', 'openrouter', 'openai_compatible', 'openai', 'xai', 'groq', 'deepseek', 'together', 'mistral', 'anthropic', 'fireworks', 'perplexity', 'zhipu', 'kimi', 'cerebras', 'deepinfra', 'doubao', 'qwen', 'hunyuan', 'baichuan', 'minimax', 'yi', 'stepfun', 'siliconflow', 'cohere', 'novita'];
    const provider = args.find((a) => allProviders.includes(a)) as ApiProvider | undefined;
    await deps.runApiKeyWizard(provider);
    return;
  }
  if (cmd === '/sessions') {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const sessions = listSessions(workspace);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No saved sessions.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.slice(0, 20).map((s) => ({
        label: s.goal,
        description: `${s.taskCount} tasks · ${new Date(s.createdAt).toLocaleDateString()}`,
        detail: `Status: ${s.status} · Runners: ${s.runners.join(', ')}`,
        sessionId: s.id,
      })),
      { placeHolder: 'Select a session to load' },
    );
    if (picked) {
      const loaded = loadSession(picked.sessionId, workspace);
      if (!loaded) {
        vscode.window.showErrorMessage('Failed to load session.');
        return;
      }
      // The caller handles setting currentPlan/goal and updating the webview
      await vscode.commands.executeCommand('ordewell.loadSessionById', picked.sessionId);
    }
    return;
  }
  if (cmd === '/allowlist') {
    await configureModelAllowlist(
      deps.runnerRegistry as unknown as RunnerRegistry,
      deps.modelResolver as unknown as ModelResolver,
      deps.settingsService as unknown as SettingsService,
      undefined,
      (allowlist) => deps.chatProvider.setModelAllowlist(allowlist),
    );
    return;
  }
  if (cmd === '/help') {
    vscode.window.showInformationMessage(slashHelp());
    return;
  }
  if (cmd === '/fork') {
    await vscode.commands.executeCommand('ordewell.forkConversation');
    return;
  }
  if (cmd === '/rewind') {
    await vscode.commands.executeCommand('ordewell.rewindConversation', args[0]);
    return;
  }
  if (cmd === '/compact') {
    await vscode.commands.executeCommand('ordewell.compactConversation');
    return;
  }
  if (cmd === '/new') {
    await vscode.commands.executeCommand('ordewell.newSession');
    return;
  }
  if (cmd === '/settings') {
    deps.chatProvider.openSettings();
    return;
  }
  vscode.window.showWarningMessage(`Unknown command: ${cmd}. Type /help for available commands.`);
}
