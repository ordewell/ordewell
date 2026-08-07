import * as vscode from 'vscode';
import * as path from 'path';
import { promises as nodeFs } from 'fs';
import {
  Session, LegacyPlanState, createEmptyPlan, Task, flattenTasks,
  ModelResolver, RunnerRegistry, saveState, clearState,
  listSessions, loadSession,
  SettingsService,
  type AiProvider,
} from '@ordewell/core';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import { VsCodeTerminalRunner } from '../adapters/VsCodeTerminalRunner';
import { SecretStore, type ApiProvider } from '../adapters/SecretStore';
import { configureModelAllowlist } from './configureModelAllowlist';
import { plannerPreflightError } from '../plan/PlanManager';

export interface CommandDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  pluginRegistry: RunnerRegistry;
  modelResolver: ModelResolver;
  config: VsCodeConfig;
  fsAdapter: VsCodeFileSystem;
  terminalRunner: VsCodeTerminalRunner;
  settingsService: SettingsService;
  secretStore: SecretStore;
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  isGeneratingPlan: () => boolean;
  setGeneratingPlan: (v: boolean) => void;
  getResearchAbort: () => AbortController | null;
  setResearchAbort: (c: AbortController | null) => void;
  setLastPlannerContent: (c: string | null) => void;
  handleApprovePlan: () => Promise<void>;
  handleStartPlanning: (text: string) => Promise<void>;
  sendRunnerAndModels: () => Promise<void>;
  runApiKeyWizard: (preselected?: ApiProvider) => Promise<void>;
  discoverOrchestratorModelOptions: () => Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>;
  pickModelWithProvider: (options: { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[], configuredProviders: ApiProvider[], placeHolder: string, extraItems?: { label: string; detail?: string; modelId: string }[]) => Promise<string | undefined>;
  persistState: () => void;
  saveCurrentSession: () => void;
  log: (msg: string) => void;
}

/**
 * Wire a saved session into the running extension: stop any execution, adopt
 * the plan into the Session (so its tasks are executable and the conversation
 * can be resumed), and replay the chat transcript into the webview. No LLM
 * call happens here — the planner is only contacted when the user sends a
 * message. Returns false when the plan can't be loaded (e.g. runner mismatch).
 */
