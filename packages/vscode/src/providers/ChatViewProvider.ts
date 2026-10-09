import * as vscode from 'vscode';
import type { AiProvider, LegacyPlanState, DiscoveredModel, RunnerId, TaskIsolation, IsolationHandoff, IsolationMergeResult, MergeGateView, RunnerTransport } from '@ordewell/core';
import { ConversationViewHost, type SavedConversation } from '../ConversationViewHost';
import { renderWebviewHtml } from './webviewHtml';
import type { ChatState, HostToWebview, ModelOption, PendingPlanEdit, PlannerBackend, RunnerMeta, RunnerModeMeta, WebviewToHost } from '../shared/protocol';

export type { PlannerBackend, RunnerMeta } from '../shared/protocol';

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
  sendPlanUpdated(plan: LegacyPlanState): void { this._cachedPlan = plan; this.postMessage({ type: 'planUpdated', plan }); }
  /** Every plan edit waiting at the next batch boundary, so the chat can list (and withdraw) each one. */
  showPendingPlanEdits(edits: PendingPlanEdit[]): void { this.postMessage({ type: 'pendingPlanEdits', edits }); }
  /** Live runner output for one task; the webview keeps the tail and renders it in that task's card. */
  sendTaskOutput(taskId: string, text: string): void { this.postMessage({ type: 'taskOutput', taskId, text }); }
  /** Advisory silence timestamp for one task; null clears the stalled indicator. */
  sendTaskIdle(taskId: string, idleSince: string | null): void { this.postMessage({ type: 'taskIdle', taskId, idleSince }); }
  /** Runner requests one task waits on (ADR-0018, A1); 0 clears the card's badge. */
  sendTaskApprovals(taskId: string, count: number): void { this.postMessage({ type: 'taskApprovals', taskId, count }); }
  setModels(models: DiscoveredModel[]): void {
    this.postMessage({ type: 'setModels', models });
  }
  setRunners(runners: RunnerMeta[]): void { this.postMessage({ type: 'setRunners', runners }); }
  setSkillToggles(verify: boolean, unavailable: string[] = []): void {
    this.postMessage({ type: 'setSkillToggles', toggles: { verify }, unavailable });
  }
  setRunnerTransport(transport: RunnerTransport): void {
    this.postMessage({ type: 'runnerTransport', transport });
  }
  setPlanDockHeight(height: number | undefined): void {
    this.postMessage({ type: 'planDockHeight', height });
  }
  setSkills(skills: { name: string; description: string }[]): void {
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

  /**
   * Redraw only the conversation, after a compaction edited it. Unlike
   * `restoreChat` this leaves the plan, task output and isolation state alone,
   * because a compaction is allowed while a run is executing.
   */
  replaceConversation(saved: SavedConversation): void {
    this.conversation.reload(saved);
  }
  /** Lock the input while core is refusing planner messages (a compaction in flight). */
  setConversationBusy(busy: boolean): void {
    this.postMessage({ type: 'conversationBusy', busy });
  }

  showPlan(plan: LegacyPlanState): void { this.sendPlanUpdated(plan); }

  // Legacy pass-throughs forwarding to new protocol types
  planGenerated(plan: LegacyPlanState): void { this.sendPlanUpdated(plan); }
  planApproved(): void { this.setState('approved'); }
  showCheckpoint(taskId: string, taskTitle: string, summary: string): void {
    this.postMessage({ type: 'checkpoint', taskId, taskTitle, summary });
  }

  /** Where one task's isolated work stands — conflict indicator, branch and worktree. */
  sendTaskIsolation(taskId: string, isolation: TaskIsolation): void {
    this.postMessage({ type: 'taskIsolation', taskId, isolation });
  }

  /** The end-of-run handoff card: each repo's branch and base ref, and what landed. */
  showIsolationHandoff(handoff: IsolationHandoff): void {
    this.postMessage({ type: 'isolationHandoff', ...handoff });
  }

  /** What "Merge all" did, so a blocked or part-landed group is visible on the card. */
  showIsolationMergeResult(result: IsolationMergeResult): void {
    this.postMessage({ type: 'isolationMergeResult', result });
  }

  /** Which tasks wait at a merge gate, and what Merge all would merge mid-run (ADR-0020). */
  showMergeGate(gate: MergeGateView | null, tasks: Record<string, string[]>): void {
    this.postMessage({ type: 'mergeGate', gate, tasks });
  }

  /** Drop the handoff card and every per-task isolation indicator. */
  clearIsolationHandoff(): void {
    this.postMessage({ type: 'isolationCleared' });
  }

  // Config pass-throughs — store locally and emit on request
  setModelsByRunner(modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>): void {
    this._modelsByRunner = modelsByRunner;
    this.postMessage({ type: 'setModelsByRunner', modelsByRunner });
  }
  setModesByRunner(modesByRunner: Record<string, RunnerModeMeta[]>): void {
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
  /** Who can plan, who does plan, and that planner's effort — one message, so the webview never renders a half-switched planner. */
  setPlannerBackends(backends: PlannerBackend[], provider: string, runner?: string, effort?: string): void {
    this._plannerState = { backends, provider, runner, effort };
    this.postMessage({ type: 'setPlannerBackends', backends, provider, runner, effort });
  }

  private _modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  private _modesByRunner: Record<string, RunnerModeMeta[]> = {};
  private _runnerList: { id: string; displayName: string }[] = [];
  private _enabledRunnerIds: string[] = [];
  private _modelConfig: { orchestrator: string; orchestratorProvider?: string } | null = null;
  private _modelOptions: ModelOption[] = [];
  private _configuredProviders: ApiProvider[] = [];
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


  private renderHtml(webviewView: vscode.WebviewView): void {
    webviewView.webview.html = renderWebviewHtml({
      webview: webviewView.webview,
      extensionUri: this._extensionUri,
      script: 'chat.js',
      title: 'Ordewell Chat',
    });
  }
}
