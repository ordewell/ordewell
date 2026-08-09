import * as vscode from 'vscode';
import {
  enabledRunners, listSessions, loadSession, knownModelId, runnerForProvider,
  ORCHESTRATOR_SHORTCUTS,
} from '@ordewell/core';
import type { AiProvider, IConfig, RunnerRegistry, ModelResolver, SettingsService, RunnerModeInfo, DiscoveredModel } from '@ordewell/core';
import type { ApiProvider } from '../adapters/SecretStore';
import type { ChatViewProvider, PlannerBackend } from '../providers/ChatViewProvider';
import { configureModelAllowlist } from './configureModelAllowlist';
import { resolveAutonomousQuickPickItems, applyAutonomousChoice } from '../SlashAutonomous';

export interface SlashDeps {
  config: { orchestratorModel: string; planningModel: string; enabledRunners: string[]; autonomousMode: boolean; apiKey: string; openAiBaseUrl: string; configuredProviders: ApiProvider[]; aiProvider: AiProvider; plannerThinkingEffort?: string };
  modelResolver: { pickerOptions(): Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>; refresh(): Promise<unknown>; invalidate(): void; refreshRunnerModels(): void; modelsForRunners(runners: string[]): Promise<Partial<Record<string, DiscoveredModel[]>>>; };
  /** Every planner the user could pick, with the reason an unusable one can't be (ADR-0009). */
  plannerBackends(): Promise<PlannerBackend[]>;
  /** Re-push planner provider/model/effort to the webview after a change. */
  refreshPlannerState(): Promise<void>;
  pluginRegistry: { list(): { manifest: { displayName: string; name: string } }[]; get(id: string): { manifest: { displayName: string } } | undefined; getManifest(id: string): { modes?: { id: string; label: string; description: string; cliValue?: string }[] } | undefined; };
  chatProvider: ChatViewProvider;
  settingsService: { getModelAllowlist(runner: string): string[] | undefined; setModelAllowlist(runner: string, ids: string[] | undefined): void; };
  sendRunnerAndModels(): Promise<void>;
  runApiKeyWizard(provider?: ApiProvider): Promise<void>;
  discoverOrchestratorModelOptions(): Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>;
  pickModelWithProvider(options: { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[], configuredProviders: ApiProvider[], placeHolder: string): Promise<string | undefined>;
  updateConfig(key: string, value: unknown): Promise<void>;
  /** Remember `model`/`effort` as the current provider's planner choice (keyed by `config.aiProvider` at write time). */
  recordPlannerModel(model: string, effort?: string): void;
  log(msg: string): void;
}

/**
 * Pick the planner backend (ADR-0009). Harness planners are listed even when
 * unusable, with the preflight's reason as the detail — a picker that hides a
 * missing CLI leaves the user guessing why their agent vanished.
 */
async function pickPlanner(arg: string | undefined, deps: SlashDeps): Promise<void> {
  const backends = await deps.plannerBackends();
  let chosen = arg ? backends.find((b) => b.id === arg.toLowerCase()) : undefined;
  if (arg && !chosen) {
    vscode.window.showWarningMessage(`Unknown planner: ${arg}. Run /planner with no argument to see the list.`);
    return;
  }
  if (!chosen) {
    const picked = await vscode.window.showQuickPick(
      backends.map((b) => ({
        label: b.usable ? b.label : `$(circle-slash) ${b.label}`,
        description: b.id === deps.config.aiProvider ? 'current' : undefined,
        detail: b.reason,
        backend: b,
      })),
      { placeHolder: 'Who researches your goal and writes the plan?' },
    );
    if (!picked) return;
    chosen = picked.backend;
  }
  if (!chosen.usable) {
    vscode.window.showWarningMessage(chosen.reason ?? `${chosen.label} is not available.`);
    return;
  }
  await vscode.commands.executeCommand('ordewell.setPlanner', chosen.id);
}

/** The planner's own model, from the coding agent's catalog rather than a vendor's. */
async function pickHarnessPlannerModel(runner: string, arg: string, deps: SlashDeps): Promise<void> {
  const models = (await deps.modelResolver.modelsForRunners([runner]))[runner] ?? [];
  if (models.length === 0) {
    vscode.window.showWarningMessage(`No ${runner} models discovered yet. Run /refresh.`);
    return;
  }
  let modelId = arg.trim() && models.some((m) => m.modelId === arg.trim()) ? arg.trim() : '';
  if (!modelId) {
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.modelLabel,
        description: m.modelId,
        detail: m.variants.length > 0
          ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}`
          : 'runner default effort',
        modelId: m.modelId,
      })),
      { placeHolder: `Pick a ${runner} model for the planner` },
    );
    if (!picked) return;
    modelId = picked.modelId;
  }
  await deps.updateConfig('orchestratorModel', modelId);
  // An effort from the previous model is a variant this one may not have; the
  // planner would pass it straight to the agent and get a rejected turn.
  const variants = models.find((m) => m.modelId === modelId)?.variants ?? [];
  const effort = variants.some((v) => v.id === deps.config.plannerThinkingEffort) ? deps.config.plannerThinkingEffort : '';
  if (!effort) {
    await deps.updateConfig('plannerThinkingEffort', '');
  }
  deps.recordPlannerModel(modelId, effort || undefined);
  await deps.refreshPlannerState();
  vscode.window.showInformationMessage(`Planner model set to: ${modelId}`);
}

/** The planner agent's thinking effort — one of the selected model's own variants. */
async function pickPlannerEffort(arg: string | undefined, deps: SlashDeps): Promise<void> {
  const runner = runnerForProvider(deps.config.aiProvider);
  if (!runner) {
    vscode.window.showWarningMessage('Thinking effort applies to a coding-agent planner. Run /planner to pick one.');
    return;
  }
  const models = (await deps.modelResolver.modelsForRunners([runner]))[runner] ?? [];
  const current = models.find((m) => m.modelId === deps.config.orchestratorModel);
  const variants = current?.variants ?? [];
  if (variants.length === 0) {
    vscode.window.showWarningMessage(
      current
        ? `${current.modelLabel} exposes no effort levels — it always runs at the agent's default.`
        : 'Pick a planner model first with /model set.',
    );
    return;
  }
  if (arg) {
    const match = variants.find((v) => v.id === arg.toLowerCase());
    if (!match) {
      vscode.window.showWarningMessage(`Unknown effort: ${arg}. Available: ${variants.map((v) => v.id).join(', ')}.`);
      return;
    }
    await deps.updateConfig('plannerThinkingEffort', match.id);
    deps.recordPlannerModel(deps.config.orchestratorModel, match.id);
    await deps.refreshPlannerState();
    vscode.window.showInformationMessage(`Planner effort set to: ${match.id}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Runner default', detail: "Let the agent choose", effort: '' },
      ...variants.map((v) => ({ label: v.label, detail: v.id === deps.config.plannerThinkingEffort ? 'current' : undefined, effort: v.id })),
    ],
    { placeHolder: `Thinking effort for ${current!.modelLabel}` },
  );
  if (!picked) return;
  await deps.updateConfig('plannerThinkingEffort', picked.effort);
  deps.recordPlannerModel(deps.config.orchestratorModel, picked.effort || undefined);
  await deps.refreshPlannerState();
  vscode.window.showInformationMessage(`Planner effort set to: ${picked.effort || 'runner default'}`);
}

export async function handleSlashCommand(text: string, deps: SlashDeps): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (cmd === '/refresh') {
    // Full refresh: drop every resolver cache (runner discovery + provider
    // catalogs) so the re-discovery below reflects the current environment.
    deps.modelResolver.invalidate();
    await deps.sendRunnerAndModels();
    vscode.window.showInformationMessage('Refreshed.');
    return;
  }
  if (cmd === '/model' && args.length === 0) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'ordewell.orchestratorModel');
    return;
  }
  if (cmd === '/model' && args[0] === 'set') {
    // A harness planner runs a coding agent, so its catalog is that agent's own
    // (ADR-0009) — sending it through the vendor picker would offer models it
    // cannot run, and refuse outright when the user holds no API key at all.
    const plannerRunner = runnerForProvider(deps.config.aiProvider);
    if (plannerRunner) {
      await pickHarnessPlannerModel(plannerRunner, args.slice(1).join(' '), deps);
      return;
    }
    const options = await deps.discoverOrchestratorModelOptions();
    const known = knownModelId(args.slice(1).join(' '), options.map((o) => o.id), ORCHESTRATOR_SHORTCUTS);
    if (known) {
      await deps.updateConfig('orchestratorModel', known);
      deps.recordPlannerModel(known);
      vscode.window.showInformationMessage(`Orchestrator model set to: ${known}`);
      return;
    }
    const picked = await deps.pickModelWithProvider(options, deps.config.configuredProviders, 'Pick orchestrator model');
    if (picked) {
      await deps.updateConfig('orchestratorModel', picked);
      deps.recordPlannerModel(picked);
      vscode.window.showInformationMessage(`Orchestrator model set to: ${picked}`);
    }
    return;
  }
  if (cmd === '/planner') {
    await pickPlanner(args[0], deps);
    return;
  }
  if (cmd === '/planner-effort') {
    await pickPlannerEffort(args[0], deps);
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
      deps.pluginRegistry as unknown as RunnerRegistry,
      deps.modelResolver as unknown as ModelResolver,
      deps.settingsService as unknown as SettingsService,
    );
    return;
  }
  if (cmd === '/help') {
    vscode.window.showInformationMessage(
      'Commands: /planner, /model, /model set, /planner-effort, /key set, /sessions, /new, /refresh, /auto, /allowlist, /help. Type / after a command to see model suggestions.',
    );
    return;
  }
  if (cmd === '/new') {
    await vscode.commands.executeCommand('ordewell.newSession');
    return;
  }
  if (cmd === '/auto') {
    const runners = enabledRunners(deps.config as unknown as IConfig).filter((r: string) => deps.pluginRegistry.get(r));
    const modesByRunner: Record<string, RunnerModeInfo[]> = {};
    for (const r of runners) {
      modesByRunner[r] = deps.pluginRegistry.getManifest(r)?.modes ?? [];
    }
    const explicitArg = args[0]?.toLowerCase();
    const direct: boolean | undefined =
      explicitArg === 'on' ? true : explicitArg === 'off' ? false : undefined;
    if (direct !== undefined) {
      await deps.updateConfig('autonomousMode', direct);
      vscode.window.showInformationMessage(applyAutonomousChoice(direct, runners, modesByRunner));
      return;
    }
    const items = resolveAutonomousQuickPickItems(runners, modesByRunner, deps.config.autonomousMode);
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Autonomous mode for new plans' });
    if (!picked) return;
    await deps.updateConfig('autonomousMode', picked.value);
    vscode.window.showInformationMessage(applyAutonomousChoice(picked.value, runners, modesByRunner));
    return;
  }
  vscode.window.showWarningMessage(`Unknown command: ${cmd}. Type /help for available commands.`);
}
