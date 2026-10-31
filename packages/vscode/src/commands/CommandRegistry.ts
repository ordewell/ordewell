import * as vscode from 'vscode';
import * as path from 'path';
import { promises as nodeFs } from 'fs';
import {
  Session, LegacyPlanState, createEmptyPlan, Task, flattenTasks, flattenTasksWithParents,
  DEFAULT_RUNNERS, ModelResolver, RunnerRegistry, saveState, clearState,
  listSessions, loadSession,
  SettingsService, installedPlannerDetected,
  taskActionCommand, taskRowView, type ExecutionCommand, type TaskAction,
} from '@ordewell/core';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { forkConversation, rewindConversation, compactConversation } from '../plan/conversation';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import { SecretStore, type ApiProvider } from '../adapters/SecretStore';
import { configureModelAllowlist } from './configureModelAllowlist';
import { toggleRunner } from './enabledRunners';
import { executeUserCommand, forceStartPastGate, handleNewSession, markTaskByHand, type PlanManagerDeps } from '../plan/PlanManager';

export interface CommandDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  runnerRegistry: RunnerRegistry;
  modelResolver: ModelResolver;
  config: VsCodeConfig;
  fsAdapter: VsCodeFileSystem;
  /** The login probe a signed-out compaction asks again before the session gate judges. */
  runnerInstallation?: PlanManagerDeps['runnerInstallation'];
  settingsService: SettingsService;
  secretStore: SecretStore;
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  isGeneratingPlan: () => boolean;
  handleApprovePlan: () => Promise<void>;
  handleStartPlanning: (text: string) => Promise<void>;
  sendRunnerAndModels: () => Promise<void>;
  runApiKeyWizard: (preselected?: ApiProvider) => Promise<void>;
  persistState: () => void;
  /** Null once written; otherwise why nothing was. */
  saveCurrentSession: () => string | null;
  /** Push this window's run settings after its session is loaded or replaced (ADR-0030). */
  sendRunSettings: () => void;
  /** Release the oldest prompt held while the planner was busy, once it no longer is. */
  sendNextHeldPrompt: () => void;
  log: (msg: string) => void;
}

/**
 * QuickPick items over every task in a plan, subtasks dotted under their parent
 * — same path label the webview cards render, so the palette pickers and
 * the rendered plan never disagree about what "2.1" means.
 */
export function orderLabelItems(plan: LegacyPlanState): { label: string; description: string }[] {
  return flattenTasksWithParents(plan.tasks).map(({ task, label }) => ({
    label: `${label}. ${task.title}`,
    description: task.id,
  }));
}

/**
 * Whether a task's card offers `action`: a fresh retry on a failed task, else
 * what its row offers, read against the plan as the card reads it, so a task
 * held up by a failed dependency is blocked and offers Skip.
 */
function offers(action: Exclude<TaskAction, 'run' | 'complete' | 'uncomplete'>, task: Task, parent: Task | null, plan: LegacyPlanState): boolean {
  if (action === 'retry') return task.status === 'failed' && task.type !== 'user';
  return taskRowView(task, { parent, tasks: plan.tasks }).actions.includes(action);
}

const PICK_WORDS = {
  'force-start': { placeHolder: 'Select task to force start', none: 'No tasks to force start.' },
  skip: { placeHolder: 'Select task to skip', none: 'No tasks to skip.' },
  retry: { placeHolder: 'Select failed task to retry', none: 'No failed tasks to retry.' },
  cancel: { placeHolder: 'Select running task to cancel', none: 'No running tasks to cancel.' },
} as const;

/**
 * The task a task command acts on: the one its caller passed, or one picked
 * from those it applies to. The Command Palette passes none, and these
 * commands did nothing from it.
 */
export async function pickTaskFor(action: keyof typeof PICK_WORDS, plan: LegacyPlanState, passed?: Task | string): Promise<string | undefined> {
  const id = typeof passed === 'string' ? passed : passed?.id;
  if (id) return id;
  const items = flattenTasksWithParents(plan.tasks)
    .filter(({ task, parent }) => offers(action, task, parent, plan))
    .map(({ task, label }) => ({ label: `${label}. ${task.title}`, description: task.id }));
  if (items.length === 0) {
    vscode.window.showInformationMessage(PICK_WORDS[action].none);
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder: PICK_WORDS[action].placeHolder }))?.description;
}

