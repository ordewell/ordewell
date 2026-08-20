import * as vscode from 'vscode';
import { AiProvider, ConversationMessage, LegacyPlanState, Task, DiscoveredModel, ResearchProgress, RunnerId, TaskStatus } from '@ordewell/core';

type ChatWebviewMessage =
  | {
      type: 'sendMessage';
      text: string;
      runners?: RunnerId[];
      actionContext?: {
        type: 'approve' | 'retry' | 'skip' | 'cancel' | 'execute' | 'merge' | 'split' | 'addTask';
        taskId?: string;
      };
    }
  | {
      type: 'sendSystemCommand';
      command: 'cancel' | 'skip' | 'forceStart' | 'runTask' | 'markComplete' | 'markIncomplete' | 'stopExecution' | 'executePlan';
      taskId?: string;
    }
  | { type: 'ready' }
  | { type: 'stopResearch' }
  | { type: 'newSession' }
  | { type: 'toggleSkill'; skillId: string; enabled: boolean }
  /** Who plans (ADR-0009) — a vendor provider id or one of the harness planners. */
  | { type: 'setPlanner'; provider: string }
  /** The planner's own model and thinking effort, a pair so neither can outlive the other. */
  | { type: 'setPlannerModel'; modelId: string; effort?: string };

/** One selectable planner backend, with the reason it can't be picked when it can't. */
export interface PlannerBackend {
  id: string;
  label: string;
  kind: 'harness' | 'vendor';
  /** Harness planners only: the runner whose catalog supplies this planner's models. */
  runner?: string;
  usable: boolean;
  reason?: string;
}

export interface RunnerMeta {
  id: string;
  displayName: string;
  enabled: boolean;
}

// The union core owns, not a copy of it: a hand-maintained duplicate silently
// diverged the moment ADR-0009 added the three harness planners.
type ApiProvider = AiProvider;

