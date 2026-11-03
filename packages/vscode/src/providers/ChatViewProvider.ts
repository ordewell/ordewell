import * as vscode from 'vscode';
import { DELEGATION_OFFERED, type AccountLimitSnapshot, type GlobalRunSettings, type IsolationPreview, surfacePlan, type AiProvider, type LegacyPlanState, type DiscoveredModel, type PlanStatus, type RunnerId, type RunActivity, type RunView } from '@ordewell/core';
import { ConversationViewHost, type SavedConversation } from '../ConversationViewHost';
import { RunViewHost } from '../RunViewHost';
import { renderWebviewHtml } from './webviewHtml';
import type { ChatState, HostToWebview, ModelOption, PlannerBackend, RunnerMeta, RunnerModeMeta, WebviewToHost } from '@ordewell/ui/protocol';

export type { PlannerBackend, RunnerMeta } from '@ordewell/ui/protocol';

// The union core owns, not a copy of it: a hand-maintained duplicate silently
// diverged the moment ADR-0009 added the three harness planners.
type ApiProvider = AiProvider;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _viewDisposables: { dispose(): unknown }[] = [];
  private _onMessage = new vscode.EventEmitter<WebviewToHost>();
  readonly onMessage = this._onMessage.event;
  /** The planner conversation as the webview draws it; every planner event and local notice goes through here. */
  readonly conversation = new ConversationViewHost((msg) => this.postMessage(msg));
  /** The run as the webview draws it; every session event and adopted snapshot goes through here (#S8c). */
  readonly run = new RunViewHost((msg) => this.postMessage(msg));
  /**
   * What the dock shows as each plan's status, kept here rather than written
   * onto the plan: the plan object is the Session's own, and its status once
   * decided whether the user had approved it (ADR-0029).
   */
  private readonly dockStatus = new WeakMap<LegacyPlanState, PlanStatus>();

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this.releaseView();
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews')],
    };
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this._onMessage.fire(msg)),
      // Posting to a disposed webview throws; a later resolve replaces the view
      // before this fires, so only the current one may clear the slot.
      webviewView.onDidDispose(() => { if (this._view === webviewView) this.releaseView(); }),
    );
    this.renderHtml(webviewView);
  }

  private releaseView(): void {
    for (const d of this._viewDisposables) d.dispose();
    this._viewDisposables = [];
    this._view = undefined;
  }

  postMessage(msg: HostToWebview): void { this._view?.webview.postMessage(msg); }
  /**
   * Bring the chat to the front. A question that arrives behind a hidden view
   * is one nobody answers, so an approval request calls this before it lands.
   */
  reveal(): void {
    if (this._view) this._view.show(true);
    else void vscode.commands.executeCommand('ordewellChatView.focus');
  }
  setState(state: ChatState): void { this.postMessage({ type: 'setState', state }); }
  showError(error: string): void { this.postMessage({ type: 'showError', error }); }
  /**
   * The session's own plan stays with the extension host (it persists and
   * resumes from there); the webview is sent it without skill bodies. The plan
   * is plan-level state only — every task's status lives on the run view.
   * A status given is the dock's from now on for this plan, until another.
   */
  showPlan(plan: LegacyPlanState, status?: PlanStatus): void {
    if (status) this.dockStatus.set(plan, status);
    this.postMessage({ type: 'planUpdated', plan: { ...surfacePlan(plan), status: this.dockStatus.get(plan) ?? plan.status } });
  }
  /** What a webview that joined mid-run is owed: the run as folding every message would show it. */
  adoptRun(view: RunView): void { this.run.adopt(view); }
  /** Live runner output for one task; the webview keeps the tail and renders it in that task's card. */
  sendTaskOutput(taskId: string, text: string): void { this.postMessage({ type: 'taskOutput', taskId, text }); }
  setModels(models: DiscoveredModel[]): void {
    this.postMessage({ type: 'setModels', models });
  }
  setRunners(runners: RunnerMeta[]): void { this.postMessage({ type: 'setRunners', runners }); }
  setPlanDockHeight(height: number | undefined): void {
    this.postMessage({ type: 'planDockHeight', height });
  }
  setRunSettings(autonomous: boolean, run: GlobalRunSettings, maxParallel: number): void {
    this.postMessage({ type: 'setRunSettings', autonomous, run, maxParallel, delegationOffered: DELEGATION_OFFERED });
  }
  openSettings(): void { this.postMessage({ type: 'openSettings' }); }
  setTaskSkills(skills: { name: string; description: string }[]): void {
    this.postMessage({ type: 'setTaskSkills', skills });
  }
  setSkills(skills: { name: string; description: string; appliesTo?: 'planner' | 'task' }[]): void {
    this.postMessage({ type: 'setSkills', skills });
  }
  /**
   * A session was loaded, or the webview reconnected: its plan, task output and
   * isolation state are dropped along with any stuck busy state, and the
   * conversation is rebuilt from what the session saved.
   */
  restoreChat(saved: SavedConversation): void {
    this.postMessage({ type: 'restoreChat' });
    this.conversation.reload(saved);
  }


  planApproved(): void { this.setState('approved'); }

  /** The run's own state after an Execute settled; `requestId` drops a reply for a session the webview has left. */
  showRunActivity(activity: RunActivity, requestId?: number): void {
    this.postMessage({ type: 'runActivity', activity, ...(requestId !== undefined ? { requestId } : {}) });
  }

  /** Answer one Runners pill request with what the shared list now holds for that runner. */
  acknowledgeRunnerChoice(requestId: string, runnerId: RunnerId, enabled: boolean): void {
    this.postMessage({ type: 'runnerChoiceSaved', requestId, runnerId, enabled });
  }

  /** Drop the handoff card and every per-task isolation indicator. */
  clearIsolationHandoff(): void {
    this.run.clearIsolation();
  }

  // Config pass-throughs — store locally and emit on request
  setModelsByRunner(modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>): void {
    this._modelsByRunner = modelsByRunner;
    this.postMessage({ type: 'setModelsByRunner', modelsByRunner });
  }
  setModelAllowlist(allowlist: Record<string, string[]>): void {
    this._modelAllowlist = allowlist;
    this.postMessage({ type: 'setModelAllowlist', allowlist });
  }
  setModesByRunner(modesByRunner: Record<string, RunnerModeMeta[]>, notice: { line: string; docs: string } | null = null): void {
    this._modesByRunner = modesByRunner;
    this._runnerNotice = notice;
    this.postMessage({ type: 'setModesByRunner', modesByRunner, notice });
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
  setModelOptions(options: ModelOption[]): void {
    this._modelOptions = options;
    this.postMessage({ type: 'setModelOptions', modelOptions: options });
  }
  sendConfiguredProviders(providers: ApiProvider[]): void {
    this._configuredProviders = providers;
    this.postMessage({ type: 'setConfiguredProviders', providers });
  }
  setModelDiscoveryErrors(errors: Record<string, string>): void {
    this._modelDiscoveryErrors = errors;
    this.postMessage({ type: 'setModelDiscoveryErrors', errors });
  }
  /** Every runner account's limits as the host's monitor last published them; kept to replay to a webview that loads later. */
  setAccountLimits(limits: readonly AccountLimitSnapshot[]): void {
    this._accountLimits = limits;
    this.postMessage({ type: 'accountLimits', limits });
  }
  /** The repositories and branches the startup view shows; `null` says the read is out. Not kept: a webview that connects asks the host for a current one. */
  setIsolationPreview(preview: IsolationPreview | null): void { this.postMessage({ type: 'isolationPreview', preview }); }
  /** Who can plan, who does plan, and that planner's effort — one message, so the webview never renders a half-switched planner. */
  setPlannerBackends(backends: PlannerBackend[], provider: string, runner?: string, effort?: string): void {
    this._plannerState = { backends, provider, runner, effort };
    this.postMessage({ type: 'setPlannerBackends', backends, provider, runner, effort });
  }

  private _modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  private _modelAllowlist: Record<string, string[]> | null = null;
  private _modesByRunner: Record<string, RunnerModeMeta[]> = {};
  private _runnerNotice: { line: string; docs: string } | null = null;
  /** The installed runners as discovery last listed them; null until it has, which the webview shows as detecting. */
  private _runnerList: { id: string; displayName: string }[] | null = null;
  private _enabledRunnerIds: string[] = [];
  private _modelConfig: { orchestrator: string; orchestratorProvider?: string } | null = null;
  private _modelOptions: ModelOption[] = [];
  private _configuredProviders: ApiProvider[] = [];
  private _modelDiscoveryErrors: Record<string, string> = {};
  private _plannerState: { backends: PlannerBackend[]; provider: string; runner?: string; effort?: string } | null = null;
  private _accountLimits: readonly AccountLimitSnapshot[] | null = null;

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
    if (Object.keys(this._modelDiscoveryErrors).length > 0) {
      this.postMessage({ type: 'setModelDiscoveryErrors', errors: this._modelDiscoveryErrors });
    }
    if (this._modesByRunner && Object.keys(this._modesByRunner).length > 0) {
      this.postMessage({ type: 'setModesByRunner', modesByRunner: this._modesByRunner, notice: this._runnerNotice });
    }
    if (this._modelAllowlist) {
      this.postMessage({ type: 'setModelAllowlist', allowlist: this._modelAllowlist });
    }
    if (this._modelConfig) {
      this.postMessage({ type: 'setModelConfig', modelConfig: this._modelConfig });
    }
    if (this._plannerState) {
      this.postMessage({ type: 'setPlannerBackends', ...this._plannerState });
    }
    if (this._accountLimits) {
      this.postMessage({ type: 'accountLimits', limits: this._accountLimits });
    }
    this._emitConsolidatedRunners();
  }

  private _emitConsolidatedRunners(): void {
    if (!this._runnerList) return;
    const enabledSet = new Set(this._enabledRunnerIds);
    const runners: RunnerMeta[] = this._runnerList.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      enabled: enabledSet.has(r.id),
    }));
    this.setRunners(runners);
  }


  private renderHtml(webviewView: vscode.WebviewView): void {
    webviewView.webview.html = renderWebviewHtml({
      webview: webviewView.webview,
      extensionUri: this._extensionUri,
      script: 'chat.js',
      title: 'Ordewell Chat',
    });
  }
}