/**
 * Wire a saved session into the running extension: adopt the plan into the
 * Session, which ends the outgoing plan's run and planner turn, so its tasks
 * are executable and the conversation can be resumed; then replay the chat
 * transcript into the webview. No LLM call happens here — the planner is only
 * contacted when the user sends a message. Returns false when the plan can't
 * be loaded (e.g. runner mismatch).
 */
function applyLoadedSession(
  loaded: { meta: { id: string; goal: string }; plan: LegacyPlanState },
  deps: CommandDeps,
): boolean {
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
  deps.chatProvider.restoreChat(loaded.plan);
  if (loaded.plan.tasks.length > 0) deps.chatProvider.showPlan(loaded.plan);
  // The loaded session's run is a plan no message carried: seed the run view
  // from the session, so isolation marks and a pending checkpoint come with it.
  deps.chatProvider.adoptRun(deps.session.runSnapshot());
  saveState(loaded.plan, deps.fsAdapter.getWorkspaceRoot(), loaded.meta.id);
  // The Run block now speaks for the session just loaded, not the outgoing one.
  deps.sendRunSettings();
  return true;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  // The plan pane's buttons and these commands run one path: the command seam, as the user (ADR-0029).
  const userCommand = async (command: ExecutionCommand | (() => Promise<void>)): Promise<void> => {
    try {
      await (typeof command === 'function' ? command() : executeUserCommand(deps.session, command));
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
    deps.persistState();
  };
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
      // Built on the stale default, a toggle would save claude-code over the
      // installed agents the probe is about to find; the daemon route waits too.
      await installedPlannerDetected();
      let target = runnerArg;
      if (!target) {
        const runners = deps.runnerRegistry.list();
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

      const { enabled, keptLast } = await toggleRunner(
        {
          settingsService: deps.settingsService,
          config: deps.config,
          sendRunnerAndModels: deps.sendRunnerAndModels,
        },
        target,
      );
      vscode.window.showInformationMessage(keptLast
        ? `${target} is the only enabled runner, so it stays on: enable another runner first.`
        : `Enabled runners: ${enabled.join(', ')}`);
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
        const defaultRunner = plan.runners[0] ?? DEFAULT_RUNNERS[0];
        const manifest = deps.runnerRegistry.getManifest(defaultRunner);
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
            [{ label: 'Build', description: 'Edits files and runs commands' }, { label: 'Read-only', description: 'Ordewell commands; lands nothing' }],
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
        const items = orderLabelItems(plan);
        if (items.length === 0) return;
        const picked = await vscode.window.showQuickPick(
          items,
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
        const items = orderLabelItems(plan).filter(({ description }) => {
          const task = flattenTasks(plan.tasks).find((t) => t.id === description);
          return task && task.status !== 'completed';
        });
        if (items.length === 0) {
          vscode.window.showInformationMessage('No tasks to mark complete.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          items,
          { placeHolder: 'Select task to mark complete' },
        );
        if (!picked) return;
        taskId = picked.description;
      }
      await userCommand(() => markTaskByHand('complete', taskId!, deps));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.markTaskIncomplete', async (taskId?: string) => {
      if (!taskId) {
        const plan = deps.getCurrentPlan();
        const items = orderLabelItems(plan).filter(({ description }) => {
          const task = flattenTasks(plan.tasks).find((t) => t.id === description);
          return task && task.status === 'completed';
        });
        if (items.length === 0) {
          vscode.window.showInformationMessage('No completed tasks to mark not done.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          items,
          { placeHolder: 'Select task to mark not done' },
        );
        if (!picked) return;
        taskId = picked.description;
      }
      await userCommand(() => markTaskByHand('uncomplete', taskId!, deps));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.forceStartTask', async (taskItem?: Task | string) => {
      const taskId = await pickTaskFor('force-start', deps.getCurrentPlan(), taskItem);
      if (!taskId) return;
      await userCommand(() => forceStartPastGate(taskId, deps));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.skipTask', async (taskItem?: Task | string) => {
      const taskId = await pickTaskFor('skip', deps.getCurrentPlan(), taskItem);
      if (!taskId) return;
      await userCommand(taskActionCommand('skip', taskId));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.retryTask', async (taskItem?: Task | string) => {
      const taskId = await pickTaskFor('retry', deps.getCurrentPlan(), taskItem);
      if (!taskId) return;
      await userCommand(taskActionCommand('retry', taskId));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.cancelTask', async (taskItem?: Task | string) => {
      const taskId = await pickTaskFor('cancel', deps.getCurrentPlan(), taskItem);
      if (!taskId) return;
      await userCommand(taskActionCommand('cancel', taskId));
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
      const unsaved = deps.saveCurrentSession();
      if (unsaved) vscode.window.showWarningMessage(`Session not saved: ${unsaved}`);
      else vscode.window.showInformationMessage(`Session saved: "${goal}"`);
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
        description: `${new Date(s.createdAt).toLocaleDateString()}: ${s.taskCount} tasks: ${s.runners.join(', ')}`,
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
      deps.log(`Loaded session: ${loaded.meta.id}: "${loaded.meta.goal}"`);
      vscode.window.showInformationMessage(`Loaded session: "${loaded.meta.goal}" (${loaded.meta.taskCount} tasks)`);
    }),
  );
  context.subscriptions.push(
    // Answers whether the session was opened, so a caller does not say it was.
    vscode.commands.registerCommand('ordewell.loadSessionById', async (sessionId: string): Promise<boolean> => {
      const loaded = loadSession(sessionId, deps.fsAdapter.getWorkspaceRoot());
      if (!loaded) {
        vscode.window.showErrorMessage('Failed to load session.');
        return false;
      }
      if (!applyLoadedSession(loaded, deps)) return false;
      deps.log(`Loaded session by id: ${loaded.meta.id}`);
      return true;
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.forkConversation', () => forkConversation(deps)),
    vscode.commands.registerCommand('ordewell.rewindConversation', (arg?: string) => rewindConversation(deps, arg)),
    // A compaction is a planner turn, and prompts typed while it ran were held behind it.
    vscode.commands.registerCommand('ordewell.compactConversation', () => compactConversation(deps).finally(() => deps.sendNextHeldPrompt())),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.clearPlan', async () => {
      const confirm = await vscode.window.showWarningMessage('Clear all tasks? This cannot be undone.', { modal: true }, 'Yes, clear all');
      if (confirm === 'Yes, clear all') {
        // Full core reset so the cleared plan can't resurface from the
        // Session's PlanStore or a still-live planner conversation.
        deps.session.reset();
        deps.setCurrentPlan(createEmptyPlan());
        deps.chatProvider.setState('empty');
        deps.chatProvider.conversation.reset();
        deps.chatProvider.run.reset();
        clearState(deps.fsAdapter.getWorkspaceRoot());
        // reset() keeps the outgoing plan's run settings; with no plan open the file is what the next one opens with (ADR-0030).
        deps.sendRunSettings();
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
      handleNewSession(deps);
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
      // A fresh plan ends the old one's scope, and with it the run; the old
      // plan is gone before the planner answers, so ask as New Session does.
      const run = deps.session.activity;
      const running = deps.session.isExecuting || run.advancesOnItsOwn || run.resumable;
      if (running || deps.getCurrentPlan().tasks.length > 0) {
        const confirm = await vscode.window.showWarningMessage(
          running
            ? 'Regenerate the plan? The run in progress is stopped, and the current plan and its progress are replaced.'
            : 'Regenerate the plan? The current plan and its progress are replaced.',
          { modal: true },
          'Regenerate',
        );
        if (confirm !== 'Regenerate') return;
      }
      // The session's planner gate waits for the probe and refuses an
      // unready planner in the chat's own words; a wait here read as idle.
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
        })),
      };
      await nodeFs.writeFile(uri.fsPath, JSON.stringify(data, null, 2));
      vscode.window.showInformationMessage(`Plan exported to ${path.basename(uri.fsPath)}`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.configureModelAllowlist', async () => {
      await configureModelAllowlist(deps.runnerRegistry, deps.modelResolver, deps.settingsService, undefined, (allowlist) => deps.chatProvider.setModelAllowlist(allowlist));
    }),
  );
}