type ExtensionChatMessage =
  | { type: 'setState'; state: 'empty' | 'researching' | 'planDraft' | 'approved' | 'error' }
  | { type: 'newMessage'; message: { role: string; content: string; timestamp: string } }
  | { type: 'planUpdated'; plan: LegacyPlanState }
  | { type: 'streamToken'; token: string }
  | { type: 'researchProgress'; step: ResearchProgress }
  | { type: 'executionStatus'; taskId: string; status: TaskStatus }
  | { type: 'taskOutput'; taskId: string; text: string }
  | { type: 'taskIdle'; taskId: string; idleSince: string | null }
  | { type: 'queueStatus'; count: number }
  | { type: 'showError'; error: string }
  | { type: 'focusTask'; taskId: string }
  | { type: 'setModels'; models: DiscoveredModel[] }
  | { type: 'setRunners'; runners: RunnerMeta[] }
  // `unavailable` lists toggles that have no meaning for the current planner
  // backend — hidden rather than silently ignored (ADR-0009, T8).
  | { type: 'setSkillToggles'; toggles: Record<string, boolean>; unavailable?: string[] }
  /** Discovered skills (global ~/.ordewell/skills/ + workspace .ordewell/skills/, workspace shadows global) for the /skill-name suggestion dropdown. */
  | { type: 'setSkills'; skills: { name: string; description: string }[] }
  | { type: 'plannerInterrupted'; message: { role: string; content: string; timestamp: string } }
  | { type: 'researchStream'; steps: string[]; isActive: boolean }
  | { type: 'setConfiguredProviders'; providers: ApiProvider[] }
  | { type: 'setModelOptions'; modelOptions: { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[] }
  | { type: 'setModelsByRunner'; modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> }
  | { type: 'setModesByRunner'; modesByRunner: Record<string, { id: string; label: string; description: string; cliValue?: string; autonomous?: boolean }[]> }
  | { type: 'setModelConfig'; modelConfig: { orchestrator: string; orchestratorProvider?: string } }
  | { type: 'setPlannerBackends'; backends: PlannerBackend[]; provider: string; runner?: string; effort?: string }
  | { type: 'setModelApiMapping'; modelApiMapping: Record<string, ApiProvider[]> }
  | { type: 'setModelDiscoveryErrors'; errors: Record<string, string> }
  | { type: 'planApproved' }
  | { type: 'showWarnings'; warnings: string; pendingTasks: Task[] }
  | { type: 'checkpoint'; taskId: string; taskTitle: string; summary: string }
  | { type: 'setGoal'; goal: string }
  | { type: 'restoreChat'; history: ConversationMessage[]; hasPlan: boolean };

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _onMessage = new vscode.EventEmitter<ChatWebviewMessage>();
  readonly onMessage = this._onMessage.event;
  private _pendingTasks: Task[] | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews')],
    };
    webviewView.webview.onDidReceiveMessage((msg: ChatWebviewMessage) => this._onMessage.fire(msg));
    this.renderHtml(webviewView);
  }

  postMessage(msg: ExtensionChatMessage): void { this._view?.webview.postMessage(msg); }
  setState(state: 'empty' | 'researching' | 'planDraft' | 'approved' | 'error'): void { this.postMessage({ type: 'setState', state }); }
  showError(error: string): void { this.postMessage({ type: 'showError', error }); }
  streamToken(token: string): void { this.postMessage({ type: 'streamToken', token }); }
  sendResearchProgress(step: ResearchProgress): void { this.postMessage({ type: 'researchProgress', step }); }
  sendPlanUpdated(plan: LegacyPlanState): void { this._cachedPlan = plan; this.postMessage({ type: 'planUpdated', plan }); }
  showQueueStatus(count: number): void { this.postMessage({ type: 'queueStatus', count }); }
  focusTask(taskId: string): void { this.postMessage({ type: 'focusTask', taskId }); }
  sendExecutionStatus(taskId: string, status: TaskStatus): void { this.postMessage({ type: 'executionStatus', taskId, status }); }
  /** Live runner output for one task; the webview keeps the tail and renders it in that task's card. */
  sendTaskOutput(taskId: string, text: string): void { this.postMessage({ type: 'taskOutput', taskId, text }); }
  /** Advisory silence timestamp for one task; null clears the stalled indicator. */
  sendTaskIdle(taskId: string, idleSince: string | null): void { this.postMessage({ type: 'taskIdle', taskId, idleSince }); }
  setModels(models: DiscoveredModel[]): void {
    this.postMessage({ type: 'setModels', models });
  }
  setRunners(runners: RunnerMeta[]): void { this.postMessage({ type: 'setRunners', runners }); }
  setSkillToggles(tdd: boolean, verify: boolean, unavailable: string[] = []): void {
    this.postMessage({ type: 'setSkillToggles', toggles: { tdd, verify }, unavailable });
  }
  setSkills(skills: { name: string; description: string }[]): void {
    this.postMessage({ type: 'setSkills', skills });
  }
  /** A planner conversation message (ADR-0002) — rendered as an assistant chat bubble. */
  sendNewMessage(content: string, timestamp?: string): void {
    this.postMessage({ type: 'newMessage', message: { role: 'assistant', content, timestamp: timestamp ?? new Date().toISOString() } });
  }
  sendPlannerInterrupted(content: string): void {
    this.postMessage({
      type: 'plannerInterrupted',
      message: { role: 'planner', content, timestamp: new Date().toISOString() },
    });
  }
  sendResearchStream(steps: string[], isActive: boolean): void {
    this.postMessage({ type: 'researchStream', steps, isActive });
  }
  /**
   * Rebuild the webview timeline from the persisted planner dialogue. The
   * single restore path for session load, webview reload, and window restore —
   * it also clears any stuck stop/busy state client-side.
   */
  restoreChat(history: ConversationMessage[], hasPlan: boolean): void {
    this.postMessage({ type: 'restoreChat', history, hasPlan });
  }

  showPlan(plan: LegacyPlanState): void { this.sendPlanUpdated(plan); }
  showWarnings(message: string, pendingTasks: Task[]): void {
    this._pendingTasks = pendingTasks;
    this.postMessage({ type: 'showWarnings', warnings: message, pendingTasks });
  }

  // Legacy pass-throughs forwarding to new protocol types
  planGenerated(plan: LegacyPlanState): void { this.sendPlanUpdated(plan); }
  planApproved(): void { this.setState('approved'); this.postMessage({ type: 'planApproved' }); }
  /**
   * Only updates the goal label. Deliberately NOT coupled to setState: a
   * falsy goal used to send setState('empty'), which wipes the whole webview
   * timeline — so any planner turn finishing while the host had lost its goal
   * (e.g. after a window reload) erased the conversation. Callers that mean
   * "reset the chat" call setState('empty') explicitly.
   */
  setGoal(goal: string): void {
    this.postMessage({ type: 'setGoal', goal });
  }
  showCheckpoint(taskId: string, taskTitle: string, summary: string): void {
    this.postMessage({ type: 'checkpoint', taskId, taskTitle, summary });
  }

  // Config pass-throughs — store locally and emit on request
  setModelsByRunner(modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>): void {
    this._modelsByRunner = modelsByRunner;
    this.postMessage({ type: 'setModelsByRunner', modelsByRunner });
  }
  setModesByRunner(modesByRunner: Record<string, { id: string; label: string; description: string; cliValue?: string; autonomous?: boolean }[]>): void {
    this._modesByRunner = modesByRunner;
    this.postMessage({ type: 'setModesByRunner', modesByRunner });
  }
  setRunnerList(runners: { id: string; displayName: string }[]): void {
    this._runnerList = runners;
    this._emitConsolidatedRunners();
  }
  setEnabledRunnerIds(ids: string[]): void {
    this._enabledRunnerIds = ids;
    this._emitConsolidatedRunners();
  }
  setModelConfig(cfg: { orchestrator: string; orchestratorProvider?: string }): void {
    this._modelConfig = cfg;
    this.postMessage({ type: 'setModelConfig', modelConfig: cfg });
  }
  setModelOptions(options: { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]): void {
    this._modelOptions = options;
    this.postMessage({ type: 'setModelOptions', modelOptions: options });
  }
  sendConfiguredProviders(providers: ApiProvider[]): void {
    this._configuredProviders = providers;
    this.postMessage({ type: 'setConfiguredProviders', providers });
  }
  setModelApiMapping(mapping: Record<string, ApiProvider[]>): void {
    this._modelApiMapping = mapping;
    this.postMessage({ type: 'setModelApiMapping', modelApiMapping: mapping });
  }
  setModelDiscoveryErrors(errors: Record<string, string>): void {
    this._modelDiscoveryErrors = errors;
    this.postMessage({ type: 'setModelDiscoveryErrors', errors });
  }
  /** Who can plan, who does plan, and that planner's effort — one message, so the webview never renders a half-switched planner. */
  setPlannerBackends(backends: PlannerBackend[], provider: string, runner?: string, effort?: string): void {
    this._plannerState = { backends, provider, runner, effort };
    this.postMessage({ type: 'setPlannerBackends', backends, provider, runner, effort });
  }

  private _modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  private _modesByRunner: Record<string, { id: string; label: string; description: string; cliValue?: string; autonomous?: boolean }[]> = {};
  private _runnerList: { id: string; displayName: string }[] = [];
  private _enabledRunnerIds: string[] = [];
  private _modelConfig: { orchestrator: string; orchestratorProvider?: string } | null = null;
  private _modelOptions: { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[] = [];
  private _configuredProviders: ApiProvider[] = [];
  private _modelApiMapping: Record<string, ApiProvider[]> = {};
  private _modelDiscoveryErrors: Record<string, string> = {};
  private _plannerState: { backends: PlannerBackend[]; provider: string; runner?: string; effort?: string } | null = null;
  private _cachedPlan: LegacyPlanState | null = null;

  /**
   * Re-send every cached piece of state to the webview. Safe to call once the
   * webview is resolved (_view is set); no-ops are silently dropped otherwise.
   * Used from the `ready` message handler so the webview gets the full discovery
   * state without re-running expensive commands.
   */
  resendAllState(): void {
    // Rebuild flat model list from per-runner discovery data, preserving
    // variants and the runner provider so the UI can group and select thinking
    // variants correctly after a webview reload.
    const flatModels: DiscoveredModel[] = [];
    for (const models of Object.values(this._modelsByRunner)) {
      for (const m of models ?? []) {
        if (!flatModels.find((x) => x.modelId === m.modelId)) {
          flatModels.push(m);
        }
      }
    }
    if (flatModels.length > 0) {
      this.postMessage({ type: 'setModels', models: flatModels });
    }
    if (Object.keys(this._modelsByRunner).length > 0) {
      this.postMessage({ type: 'setModelsByRunner', modelsByRunner: this._modelsByRunner });
    }
    if (this._modelOptions.length > 0) {
      this.postMessage({ type: 'setModelOptions', modelOptions: this._modelOptions });
    }
    if (this._configuredProviders.length > 0) {
      this.postMessage({ type: 'setConfiguredProviders', providers: this._configuredProviders });
    }
    if (Object.keys(this._modelApiMapping).length > 0) {
      this.postMessage({ type: 'setModelApiMapping', modelApiMapping: this._modelApiMapping });
    }
    if (Object.keys(this._modelDiscoveryErrors).length > 0) {
      this.postMessage({ type: 'setModelDiscoveryErrors', errors: this._modelDiscoveryErrors });
    }
    if (this._modesByRunner && Object.keys(this._modesByRunner).length > 0) {
      this.postMessage({ type: 'setModesByRunner', modesByRunner: this._modesByRunner });
    }
    if (this._modelConfig) {
      this.postMessage({ type: 'setModelConfig', modelConfig: this._modelConfig });
    }
    if (this._plannerState) {
      this.postMessage({ type: 'setPlannerBackends', ...this._plannerState });
    }
    this._emitConsolidatedRunners();
  }

  private _emitConsolidatedRunners(): void {
    const enabledSet = new Set(this._enabledRunnerIds);
    const runners: RunnerMeta[] = this._runnerList.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      enabled: enabledSet.has(r.id),
    }));
    if (runners.length > 0) this.setRunners(runners);
  }

  getPendingTasks(): Task[] | null {
    return this._pendingTasks;
  }

  private renderHtml(webviewView: vscode.WebviewView): void {
    const nonce = getNonce();
    const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews', 'chat.js'));
    const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews', 'assets', 'chat.css'));
    const cspSource = webviewView.webview.cspSource;
    webviewView.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; style-src-elem ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource}; img-src ${cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Ordewell Chat</title>
</head>
<body><div id="root"></div><script type="module" nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
  }
}
