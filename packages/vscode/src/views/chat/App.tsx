import React, { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react';
import EmptyState from './components/EmptyState';
import GetStarted from './components/GetStarted';
import ChatInput from './components/ChatInput';
import DockResizeHandle from './components/DockResizeHandle';
import { ConversationBlocks } from './components/ChatMessage';
import { reduceHost, INITIAL_HOST_STATE, type HostState } from './hostState';
import ModelSelector, { API_PROVIDER_LABELS } from './components/ModelSelector';
import PlanCardGroup from './components/PlanCardGroup';
import UsageLine from './components/UsageLine';
import QueuedPrompts from './components/QueuedPrompts';
import HandoffCard from './components/HandoffCard';
import CheckpointPanel from './components/CheckpointPanel';
import type { TaskDraft } from './components/NewTaskCard';
import type { Task, TaskModelAssignment, RunnerId } from '@ordewell/core';
import { planSummaryLabel, nextDock } from './planDock';
import { DetailContext } from './detail';
import { useFollowOutput } from './followOutput';
import { slashHelp } from '../../commands/slashCommands';
import type { HostToWebview, PendingPlanEdit, WebviewToHost } from '../../shared/protocol';
import { hasHiddenDetail } from '@ordewell/core/plan-utils';
import { patchedBlocks } from '../../shared/conversationPatch';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const STOP_ARM_MS = 2_000;

type Updatable<T> = T | ((prev: T) => T);

export default function App() {
  const [host, dispatch] = useReducer(reduceHost, INITIAL_HOST_STATE);
  const {
    conversation, plan, isExecuting, isResearchActive, conversationBusy, error, models, modelsByRunner,
    runnerList, enabledRunnerIds, runners, pendingEdits, held, unsent, modesByRunner, modelConfig,
    modelOptions, configuredProviders, planner, isReady, modelDiscoveryErrors,
    skills, taskSkills, checkpoint, taskOutput, taskIdle, taskApprovals, taskIsolation, handoff,
    mergeResult, mergeGate, taskGates, dockExpanded, dockHeight,
  } = host;
  const setPlan = useCallback((v: Updatable<HostState['plan']>) => dispatch({ type: 'patchPlan', plan: v }), []);
  const setIsResearchActive = useCallback((v: boolean) => dispatch({ type: 'patchResearchActive', active: v }), []);
  const setIsExecuting = useCallback((v: boolean) => dispatch({ type: 'patchExecuting', executing: v }), []);
  const setError = useCallback((v: string) => dispatch({ type: 'patchError', error: v }), []);
  const setIsReady = useCallback((v: boolean) => dispatch({ type: 'patchReady', ready: v }), []);
  const setRunners = useCallback((v: Updatable<RunnerId[]>) => dispatch({ type: 'patchRunners', runners: v }), []);
  const setPendingEdits = useCallback((v: Updatable<PendingPlanEdit[]>) => dispatch({ type: 'patchPendingEdits', edits: v }), []);
  const setCheckpoint = useCallback((v: HostState['checkpoint']) => dispatch({ type: 'patchCheckpoint', checkpoint: v }), []);
  const setDockHeight = useCallback((v: number | undefined) => dispatch({ type: 'patchDockHeight', height: v }), []);
  const setDockExpanded = useCallback((v: Updatable<boolean>) => dispatch({ type: 'patchDockExpanded', expanded: v }), []);
  const blocks = useMemo(() => patchedBlocks(conversation), [conversation]);
  const [detailAll, setDetailAll] = useState(false);
  const detail = useMemo(() => ({ detailAll, setDetailAll }), [detailAll]);
  /** A first Esc during a planner turn: one more within `STOP_ARM_MS` stops it. */
  const [stopArmed, setStopArmed] = useState(false);
  const [showModelInfo, setShowModelInfo] = useState(false);
  const [slashOutput, setSlashOutput] = useState('');
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const dockBodyRef = useRef<HTMLDivElement>(null);
  const helpTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const processingRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const planRef = useRef(plan);
  planRef.current = plan;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const isGenerating = isResearchActive || isExecuting;

  useEffect(() => {
    processingRef.current = isResearchActive || isExecuting;
  }, [isResearchActive, isExecuting]);

  // Queued prompts and the working line are drawn below the conversation
  // blocks: each must be followed too, or it renders past the fold with
  // nothing to bring it into view.
  const followRef = useFollowOutput<HTMLDivElement>(blocks, held, isResearchActive);
  const messageListCallbackRef = useCallback((el: HTMLDivElement | null) => {
    messageListRef.current = el;
    followRef(el);
  }, [followRef]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      lastActivityRef.current = Date.now();
      dispatch({ ...event.data, now: Date.now() });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const fallback = setTimeout(() => setIsReady(true), 4000);
    return () => clearTimeout(fallback);
  }, []);

  const pushSystem = useCallback((text: string) => {
    vscode.postMessage({ type: 'addNote', text });
  }, []);

  // Watchdog: if the planner is "working" but nothing has arrived from the
  // host for a long stretch (a turn's end was lost, the turn died silently),
  // unlock the input instead of leaving the chat bricked. A harness planner
  // quiet on screen still sends liveness, so only real silence trips it; the
  // window is generous — non-streaming providers can legitimately stay quiet
  // for a minute while a model thinks.
  const WATCHDOG_MS = 120_000;
  useEffect(() => {
    if (!isResearchActive) return;
    lastActivityRef.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActivityRef.current < WATCHDOG_MS) return;
      setIsResearchActive(false);
      pushSystem('The planner stopped responding, so the input was re-enabled. Your last message may not have been processed — try sending it again.');
    }, 5_000);
    return () => clearInterval(timer);
  }, [isResearchActive, pushSystem]);

  const handleNewSession = useCallback(() => {
    dispatch({ type: 'resetSession', kind: 'new' });
    // A distinct message from stopResearch: /new resets the whole session,
    // while Stop only aborts the current planner turn.
    vscode.postMessage({ type: 'newSession' });
  }, []);

  const handleSend = useCallback((text: string) => {
    if (text.trim() === '/model') {
      setShowModelInfo((prev) => !prev);
      return;
    }
    if (text === '/new') {
      const hasContent = blocksRef.current.length > 0 || planRef.current !== null;
      if ((hasContent || processingRef.current) && !showNewSessionConfirm) {
        setShowNewSessionConfirm(true);
        return;
      }
      setShowNewSessionConfirm(false);
      handleNewSession();
      return;
    }
    if (text === '/help') {
      setSlashOutput(slashHelp());
      clearTimeout(helpTimerRef.current);
      helpTimerRef.current = setTimeout(() => setSlashOutput(''), 6000);
      return;
    }

    if (text.startsWith('/')) {
      vscode.postMessage({ type: 'sendMessage', text, runners, typed: true });
      return;
    }

    if (isResearchActive) {
      vscode.postMessage({ type: 'holdPrompt', text });
      return;
    }

    setShowModelInfo(false);
    setSlashOutput('');
    clearTimeout(helpTimerRef.current);
    setShowNewSessionConfirm(false);
    // Locked at once rather than when the turn opens: the host may take a
    // moment to start it, and a second send in between would race the first.
    dispatch({ type: 'turnRequested' });
    vscode.postMessage({ type: 'sendMessage', text, runners, typed: true });
  }, [runners, handleNewSession, showNewSessionConfirm, isResearchActive]);

  const handleToggleRunner = useCallback((runnerId: RunnerId) => {
    setRunners((prev) => {
      if (prev.includes(runnerId)) {
        const next = prev.filter((r) => r !== runnerId);
        return next.length > 0 ? next : prev;
      }
      return [...prev, runnerId];
    });
  }, []);

  const handleConfigureApiKey = useCallback((provider: 'openrouter' | 'google' | 'openai_compatible') => {
    vscode.postMessage({ type: 'sendMessage', text: `/key ${provider}`, runners });
  }, [runners]);

  const handleLoadSession = useCallback(() => {
    vscode.postMessage({ type: 'sendMessage', text: '/sessions', runners });
  }, [runners]);

  // A task card's own edit shows at once; the host's next plan settles it.
  const echoTask = useCallback((taskId: string, patch: Partial<Task>) => {
    const patchIn = (tasks: Task[]): Task[] => tasks.map((t) => {
      if (t.id === taskId) return { ...t, ...patch };
      return t.subtasks.length > 0 ? { ...t, subtasks: patchIn(t.subtasks) } : t;
    });
    setPlan((current) => (current ? { ...current, tasks: patchIn(current.tasks) } : current));
  }, []);

  const handlePromptChange = useCallback((taskId: string, prompt: string) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'prompt', prompt } });
    echoTask(taskId, { prompt, description: prompt });
  }, [echoTask]);

  // No optimistic removal: the host asks for confirmation, so the card must
  // survive a "Cancel" and only disappear when the host echoes the new plan.
  const handleRemoveTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'removeTask', taskId });
  }, []);

  // Not echoed either: the host validates the edit against the whole graph and
  // refuses some lists, so the checkboxes must show what was accepted.
  const handleDependenciesChange = useCallback((taskId: string, dependencies: string[]) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'dependencies', dependencies } });
  }, []);

  const handleAddTask = useCallback((draft: TaskDraft) => {
    vscode.postMessage({ type: 'addTask', draft });
  }, []);

  // Activation-time discovery can cache a degraded (empty) catalog for a runner
  // that was cold or unconfigured at that moment (see ModelDiscovery's
  // warnDegradedDiscovery). Unlike the TUI's task-model picker, which
  // re-fetches on every open, this webview only refreshes on activation, a
  // config change, or reconnect — so a stale empty list for an already-
  // assigned task's runner never self-heals on its own. Re-discover whenever a
  // task's model dropdown opens, same as the TUI does.
  const handleModelsRefreshNeeded = useCallback(() => {
    vscode.postMessage({ type: 'refreshModels' });
  }, []);

  const handleModelChange = useCallback((taskId: string, assignment: TaskModelAssignment) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'model', assignment } });
    echoTask(taskId, { assignedModel: assignment });
  }, [echoTask]);

  // Only the runner is echoed optimistically. The model, effort and mode that
  // follow from it come from the new runner's catalog, which only the host can
  // read — guessing them here would display an unspawnable assignment until the
  // retargeted plan arrives.
  const handleRunnerChange = useCallback((taskId: string, runner: string) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'runner', runner } });
    echoTask(taskId, { assignedRunner: runner });
  }, [echoTask]);

  const handleModeChange = useCallback((taskId: string, mode: string) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'mode', mode } });
    echoTask(taskId, { taskMode: mode });
  }, [echoTask]);

  const handleSkillsChange = useCallback((taskId: string, skills: string[]) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'skills', skills } });
    echoTask(taskId, { skills: skills.length > 0 ? skills : undefined });
  }, [echoTask]);

  const handleOpsChange = useCallback((taskId: string, ops: boolean) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'ops', ops } });
    echoTask(taskId, { ops });
  }, [echoTask]);

  const handleRetry = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'retry', taskId });
  }, []);

  const handleSkip = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'skip', taskId });
    pushSystem(`Task "${taskTitle}" skipped.`);
  }, [pushSystem]);

  const handleCancel = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'cancel', taskId });
    pushSystem(`Task "${taskTitle}" cancelled.`);
  }, [pushSystem]);

  // No notice of its own: the task's start comes back from the session and
  // is announced by the host, as every start is.
  const handleForceStart = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'forceStart', taskId });
  }, []);

  const handleExecutePlan = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'executePlan' });
    pushSystem('Plan execution started.');
  }, [pushSystem]);

  const handleStopExecution = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
    pushSystem('Execution stopped.');
  }, [pushSystem]);

  const handleRunTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'runTask', taskId });
  }, []);

  // The log tab is the host's webview panel (ADR-0018, V1); the chat only asks
  // for it. Opening is idempotent host-side — an open tab is focused.
  const handleOpenTaskLog = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'openTaskLog', taskId });
  }, []);

  const handleMarkComplete = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'markComplete', taskId });
    pushSystem(`Task "${taskTitle}" marked complete.`);
  }, [pushSystem]);

  const handleMarkIncomplete = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'markIncomplete', taskId });
    pushSystem(`Task "${taskTitle}" marked not done.`);
  }, [pushSystem]);

  // The card answers into the same resolution every surface uses; the outcome
  // comes back as `approval_settled` and redraws the card.
  const handleResolveApproval = useCallback((id: string, granted: boolean) => {
    vscode.postMessage({ type: 'resolveApproval', id, granted });
  }, []);

  // The host owns the edits; withdrawing removes one here at once so the click
  // feels immediate, and the host's own pendingPlanEdits settles the list.
  const handleRemovePendingEdit = useCallback((id: string) => {
    setPendingEdits((prev) => prev.filter((m) => m.id !== id));
    vscode.postMessage({ type: 'removePendingPlanEdit', id });
  }, []);

  const handleUnsend = useCallback(() => {
    vscode.postMessage({ type: 'unsendPrompt' });
  }, []);

  const stopTurn = useCallback(() => {
    dispatch({ type: 'turnStopped' });
    vscode.postMessage({ type: 'stopResearch' });
  }, []);

  // Stopping a run is not stopping a turn: the stale-plan gate is the turn's,
  // and armed here it dropped every plan update after the run's stop.
  const handleStop = useCallback(() => {
    if (!isExecuting) {
      stopTurn();
      return;
    }
    setIsExecuting(false);
    vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
    pushSystem('Execution stopped.');
  }, [isExecuting, pushSystem, stopTurn]);

  // Esc during a planner turn, in order of intent: take back the newest queued
  // prompt, else arm a stop, else commit it. Outside a turn it is the input's.
  // The stop is the turn's even mid-run: Esc Esc never halts the tasks.
  const handleEscape = useCallback((): boolean => {
    if (!isResearchActive) return false;
    if (held.length > 0) {
      setStopArmed(false);
      handleUnsend();
    } else if (stopArmed) {
      setStopArmed(false);
      stopTurn();
    } else {
      setStopArmed(true);
    }
    return true;
  }, [isResearchActive, held, stopArmed, handleUnsend, stopTurn]);

  // The pairing is what keeps a stray tap from cancelling a turn, so an arm
  // lapses on its own, and never outlives the turn it was aimed at.
  useEffect(() => {
    if (!stopArmed) return;
    if (!isResearchActive) {
      setStopArmed(false);
      return;
    }
    const timer = setTimeout(() => setStopArmed(false), STOP_ARM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed, isResearchActive]);

  const handleApproveCheckpoint = useCallback(() => {
    if (!checkpoint) return;
    vscode.postMessage({ type: 'answerCheckpoint', taskId: checkpoint.taskId, approved: true });
    setCheckpoint(null);
  }, [checkpoint]);

  const handleRejectCheckpoint = useCallback((reason: string) => {
    if (!checkpoint) return;
    // Reject resumes the paused agent with the reason (rather than cancelling
    // the task), and the panel is torn down immediately — leaving a decision
    // box on screen after the decision is made asks the user to answer twice.
    vscode.postMessage({ type: 'answerCheckpoint', taskId: checkpoint.taskId, approved: false, reason });
    setCheckpoint(null);
  }, [checkpoint]);

  const handleMergeTasks = useCallback((taskIds: string[]) => {
    const current = planRef.current;
    if (!current) return;
    const titles = taskIds.map((id) => current.tasks.find((t) => t.id === id)?.title ?? id);
    pushSystem(`Requesting merge of: ${titles.join(' + ')}.`);
    vscode.postMessage({ type: 'mergeTasks', taskIds });
  }, [pushSystem]);

  const handleSplitTask = useCallback((taskId: string) => {
    const current = planRef.current;
    if (!current) return;
    const task = current.tasks.find((t) => t.id === taskId);
    pushSystem(`Requesting split of: ${task?.title ?? taskId}.`);
    vscode.postMessage({ type: 'splitTask', taskId });
  }, [pushSystem]);

  // The host owns every isolation action: opening the diff, and the merge,
  // discard and cleanup that touch the user's real branches.
  const handleIsolationAction = useCallback((action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict', taskId?: string) => {
    vscode.postMessage({ type: 'isolationAction', action, taskId });
  }, []);

  const handleDockResize = useCallback((height: number) => {
    setDockHeight(height);
    vscode.postMessage({ type: 'setPlanDockHeight', height });
  }, []);
  const handleShowPlan = useCallback(() => setDockExpanded((v) => nextDock(v, 'user-expanded')), []);

  const handleResolveConflict = useCallback((taskId: string) => {
    handleIsolationAction('resolveConflict', taskId);
  }, [handleIsolationAction]);

  const getPlaceholder = (): string => {
    if (isResearchActive) return 'Queue a message for when the planner is done...';
    if (isExecuting) return 'AI is working...';
    if (plan && plan.tasks.length > 0) return 'Modify the plan...';
    if (blocks.some((b) => b.type === 'message' && b.role === 'planner')) return 'Reply to the planner...';
    return 'Describe what you want to build...';
  };

  const vendorModels = useMemo<DiscoveredModel[]>(() =>
    // Carry the serving apiProvider through as runnerProvider (grouping key)
    // plus its display label, so the dropdown groups and labels each model by
    // its real provider (OpenAI, OpenRouter, Gemini, …) instead of guessing
    // from the id prefix.
    modelOptions.map((opt) => ({
      modelId: opt.id,
      modelLabel: opt.label,
      runnerProvider: opt.apiProvider,
      runnerProviderLabel: opt.apiProvider ? API_PROVIDER_LABELS[opt.apiProvider] : undefined,
      variants: [],
    })),
    [modelOptions],
  );

  /**
   * A harness planner runs a coding agent, so the only models it can serve are
   * that agent's own — and those carry the variants that make the effort
   * dropdown appear (ADR-0009). Offering it the vendor catalog would list
   * models it cannot run.
   */
  const orchestratorModels = useMemo<DiscoveredModel[]>(
    () => (planner.runner ? modelsByRunner[planner.runner as RunnerId] ?? [] : vendorModels),
    [planner.runner, modelsByRunner, vendorModels],
  );

  const harnessPlannerModels = useMemo(
    () => (planner.runner
      ? orchestratorModels.map((m) => ({ id: m.modelId, label: m.modelLabel, provider: planner.runner as string }))
      : undefined),
    [planner.runner, orchestratorModels],
  );

  const orchestratorModelApiMapping = useMemo<Record<string, AiProvider[]>>(() => {
    const mapping: Record<string, AiProvider[]> = {};
    for (const opt of modelOptions) {
      mapping[opt.id] = opt.apiProvider ? [opt.apiProvider] : [];
    }
    return mapping;
  }, [modelOptions]);

  const orchestratorCurrentModel = useMemo<TaskModelAssignment | undefined>(() => {
    if (!modelConfig?.orchestrator) return undefined;
    const discovered = orchestratorModels.find((m) => m.modelId === modelConfig.orchestrator);
    return {
      modelId: modelConfig.orchestrator,
      modelLabel: discovered?.modelLabel ?? modelConfig.orchestrator,
      thinkingEffort: planner.effort as TaskModelAssignment['thinkingEffort'],
    };
  }, [modelConfig, orchestratorModels, planner.effort]);

  const handleOrchestratorModelChange = useCallback((assignment: TaskModelAssignment) => {
    vscode.postMessage({ type: 'setPlannerModel', modelId: assignment.modelId, effort: assignment.thinkingEffort });
  }, []);

  const handlePlannerChange = useCallback((provider: string) => {
    if (provider === planner.provider) return;
    vscode.postMessage({ type: 'setPlanner', provider });
  }, [planner.provider]);

  const displayRunners = runnerList.length > 0
    ? runnerList
    : [
        { id: 'claude-code', displayName: 'Claude Code' },
        { id: 'codex', displayName: 'Codex' },
        { id: 'opencode', displayName: 'OpenCode' },
      ];

  const visibleRunners = displayRunners.filter((r) => enabledRunnerIds.includes(r.id));

  // An API key is one of two ways in (ADR-0009): an installed coding agent
  // plans on its own subscription, so key-less is a working setup, not a
  // first-run wall.
  const canPlan = configuredProviders.length > 0 || planner.backends.some((b) => b.usable);

  const plannerIsHarness = planner.backends.find((b) => b.id === planner.provider)?.kind === 'harness';

  const runnerLabelMap = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of displayRunners) m[r.id] = r.displayName;
    return m;
  }, [displayRunners]);

  const runningCount = useMemo(() =>
    plan?.tasks.filter((t) => t.status === 'in_progress').length ?? 0,
    [plan],
  );

  const doneCount = useMemo(() =>
    plan?.tasks.filter((t) => t.status === 'completed').length ?? 0,
    [plan],
  );

  const pendingEditCount = pendingEdits.length;

  const hasContent = blocks.length > 0 || isResearchActive || isExecuting || !!error;
  const streaming = blocks.some((b) => (b.type === 'message' || b.type === 'thinking') && b.streaming);
  /** The one usage block, drawn pinned below the conversation rather than scrolling in it. */
  const usageBlock = useMemo(() => blocks.find((b) => b.type === 'usage'), [blocks]);
  const hasDetail = useMemo(() => hasHiddenDetail(blocks), [blocks]);

  /**
   * The plan, mounted once. Not a timeline entry: it is the live control surface
   * (status, streaming output, checkpoint approval, Execute/Stop), and a control
   * surface pinned at a historical scroll position is one the user cannot find
   * when it changes. The chat carries a chip per revision instead.
   *
   * The inner markup is deliberately unchanged from when this lived in a chat
   * bubble — `.plan-dock-body` is added to the bubble's own CSS rules rather than
   * restyled, so the task-card arrangement is pixel-identical.
   */
  const renderPlanDock = () => {
    if (!plan || plan.tasks.length === 0) return null;
    return (
      <div className={`plan-dock ${dockExpanded ? 'expanded' : 'collapsed'}`}>
        {dockExpanded && <DockResizeHandle bodyRef={dockBodyRef} listRef={messageListRef} onCommit={handleDockResize} />}
        <button
          type="button"
          className="plan-dock-bar"
          onClick={() => setDockExpanded((v) => nextDock(v, v ? 'user-collapsed' : 'user-expanded'))}
          title={dockExpanded ? 'Collapse the plan' : 'Expand the plan'}
        >
          <span className={`plan-dock-chevron${dockExpanded ? '' : ' collapsed'}`}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="plan-dock-title">Plan</span>
          <span className="plan-dock-summary">{planSummaryLabel(plan.tasks)}</span>
          {/* A collapse is always honoured, including mid-run — so the bar has to
              say when a task is blocked on the user, or the approval would sit
              unseen behind it. */}
          {checkpoint && <span className="plan-dock-approval">1 awaiting approval</span>}
        </button>
        <div
          className="plan-dock-body"
          hidden={!dockExpanded}
          ref={dockBodyRef}
          style={dockHeight === undefined ? undefined : { maxHeight: dockHeight }}
        >
          {checkpoint && (
            <CheckpointPanel
              taskTitle={checkpoint.taskTitle}
              summary={checkpoint.summary}
              pausedAt={checkpoint.pausedAt}
              onApprove={handleApproveCheckpoint}
              onReject={handleRejectCheckpoint}
            />
          )}
          <PlanCardGroup
            tasks={plan.tasks}
            models={models}
            modelsByRunner={modelsByRunner}
            modesByRunner={modesByRunner}
            isExecuting={isExecuting}
            taskOutput={taskOutput}
            taskIdle={taskIdle}
            taskApprovals={taskApprovals}
            runnerLabels={runnerLabelMap}
            runners={runnerList}
            onRunnerChange={handleRunnerChange}
            onDependenciesChange={handleDependenciesChange}
            onAddTask={handleAddTask}
            onModelChange={handleModelChange}
            onModelsRefreshNeeded={handleModelsRefreshNeeded}
            onModeChange={handleModeChange}
            onOpsChange={handleOpsChange}
            taskSkills={taskSkills}
            onSkillsChange={handleSkillsChange}
            mergeGates={taskGates}
            onRemoveTask={handleRemoveTask}
            onPromptChange={handlePromptChange}
            onRetry={handleRetry}
            onSkip={handleSkip}
            onCancel={handleCancel}
            onForceStart={handleForceStart}
            onMarkComplete={handleMarkComplete}
            onMarkIncomplete={handleMarkIncomplete}
            onMerge={handleMergeTasks}
            onSplit={handleSplitTask}
            onExecutePlan={handleExecutePlan}
            onStopExecution={handleStopExecution}
            onRunTask={handleRunTask}
            isolationByTask={taskIsolation}
            onResolveConflict={handleResolveConflict}
            onOpenLog={handleOpenTaskLog}
          />
          {handoff && !mergeGate && (
            <HandoffCard
              repos={handoff.repos}
              landed={handoff.landed}
              mergeResult={mergeResult}
              onAction={(action) => handleIsolationAction(action)}
            />
          )}
          {mergeGate && (
            <HandoffCard
              repos={mergeGate.repos}
              landed={mergeGate.landed}
              mergeResult={mergeResult}
              midRun={{ paused: mergeGate.paused }}
              onAction={(action) => handleIsolationAction(action)}
            />
          )}
          {isExecuting && (
            <div className="executing-footer">
              <div className="queue-badge done-counter">
                <span className="done-counter-check">✓</span> {doneCount}/{plan.tasks.length} done
              </div>
              {runningCount > 0 && (
                <div className="queue-badge executing">
                  <span className="queue-dot running" /> {runningCount} running
                </div>
              )}
              {pendingEditCount > 0 && (
                <div className="queue-badge">
                  <span className="queue-dot" /> {pendingEditCount} plan edit{pendingEditCount > 1 ? 's' : ''} pending
                </div>
              )}
              <div className="executing-status">Tasks active &mdash; plan edits apply between batches</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <DetailContext.Provider value={detail}>
    <div className="chat-container">
      <div className="setup-panel">
        <button
          type="button"
          className="setup-panel-toggle"
          onClick={() => setSetupCollapsed((v) => !v)}
          title={setupCollapsed ? 'Expand settings' : 'Collapse settings'}
        >
          <span className="setup-panel-toggle-row">
            <span className="setup-panel-toggle-label">Settings</span>
            <span className={`setup-panel-chevron${setupCollapsed ? ' collapsed' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
          {setupCollapsed && (
            <span className="setup-panel-summary">
              {planner.backends.find((b) => b.id === planner.provider)?.label || 'No planner'}
              {' · '}
              {runners.length} runner{runners.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <div className={`setup-panel-body${setupCollapsed ? ' collapsed' : ''}`}>
        {planner.backends.length > 0 && (
          <section className="setup-block">
            <div className="setup-block-title">Planner</div>
            <div className="setup-block-hint">
              Researches your codebase and writes the plan. A coding agent plans on its own
              subscription — no API key needed.
            </div>
            <div className="planner-backends">
              {planner.backends.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`planner-pill ${b.id === planner.provider ? 'active' : ''} ${b.usable ? '' : 'unusable'}`}
                  disabled={!b.usable}
                  title={b.reason}
                  onClick={() => handlePlannerChange(b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
            {/* A harness planner has no API provider to filter by, and its models
                are never in the vendor mapping — passing either would empty the
                list behind a pill bar that cannot apply to it. */}
            <ModelSelector
              models={orchestratorModels}
              currentModel={orchestratorCurrentModel}
              configuredProviders={planner.runner ? [] : configuredProviders}
              modelApiMapping={planner.runner ? {} : orchestratorModelApiMapping}
              onChange={handleOrchestratorModelChange}
              label={planner.runner ? 'Model & thinking effort' : 'Model'}
            />
            {orchestratorModels.length === 0 && (
              <div className="model-discovery-error" role="alert">
                {planner.runner
                  ? <>No models discovered for this agent yet — run <code>/refresh</code>.</>
                  : <>No models available — add an API key with <code>/key set</code>, or pick a coding agent above.</>}
              </div>
            )}
            {Object.keys(modelDiscoveryErrors).length > 0 && !planner.runner && (
              <div className="model-discovery-error" role="alert">
                ⚠ Couldn't load models for{' '}
                {Object.entries(modelDiscoveryErrors)
                  .map(([p, msg]) => `${API_PROVIDER_LABELS[p as keyof typeof API_PROVIDER_LABELS] ?? p} (${msg})`)
                  .join('; ')}
                . Check the API key / base URL — those models are omitted.
              </div>
            )}
          </section>
        )}

        <section className="setup-block">
          <div className="setup-block-title">Runners</div>
          <div className="setup-block-hint">
            Coding agents that execute the plan's tasks. Toggle which ones the planner may assign.
          </div>
          <div className="runner-pills">
            {visibleRunners.map((r) => {
              const isToggled = runners.includes(r.id);
              return (
                <button key={r.id} className={`runner-pill ${isToggled ? 'on' : 'off'}`}
                  onClick={() => handleToggleRunner(r.id)}
                  title={`${isToggled ? 'Stop assigning' : 'Assign'} tasks to ${r.displayName}`}>
                  <span className="runner-dot" /> {r.displayName}
                </button>
              );
            })}
            {visibleRunners.length === 0 && (
              <span className="setup-block-empty">
                No coding agent detected — install Claude Code, Codex or OpenCode, then run <code>/refresh</code>.
              </span>
            )}
          </div>
        </section>
        </div>
      </div>

      {hasDetail && (
        <div className="chat-header">
          <button
            type="button"
            className="detail-toggle"
            aria-pressed={detailAll}
            onClick={() => setDetailAll((v) => !v)}
            title="Show or hide the full thinking, command and subagent detail for the whole conversation"
          >
            {detailAll ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      {showModelInfo && (
        <div className="model-info-panel">
          <div className="model-info-title">Model Configuration</div>
          {/* Only a vendor planner is blocked by an unset model. A harness
              planner falls back to the coding agent's own default, so the same
              state is a working setup there — not a warning. */}
          {!modelConfig?.orchestrator && (
            plannerIsHarness ? (
              <div className="model-info-row">
                <span className="model-info-key">Model</span>
                <span className="model-info-val"><em>the agent's default</em></span>
              </div>
            ) : (
              <div className="model-info-warning">
                No orchestrator model selected. Type <code>/model set</code> to pick one, or plans cannot be generated.
              </div>
            )
          )}
          <div className="model-info-row">
            <span className="model-info-key">Orchestrator</span>
            <span className="model-info-val">{modelConfig?.orchestrator || <em>not set</em>}</span>
            {modelConfig?.orchestratorProvider && <span className="model-info-provider">via {modelConfig.orchestratorProvider}</span>}
          </div>
          <div className="model-info-footer">/model set to change · /key set to set an API key · /model to close</div>
        </div>
      )}

      {slashOutput && (
        <div className="slash-output">{slashOutput}</div>
      )}

      {showNewSessionConfirm && (
        <div className="new-session-confirm">
          <div className="new-session-confirm-text">
            Start a new session? Current plan generation will be stopped.
          </div>
          <div className="new-session-confirm-actions">
            <button className="btn-accept" onClick={() => {
              setShowNewSessionConfirm(false);
              handleNewSession();
            }}>New Session</button>
            <button className="btn-reject" onClick={() => setShowNewSessionConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="message-list" ref={messageListCallbackRef}>
        {!hasContent && !isReady && (
          <div className="loading-state">
            <div className="loading-pulse" />
            <p>Loading…</p>
          </div>
        )}

        {!hasContent && isReady && !canPlan && (
          <GetStarted onConfigure={handleConfigureApiKey} />
        )}

        {!hasContent && isReady && canPlan && (
          <EmptyState onLoadSession={handleLoadSession} />
        )}

        {error && (
          <div className="error-state">
            <div className="error-icon">!</div>
            <p className="error-message">{error}</p>
            <button onClick={() => setError('')}>Try Again</button>
          </div>
        )}

        <ConversationBlocks
          blocks={blocks}
          detailAll={detailAll}
          onShowPlan={handleShowPlan}
          onResolveApproval={handleResolveApproval}
        />

        <QueuedPrompts prompts={held} onUnsend={handleUnsend} />

        {isResearchActive && !streaming && (
          <div className="chat-msg-working">
            <span className="chat-msg-spinner" /> Working&hellip;
          </div>
        )}
      </div>

      {renderPlanDock()}

      {usageBlock && <UsageLine block={usageBlock} />}

      {stopArmed && <div className="stop-hint" role="status">Press Esc again to stop</div>}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onEscape={handleEscape}
        disabled={conversationBusy}
        disabledReason={conversationBusy ? 'Compacting the conversation...' : undefined}
        placeholder={getPlaceholder()}
        modelOptions={modelOptions}
        harnessPlannerModels={harnessPlannerModels}
        configuredProviders={configuredProviders}
        isProcessing={isGenerating}
        pendingEdits={pendingEdits}
        onRemovePendingEdit={handleRemovePendingEdit}
        unsent={unsent}
        skills={skills}
      />
    </div>
    </DetailContext.Provider>
  );
}