function applyLoadedSession(
  loaded: { meta: { id: string; goal: string }; plan: LegacyPlanState },
  deps: CommandDeps,
): boolean {
  deps.session.stopExecution();
  deps.terminalRunner.stopAll();
  try {
    deps.session.loadPlan(loaded.plan, loaded.meta.goal, deps.fsAdapter.getWorkspaceRoot(), { sessionId: loaded.meta.id });
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  deps.setCurrentPlan(loaded.plan);
  deps.setCurrentGoal(loaded.meta.goal);
  // restoreChat first — it resets any stuck stop/busy state in the webview
  // before the plan and goal messages land.
  deps.chatProvider.restoreChat(loaded.plan.conversationHistory ?? [], loaded.plan.tasks.length > 0);
  deps.chatProvider.setGoal(loaded.meta.goal);
  if (loaded.plan.tasks.length > 0) deps.chatProvider.planGenerated(loaded.plan);
  saveState(loaded.plan, deps.fsAdapter.getWorkspaceRoot());
  return true;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.focusChat', () => vscode.commands.executeCommand('ordewellChatView.focus')),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.configureApiKey', async () => {
      await deps.runApiKeyWizard();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.toggleRunner', async (runnerArg?: string) => {
      let target = runnerArg;
      if (!target) {
        const runners = deps.pluginRegistry.list();
        const enabled = deps.config.enabledRunners;
        const items = runners.map((r) => ({
          label: `${r.manifest.displayName}: ${enabled.includes(r.manifest.name) ? 'ON' : 'OFF'}`,
          value: r.manifest.name,
        }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Toggle a runner on/off' });
        if (!picked) return;
        target = picked.value;
      }
      if (!target) return;

      const enabled = deps.config.enabledRunners;
      const newEnabled = enabled.includes(target)
        ? enabled.filter((r) => r !== target)
        : [...enabled, target];

      await deps.config.update('enabledRunners', newEnabled);
      await deps.sendRunnerAndModels();
      vscode.window.showInformationMessage(`Enabled runners: ${newEnabled.length === 0 ? '(none — enable at least one)' : newEnabled.join(', ')}`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.addTask', async () => {
      const plan = deps.getCurrentPlan();
      if (plan.tasks.length === 0) {
        vscode.window.showInformationMessage('No plan exists yet. Describe your goal in the chat first.');
        return;
      }
      const title = await vscode.window.showInputBox({ prompt: 'Task title', placeHolder: 'e.g. Add error handling' });
      if (!title) return;

      const taskType = await vscode.window.showQuickPick(
        [{ label: 'AI Task', description: 'Executed by the coding assistant' }, { label: 'Manual Task', description: 'Step-by-step for the user' }],
        { placeHolder: 'Task type' },
      );
      if (!taskType) return;

      const typeValue = taskType.label === 'AI Task' ? 'ai' as const : 'user' as const;
      const description = await vscode.window.showInputBox({ prompt: 'Description (optional)', placeHolder: 'What this task accomplishes' });

      let prompt: string | undefined;
      let taskMode = 'build';
      let assignedRunner: string | undefined;

      if (typeValue === 'ai') {
        prompt = await vscode.window.showInputBox({ prompt: 'AI Prompt', placeHolder: 'Detailed instructions for the AI assistant' });
        const defaultRunner = plan.runners[0] ?? 'claude-code';
        const manifest = deps.pluginRegistry.getManifest(defaultRunner);
        const runnerModes = manifest?.modes ?? [];

        if (runnerModes.length > 0) {
          const modePick = await vscode.window.showQuickPick(
            runnerModes.map((m) => ({ label: m.label, description: m.description })),
            { placeHolder: 'Task mode' },
          );
          if (modePick) {
            taskMode = runnerModes.find((m) => m.label === modePick.label)?.id ?? 'build';
          }
        } else {
          const modePick = await vscode.window.showQuickPick(
            [{ label: 'Build', description: 'Edits files and runs commands' }, { label: 'Plan', description: 'Read-only analysis' }],
            { placeHolder: 'Task mode' },
          );
          if (modePick) taskMode = modePick.label === 'Build' ? 'build' : 'plan';
        }

        assignedRunner = defaultRunner;
      }

      await deps.session.addTask({
        title,
        description: description ?? title,
        type: typeValue,
        prompt,
        taskMode,
        assignedRunner,
        userSteps: typeValue === 'user' ? [{ order: 1, instruction: description ?? title, completed: false }] : undefined,
      });

      plan.lastUpdated = new Date().toISOString();
      deps.chatProvider.showPlan(plan);
      deps.persistState();
      vscode.window.showInformationMessage(`Added task: ${title}`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.removeTask', async (taskItem?: Task) => {
      let removeId: string | undefined = taskItem?.id;
      if (!removeId) {
        const plan = deps.getCurrentPlan();
        const allTasks = flattenTasks(plan.tasks);
        if (allTasks.length === 0) return;
        const picked = await vscode.window.showQuickPick(
          allTasks.map((t) => ({ label: `${t.order}. ${t.title}`, description: t.id })),
          { placeHolder: 'Select task to remove' },
        );
        if (!picked) return;
        const confirm = await vscode.window.showWarningMessage(
          `Remove "${picked.label}"? Dependencies on this task will be cleaned up.`,
          { modal: true },
          'Remove',
        );
        if (confirm !== 'Remove') return;
        removeId = picked.description;
      } else {
        const plan = deps.getCurrentPlan();
        const task = flattenTasks(plan.tasks).find((t) => t.id === removeId);
        if (!task) return;
        const confirm = await vscode.window.showWarningMessage(`Remove "${task.title}"?`, { modal: true }, 'Remove');
        if (confirm !== 'Remove') return;
      }

      await deps.session.removeTask(removeId);
      const plan = deps.getCurrentPlan();
      plan.lastUpdated = new Date().toISOString();
      if (plan.tasks.length === 0) {
        deps.chatProvider.setState('empty');
        clearState(deps.fsAdapter.getWorkspaceRoot());
      } else {
        deps.chatProvider.showPlan(plan);
      }
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.markTaskComplete', async (taskId?: string) => {
      if (!taskId) {
        const plan = deps.getCurrentPlan();
        const allTasks = flattenTasks(plan.tasks);
        const completable = allTasks.filter((t) => t.status !== 'completed');
        if (completable.length === 0) {
          vscode.window.showInformationMessage('No tasks to mark complete.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          completable.map((t) => ({ label: `${t.order}. ${t.title}`, description: t.id })),
          { placeHolder: 'Select task to mark complete' },
        );
        if (!picked) return;
        taskId = picked.description;
      }
      await deps.session.markTaskComplete(taskId);
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.markTaskIncomplete', async (taskId?: string) => {
      if (!taskId) {
        const plan = deps.getCurrentPlan();
        const completed = flattenTasks(plan.tasks).filter((t) => t.status === 'completed');
        if (completed.length === 0) {
          vscode.window.showInformationMessage('No completed tasks to mark not done.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          completed.map((t) => ({ label: `${t.order}. ${t.title}`, description: t.id })),
          { placeHolder: 'Select task to mark not done' },
        );
        if (!picked) return;
        taskId = picked.description;
      }
      await deps.session.markTaskIncomplete(taskId);
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.forceStartTask', async (taskItem?: Task) => {
      const taskId = taskItem?.id;
      if (!taskId) return;
      await deps.session.forceStartTask(taskId);
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.skipTask', async (taskItem?: Task) => {
      const taskId = taskItem?.id;
      if (!taskId) return;
      await deps.session.markTaskComplete(taskId);
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.retryTask', async (taskItem?: Task) => {
      const taskId = taskItem?.id;
      if (!taskId) return;
      await deps.session.retryTask(taskId);
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.cancelTask', async (taskItem?: Task) => {
      const taskId = taskItem?.id;
      if (!taskId) return;
      await deps.session.cancelTask(taskId);
      deps.persistState();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.saveSession', async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'Session name (describes what you built)',
        placeHolder: deps.getCurrentGoal() || 'My session',
        value: deps.getCurrentGoal(),
      });
      if (!goal) return;
      deps.setCurrentGoal(goal);
      deps.saveCurrentSession();
      vscode.window.showInformationMessage(`Session saved: "${goal}"`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.loadSession', async () => {
      const sessions = listSessions(deps.fsAdapter.getWorkspaceRoot());
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No previous sessions found.');
        return;
      }
      const items = sessions.map((s) => ({
        label: s.goal,
        description: `${new Date(s.createdAt).toLocaleDateString()} — ${s.taskCount} tasks — ${s.runners.join(', ')}`,
        detail: `Status: ${s.status} | Updated: ${new Date(s.updatedAt).toLocaleString()}`,
        sessionId: s.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Load a previous session (${sessions.length} available)`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      const loaded = loadSession(picked.sessionId, deps.fsAdapter.getWorkspaceRoot());
      if (!loaded) {
        vscode.window.showErrorMessage('Failed to load session.');
        return;
      }
      if (!applyLoadedSession(loaded, deps)) return;
      deps.log(`Loaded session: ${loaded.meta.id} — "${loaded.meta.goal}"`);
      vscode.window.showInformationMessage(`Loaded session: "${loaded.meta.goal}" (${loaded.meta.taskCount} tasks)`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.loadSessionById', async (sessionId: string) => {
      const loaded = loadSession(sessionId, deps.fsAdapter.getWorkspaceRoot());
      if (!loaded) {
        vscode.window.showErrorMessage('Failed to load session.');
        return;
      }
      if (!applyLoadedSession(loaded, deps)) return;
      deps.log(`Loaded session by id: ${loaded.meta.id}`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.clearPlan', async () => {
      const confirm = await vscode.window.showWarningMessage('Clear all tasks? This cannot be undone.', { modal: true }, 'Yes, clear all');
      if (confirm === 'Yes, clear all') {
        // Full core reset so the cleared plan can't resurface from the
        // Session's PlanStore or a still-live planner conversation.
        deps.session.reset();
        deps.terminalRunner.stopAll();
        deps.setCurrentPlan(createEmptyPlan());
        deps.chatProvider.setState('empty');
        clearState(deps.fsAdapter.getWorkspaceRoot());
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.newSession', async () => {
      const plan = deps.getCurrentPlan();
      const hasContent = plan.tasks.length > 0
        || (plan.conversationHistory?.length ?? 0) > 0
        || deps.session.isExecuting
        || deps.isGeneratingPlan();
      if (hasContent) {
        const confirm = await vscode.window.showWarningMessage(
          'Start a new session? Current plan and progress will be cleared.',
          { modal: true },
          'New Session',
        );
        if (confirm !== 'New Session') return;
      }
      // Suppress the abort error from the orphaned planner turn before
      // resetting — without this, session.reset() aborts the in-flight LLM
      // call, and the catch block in handleStartPlanning/handleContinueConversation
      // surfaces "Planner failed: Request was aborted." in the new session.
      deps.setGeneratingPlan(false);
      deps.getResearchAbort()?.abort();
      deps.setResearchAbort(null);
      deps.setLastPlannerContent(null);
      // Full core reset — clearing only host-side state leaves the previous
      // session's tasks and live planner conversation inside the Session,
      // which then leak into the next planning chat as the "current plan".
      deps.session.reset();
      deps.terminalRunner.stopAll();
      deps.setCurrentPlan(createEmptyPlan());
      deps.setCurrentGoal('');
      deps.chatProvider.setState('empty');
      deps.chatProvider.setGoal('');
      clearState(deps.fsAdapter.getWorkspaceRoot());
      deps.log('New session started');
      vscode.window.showInformationMessage('New session started.');
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.approvePlan', async () => {
      const plan = deps.getCurrentPlan();
      if (plan.tasks.length === 0) {
        vscode.window.showInformationMessage('No plan to approve. Generate a plan first.');
        return;
      }
      await deps.handleApprovePlan();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.regeneratePlan', async () => {
      const goal = deps.getCurrentGoal();
      if (!goal) {
        vscode.window.showInformationMessage('No goal to regenerate from. Describe a goal first.');
        return;
      }
      const notReady = plannerPreflightError(deps.config);
      if (notReady) {
        deps.chatProvider.showError(notReady);
        return;
      }
      await deps.handleStartPlanning(goal);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.exportPlan', async () => {
      const plan = deps.getCurrentPlan();
      if (!plan || plan.tasks.length === 0) {
        vscode.window.showInformationMessage('No plan to export.');
        return;
      }
      const defaultName = deps.getCurrentGoal()
        ? `ordewell-plan-${deps.getCurrentGoal().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}.json`
        : 'ordewell-plan.json';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), defaultName)),
        filters: { JSON: ['json'] },
      });
      if (!uri) return;
      const data = {
        goal: deps.getCurrentGoal() || '(untitled)',
        runners: plan.runners,
        tasks: flattenTasks(plan.tasks).map((t) => ({
          id: t.id,
          order: t.order,
          title: t.title,
          type: t.type,
          description: t.description,
          dependencies: t.dependencies,
          assignedRunner: t.assignedRunner,
          assignedModel: t.assignedModel || null,
          taskMode: t.taskMode || 'build',
          prompt: t.prompt || null,
          subtasks: t.subtasks || [],
          userSteps: t.userSteps || undefined,
          thinkingEffort: t.thinkingEffort || undefined,
        })),
      };
      await nodeFs.writeFile(uri.fsPath, JSON.stringify(data, null, 2));
      vscode.window.showInformationMessage(`Plan exported to ${path.basename(uri.fsPath)}`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.configureModelAllowlist', async () => {
      await configureModelAllowlist(deps.pluginRegistry, deps.modelResolver, deps.settingsService);
    }),
  );
}
