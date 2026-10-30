import { TaskCommandsBridge } from './components/RunnerCommands';
import React, { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react';
import EmptyState, { type SignedOutPlannerRow } from './components/EmptyState';
import PlannerLoginAction from './components/PlannerLogin';
import GetStarted from './components/GetStarted';
import { orNames } from './runnerNames';
import ChatInput from './components/ChatInput';
import ElapsedTime from './components/ElapsedTime';
import PlannerResendBar from './components/PlannerResendBar';
import PlannerPauseBar from './components/PlannerPauseBar';
import DockResizeHandle from './components/DockResizeHandle';
import { ConversationBlocks } from './components/ChatMessage';
import { reduceHost, runnersOn, INITIAL_HOST_STATE, type HostState } from './hostState';
import ModelSelector, { API_PROVIDER_LABELS } from './components/ModelSelector';
import PlanCardGroup from './components/PlanCardGroup';
import UsageLine from './components/UsageLine';
import PendingMessages, { type PendingMessage } from './components/PendingMessages';
import HandoffCard from './components/HandoffCard';
import CheckpointPanel from './components/CheckpointPanel';
import RunSettingsBlock from './components/RunSettingsBlock';
import type { TaskDraft } from './components/NewTaskCard';
import type { CompactionBlock, GlobalRunSettings, RunSettings, Task, TaskModelAssignment, RunnerId, RunnerAuth } from '@ordewell/core';
import { accountLimitsOf, compactionText, SUPERVISOR_LEVEL_LABEL } from '@ordewell/core/plan-utils';
import { planSummaryLabel, nextDock } from './planDock';
import { OpenPatchContext } from './openPatch';
import { useFollowOutput } from './followOutput';
import { isBuiltinSlashCommand, slashHelp } from '../../commands/slashCommands';
import type { HostToWebview, SettingsChange, WebviewToHost } from '../../shared/protocol';
import { patchedBlocks } from '../../shared/conversationPatch';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const postTaskCommand = (message: WebviewToHost): void => vscode.postMessage(message);

const STOP_ARM_MS = 2_000;

type Updatable<T> = T | ((prev: T) => T);

/** The dock's word on the supervisor, when there is one to speak of. */
/**
 * The run settings on the plan bar (ADR-0030): the user's level, and during a
 * run the run's own where a guard, a failure or another window left it
 * different.
 */
function runSettingsSummary(run: GlobalRunSettings | undefined, runSettings: RunSettings | undefined, isExecuting: boolean): React.ReactNode {
  if (!run) return null;
  const level = SUPERVISOR_LEVEL_LABEL[run.supervisorLevel];
  const actual = !isExecuting || !runSettings ? null
    : runSettings.unsupervised ? 'unsupervised'
    : (runSettings.supervisorLevel ?? 'off') !== run.supervisorLevel ? SUPERVISOR_LEVEL_LABEL[runSettings.supervisorLevel ?? 'off'] : null;
  return (
    <>
      <span className={`plan-dock-summary plan-supervisor${actual === 'unsupervised' ? ' plan-supervisor-stopped' : ''}`}>
        Supervisor: {level}{actual && ` → ${actual}`}
      </span>
      {run.mergeAtGatesAutomatically && <span className="plan-dock-summary">Merge automatically</span>}
      {run.autorun && <span className="plan-dock-summary">Autorun</span>}
    </>
  );
}

const DETECTING = 'Detecting coding agents…';

export default function App() {
  const [host, dispatch] = useReducer(reduceHost, INITIAL_HOST_STATE);
  const {
    conversation, plan, isExecuting, isResearchActive, error, models, modelsByRunner,
    runnerList, enabledRunnerIds, pendingRunners, modelAllowlist, held, unsent, modesByRunner, runnerNotice, modelConfig,
    modelOptions, configuredProviders, planner, plannerKnown, runnersKnown, isReady, modelDiscoveryErrors,
    skills, taskSkills, checkpoint, taskOutput, run, activity, starting, dockExpanded, dockHeight, settingsRequest, accountLimits, plannerTurnStartedAt,
  } = host;
  const setPlan = useCallback((v: Updatable<HostState['plan']>) => dispatch({ type: 'patchPlan', plan: v }), []);
  const setError = useCallback((v: string) => dispatch({ type: 'patchError', error: v }), []);
  const setIsReady = useCallback((v: boolean) => dispatch({ type: 'patchReady', ready: v }), []);
  const setDockHeight = useCallback((v: number | undefined) => dispatch({ type: 'patchDockHeight', height: v }), []);
  const setDockExpanded = useCallback((v: Updatable<boolean>) => dispatch({ type: 'patchDockExpanded', expanded: v }), []);
  const blocks = useMemo(() => patchedBlocks(conversation), [conversation]);
  const runners = useMemo(
    () => runnersOn({ runnerList, enabledRunnerIds, pendingRunners }),
    [runnerList, enabledRunnerIds, pendingRunners],
  );
  // The planner compacting holds the conversation as a turn does: Stop stops
  // it, a message waits for it, and the draft stays. Read from the blocks, so
  // a webview that reconnects mid-compaction knows it from what it is sent.
  const compaction = useMemo(() => [...blocks].reverse().find((b): b is CompactionBlock => b.type === 'compaction' && b.origin !== undefined), [blocks]);
  const compacting = compaction?.status === 'running';
  const plannerBusy = isResearchActive || compacting;
  // An API key is one of two ways in (ADR-0009): an installed coding agent
  // plans on its own subscription, so key-less is a working setup, not a
  // first-run wall.
  const canPlan = configuredProviders.length > 0 || planner.backends.some((b) => b.usable);
  const hasContent = blocks.length > 0 || isResearchActive || isExecuting || !!error;
  /** The first screen is on show, with every signed-out agent's own row. */
  const emptyStateShown = !hasContent && isReady && canPlan;
  // Told as news only for a compaction this view saw run: one restored with
  // the transcript is history, already drawn where it happened.
  const seenRunning = useRef(new Set<string>());
  if (compaction && compacting) seenRunning.current.add(compaction.id);
  const compactionNews = compaction && seenRunning.current.has(compaction.id) ? compactionText(compaction) : '';
  /** A first Esc during a planner turn: one more within `STOP_ARM_MS` stops it. */
  const [stopArmed, setStopArmed] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [slashOutput, setSlashOutput] = useState('');
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [runExpanded, setRunExpanded] = useState(false);
  /** The coding agent whose login is running, by runner id: each action waits on its own. */
  const [pendingLogin, setPendingLogin] = useState<Record<string, true>>({});
  /** Each login that did not finish and why, by runner id: shown inline on the row or pill that asked. */
  const [loginFailure, setLoginFailure] = useState<Record<string, string>>({});

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const dockBodyRef = useRef<HTMLDivElement>(null);
  const runSettingsRef = useRef<HTMLElement>(null);
  const helpTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const processingRef = useRef(false);
  /** A start is with the host; a second click is the same start, not another. */
  const startPendingRef = useRef(false);
  const nextStartRequest = useRef(0);
  // Prefixed per page: a reload starts the count again, and an answer still
  // on its way to the old page must not match a click on the new one.
  const runnerRequestPrefix = useRef(Math.random().toString(36).slice(2));
  const nextRunnerRequest = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const planRef = useRef(plan);
  planRef.current = plan;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  useEffect(() => {
    processingRef.current = isResearchActive || isExecuting;
  }, [isResearchActive, isExecuting]);

  // What the plan's start control shows: a click's own request, or the run's
  // authoritative admission, until the first attempt makes it a run.
  const isStarting = !isExecuting && (starting || activity.starting);
  useEffect(() => {
    startPendingRef.current = isStarting;
  }, [isStarting]);

  // The pinned working line and the stack of queued prompts above the
  // composer take height from the list: each must be followed too, or the
  // newest output ends up past the fold.
  const followRef = useFollowOutput<HTMLDivElement>([blocks, held, plannerBusy], { follow: hasContent });
  const messageListCallbackRef = useCallback((el: HTMLDivElement | null) => {
    messageListRef.current = el;
    followRef(el);
  }, [followRef]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      lastActivityRef.current = Date.now();
      const msg = event.data;
      // The login is this surface's own state, not the session's: it ends here
      // rather than in the reducer that mirrors the host.
      if (msg.type === 'plannerLoginEnded') {
        // Each agent's login is its own: one ending neither clears another's
        // pending action nor overwrites its failure.
        setPendingLogin((current) => {
          if (msg.runner === undefined) return {};
          const next = { ...current };
          delete next[msg.runner];
          return next;
        });
        setLoginFailure((current) => {
          if (msg.ok) {
            const next = { ...current };
            if (msg.runner !== undefined) delete next[msg.runner];
            return next;
          }
          return { ...current, [msg.runner ?? '']: msg.message ?? 'Sign-in did not finish.' };
        });
        return;
      }
      dispatch({ ...msg, now: Date.now() });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const fallback = setTimeout(() => setIsReady(true), 4000);
    return () => clearTimeout(fallback);
  }, []);

  useEffect(() => {
    if (settingsRequest === 0) return;
    setSetupCollapsed(false);
    setRunExpanded(true);
  }, [settingsRequest]);

  // Focus after the section has rendered open, so the scroll lands on its full height.
  useEffect(() => {
    if (settingsRequest === 0) return;
    runSettingsRef.current?.focus();
    runSettingsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [settingsRequest, runExpanded]);

  const pushSystem = useCallback((text: string) => {
    vscode.postMessage({ type: 'addNote', text });
  }, []);

  // Watchdog: if the planner is "working" but nothing has arrived from the
  // host for a long stretch (a turn's end was lost, the turn died silently),
  // unlock the input instead of leaving the chat bricked. A harness planner
  // quiet on screen still sends liveness, so only real silence trips it; the
  // window is generous — non-streaming providers can legitimately stay quiet
  // for a minute while a model thinks. A turn waiting on the user's approval
  // card is quiet by design, and must never be called a hang.
  const WATCHDOG_MS = 120_000;
  const approvalWaiting = useMemo(
    () => blocks.some((b) => b.type === 'approval' && b.status === 'pending'),
    [blocks],
  );
  useEffect(() => {
    if (!isResearchActive || approvalWaiting) return;
    lastActivityRef.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActivityRef.current < WATCHDOG_MS) return;
      dispatch({ type: 'turnLost' });
      pushSystem('The planner stopped responding, so the input was re-enabled. Your last message may not have been processed: try sending it again.');
    }, 5_000);
    return () => clearInterval(timer);
  }, [isResearchActive, approvalWaiting, pushSystem]);

  const handleNewSession = useCallback(() => {
    dispatch({ type: 'resetSession', kind: 'new' });
    // A distinct message from stopResearch: /new resets the whole session,
    // while Stop only aborts the current planner turn.
    vscode.postMessage({ type: 'newSession' });
  }, []);

  const handleSend = useCallback((text: string) => {
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
      dispatch({ type: 'commandSent' });
      vscode.postMessage({ type: 'sendMessage', text, runners, typed: true });
      return;
    }

    if (plannerBusy) {
      vscode.postMessage({ type: 'holdPrompt', text });
      return;
    }

    setSlashOutput('');
    clearTimeout(helpTimerRef.current);
    setShowNewSessionConfirm(false);
    // Locked at once rather than when the turn opens: the host may take a
    // moment to start it, and a second send in between would race the first.
    dispatch({ type: 'turnRequested' });
    vscode.postMessage({ type: 'sendMessage', text, runners, typed: true });
  }, [runners, handleNewSession, showNewSessionConfirm, plannerBusy]);

  // The pills are the saved choice every surface and planner turn reads
  // (ADR-0043), so a click asks the host to save it. The request names the
  // state wanted, which keeps a quick second click or a repeat from flipping
  // it back; the pill shows the click until the host answers this request.
  const handleRunnerPill = useCallback((runnerId: RunnerId, enabled: boolean) => {
    nextRunnerRequest.current += 1;
    const requestId = `${runnerRequestPrefix.current}-${nextRunnerRequest.current}`;
    dispatch({ type: 'runnerChoiceRequested', runnerId, enabled, requestId });
    vscode.postMessage({ type: 'setRunnerEnabled', runnerId, enabled, requestId });
  }, []);

  const handleConfigureApiKey = useCallback(() => {
    vscode.postMessage({ type: 'sendMessage', text: '/key', runners });
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

  // The controls below go through the command seam, which keeps each one in
  // the timeline, a refusal too: a note written here first could only
  // contradict that line.
  const handleSkip = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'skip', taskId });
  }, []);

  const handleCancel = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'cancel', taskId });
  }, []);

  const handleCancelResend = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'cancelPlannerResend' });
    pushSystem('Resend cancelled: what waits goes with your next message.');
  }, [pushSystem]);

  const handleRetryCompaction = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'retryPlannerCompaction' });
  }, []);

  const handleCancelResume = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'cancelResume', taskId });
  }, []);

  const handleResumeNow = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'resumeNow', taskId });
  }, []);

  const handleForceStart = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'forceStart', taskId });
  }, []);

  const requestStart = useCallback(() => {
    // Shown before the host is even asked, and only once: two clicks while
    // the first is still with the host are one start.
    if (startPendingRef.current) return;
    const requestId = nextStartRequest.current + 1;
    nextStartRequest.current = requestId;
    startPendingRef.current = true;
    dispatch({ type: 'startRequested', requestId });
    vscode.postMessage({ type: 'sendSystemCommand', command: 'executePlan', requestId });
  }, []);

  const handleExecutePlan = requestStart;

  const handleApproveAll = requestStart;

  const handleStopExecution = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
  }, []);

  const handleRunTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'runTask', taskId });
  }, []);

  // The log tab is the host's webview panel (ADR-0018, V1); the chat only asks
  // for it. Opening is idempotent host-side — an open tab is focused.
  const handleOpenTaskLog = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'openTaskLog', taskId });
  }, []);

  // A handoff's saved patch is a workspace file beside the attempt's log
  // (ADR-0050): the host opens it in an editor tab, as it opens a run's diff.
  const handleOpenPatch = useCallback((path: string) => {
    vscode.postMessage({ type: 'openFile', path });
  }, []);

  // A card's message box (ADR-0018, M1; ADR-0023, F1) uses the same routes the
  // task log does: a plain message through the command seam, Send now through
  // the Session's force send.
  const handleTaskMessage = useCallback((taskId: string, text: string) => {
    vscode.postMessage({ type: 'sendTaskMessage', taskId, text });
  }, []);

  const handleTaskMessageNow = useCallback((taskId: string, text: string) => {
    vscode.postMessage({ type: 'sendTaskMessageNow', taskId, text });
  }, []);

  const handleMarkComplete = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'markComplete', taskId });
  }, []);

  const handleMarkIncomplete = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'markIncomplete', taskId });
  }, []);

  // The card answers into the same resolution every surface uses; the outcome
  // comes back as `approval_settled` and redraws the card.
  const handleResolveApproval = useCallback((id: string, granted: boolean) => {
    vscode.postMessage({ type: 'resolveApproval', id, granted });
  }, []);

  const handleUnsend = useCallback(() => {
    vscode.postMessage({ type: 'unsendPrompt' });
  }, []);

  // Send now (ADR-0023, F5): stop the planner turn and send this ahead of the
  // queue. With no turn running it is a plain send. A built-in slash command is
  // the host's either way — the hold never applies to commands — but a skill
  // invocation (`/name …`) is a planner prompt, so Send now stops the turn.
  const handleSendNow = useCallback((text: string) => {
    if (!plannerBusy || isBuiltinSlashCommand(text)) {
      handleSend(text);
      return;
    }
    setStopArmed(false);
    vscode.postMessage({ type: 'sendMessageNow', text });
  }, [plannerBusy, handleSend]);

  // Prompts held for the next planner turn. Only the newest carries the ×:
  // unsend always takes the newest, as Esc does, so it never promises another.
  const pending = useMemo((): PendingMessage[] => held.map((text, index) => ({
    key: String(index),
    text,
    state: 'queued',
    onSendNow: () => vscode.postMessage({ type: 'sendHeldPromptNow', index }),
    onRemove: index === held.length - 1 ? handleUnsend : undefined,
    removeTitle: 'Unsend (Esc)',
  })), [held, handleUnsend]);

  const stopTurn = useCallback(() => {
    dispatch({ type: 'turnStopped' });
    vscode.postMessage({ type: 'stopResearch' });
  }, []);

  // Esc during a planner turn, in order of intent: take back the newest queued
  // prompt, else arm a stop, else commit it. Outside a turn it is the input's.
  // The stop is the turn's even mid-run: Esc Esc never halts the tasks.
  const handleEscape = useCallback((): boolean => {
    if (expandedTaskId !== null) {
      setExpandedTaskId(null);
      return true;
    }
    if (!plannerBusy) return false;
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
  }, [expandedTaskId, plannerBusy, held, stopArmed, handleUnsend, stopTurn]);

  // Esc closes an open card first, wherever focus is. Inner handlers (card
  // editors, pickers, the input) mark theirs with preventDefault, so one Esc
  // does one thing.
  useEffect(() => {
    if (expandedTaskId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setExpandedTaskId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expandedTaskId]);

  // The pairing is what keeps a stray tap from cancelling a turn, so an arm
  // lapses on its own, and never outlives the turn it was aimed at.
  useEffect(() => {
    if (!stopArmed) return;
    if (!plannerBusy) {
      setStopArmed(false);
      return;
    }
    const timer = setTimeout(() => setStopArmed(false), STOP_ARM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed, plannerBusy]);

  const handleApproveCheckpoint = useCallback(() => {
    if (!checkpoint) return;
    vscode.postMessage({ type: 'answerCheckpoint', taskId: checkpoint.taskId, approved: true });
    dispatch({ type: 'checkpointAnswered' });
  }, [checkpoint]);

  const handleRejectCheckpoint = useCallback((reason: string) => {
    if (!checkpoint) return;
    // Reject resumes the paused agent with the reason (rather than cancelling
    // the task), and the panel is torn down immediately — leaving a decision
    // box on screen after the decision is made asks the user to answer twice.
    vscode.postMessage({ type: 'answerCheckpoint', taskId: checkpoint.taskId, approved: false, reason });
    dispatch({ type: 'checkpointAnswered' });
  }, [checkpoint]);

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
    if (compacting) return 'Queue a message for when the context is compacted...';
    if (isResearchActive) return 'Queue a message for when the planner is done...';
    if (isExecuting) return 'AI is working...';
    if (isStarting) return 'Starting the plan...';
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

  const handleSettingsChange = useCallback((change: SettingsChange) => {
    vscode.postMessage({ type: 'changeSettings', change });
  }, []);

  // The host resolves the target backend's model catalog before it pushes the
  // new provider, and that discovery can spawn a cold CLI (ADR-0009), so the
  // pill would sit unchanged for the whole wait. Light the pick at once and drop
  // the hint on the host's next planner state, whatever it says: the host, not
  // this, decides, so a switch it declined or failed must not stay lit.
  const [pendingPlanner, setPendingPlanner] = useState<string | null>(null);
  useEffect(() => { setPendingPlanner(null); }, [planner]);
  const activePlanner = pendingPlanner ?? planner.provider;
  /** The backend behind that choice, whose own auth verdict the Settings row carries. */
  const activeBackend = planner.backends.find((b) => b.id === activePlanner);

  const handlePlannerChange = useCallback((provider: string) => {
    // Already the planner, or already asked for: a repeat would run the switch twice.
    if (provider === planner.provider || provider === pendingPlanner) return;
    setPendingPlanner(provider);
    vscode.postMessage({ type: 'setPlanner', provider });
  }, [planner.provider, pendingPlanner]);

  // Before the host sends the runner list every task would read as on a runner that is off.
  const runnerScope = useMemo(
    () => (runnersKnown ? { enabledRunners: enabledRunnerIds, allowlist: modelAllowlist, models: modelsByRunner } : undefined),
    [runnersKnown, enabledRunnerIds, modelAllowlist, modelsByRunner],
  );

  // The coding agents the host lists as planners are listed whether or not they
  // are installed, which `runnerList` (installed runners only) cannot say. That
  // full list is kept only to name what to install; the pills offer the usable
  // subset alone, so an unavailable agent is left off rather than struck through
  // (ADR-0009).
  const agentNames = planner.backends.filter((b) => b.kind === 'harness').map((b) => b.label);
  const offeredBackends = planner.backends.filter((b) => b.usable);

  /** What each installed coding agent's own status probe said, keyed by runner id. */
  const runnerAuth = useMemo<Record<string, RunnerAuth | undefined>>(() => {
    const byRunner: Record<string, RunnerAuth | undefined> = {};
    for (const backend of planner.backends) byRunner[backend.runner ?? backend.id] = backend.auth;
    return byRunner;
  }, [planner.backends]);

  /** A pill's own action: that agent's login, without switching the planner to it. */
  const handleRunnerLogin = useCallback((runner: string) => {
    setLoginFailure((current) => {
      const next = { ...current };
      delete next[runner];
      return next;
    });
    setPendingLogin((current) => ({ ...current, [runner]: true }));
    vscode.postMessage({ type: 'loginPlanner', runner });
  }, []);

  /**
   * Every signed-out coding agent, not only the one planning: the login is each
   * one's own fix, and the active planner leads because its refusal is the one
   * about to bite. The rows keep the host's list order after that.
   */
  const signedOutPlanners = useMemo<SignedOutPlannerRow[]>(() => {
    const rows = planner.backends
      .filter((b) => b.kind === 'harness' && b.auth?.state === 'signed-out')
      .map((b) => {
        const runner = b.runner ?? b.id;
        return {
          id: b.id,
          runner,
          label: b.label,
          pending: Boolean(pendingLogin[runner]),
          failure: loginFailure[runner],
          ...(b.auth?.loginCommand?.length ? { onLogIn: () => handleRunnerLogin(runner) } : {}),
        };
      });
    // Stable sort: the active planner first, everything else as the host listed it.
    return rows.sort((a, b) => Number(b.id === activePlanner) - Number(a.id === activePlanner));
  }, [planner.backends, activePlanner, pendingLogin, loginFailure, handleRunnerLogin]);

  const runnerLabelMap = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of runnerList) m[r.id] = r.displayName;
    return m;
  }, [runnerList]);

  const runningCount = useMemo(() =>
    plan?.tasks.filter((t) => t.status === 'in_progress').length ?? 0,
    [plan],
  );

  const doneCount = useMemo(() =>
    plan?.tasks.filter((t) => t.status === 'completed').length ?? 0,
    [plan],
  );

  /** The one usage block, drawn pinned below the conversation rather than scrolling in it. */
  const usageBlock = useMemo(() => blocks.find((b) => b.type === 'usage'), [blocks]);

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
          {runSettingsSummary(host.runSettings?.run, plan.runSettings, isExecuting)}
          {/* A collapse is always honoured, including mid-run — so the bar has to
              say when a task is blocked on the user, or the approval would sit
              unseen behind it. */}
          {checkpoint && <span className="plan-dock-approval">1 awaiting approval</span>}
          {run.runMerge && <span className="plan-dock-summary">{run.runMerge.landed.length} unmerged</span>}
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
          {run.runMerge && !run.runMerge.waitingAtGate && isExecuting && (
            <div className="plan-merge-actions">
              <span>{run.runMerge.landed.length} landed task{run.runMerge.landed.length === 1 ? '' : 's'} not merged</span>
              <button className="task-action-btn run" onClick={() => handleIsolationAction('merge')}>Merge all</button>
            </div>
          )}
          {runnerNotice && (
            <div className="runner-notice" role="note">
              {runnerNotice.line}: <a href={runnerNotice.docs}>how to fix it</a>
            </div>
          )}
          <TaskCommandsBridge.Provider value={postTaskCommand}>
            <PlanCardGroup
              expandedTaskId={expandedTaskId}
              onExpandedTaskChange={setExpandedTaskId}
              tasks={plan.tasks}
              run={run}
              models={models}
              modelsByRunner={modelsByRunner}
              modesByRunner={modesByRunner}
              isExecuting={isExecuting}
              isStarting={isStarting}
              runActive={isExecuting || starting || activity.advancesOnItsOwn}
              taskOutput={taskOutput}
              runnerLabels={runnerLabelMap}
              runners={runnerList}
              runnerScope={runnerScope}
              onRunnerChange={handleRunnerChange}
              onDependenciesChange={handleDependenciesChange}
              onAddTask={handleAddTask}
              onModelChange={handleModelChange}
              onModelsRefreshNeeded={handleModelsRefreshNeeded}
              onModeChange={handleModeChange}
              onOpsChange={handleOpsChange}
              taskSkills={taskSkills}
              onSkillsChange={handleSkillsChange}
              onRemoveTask={handleRemoveTask}
              onPromptChange={handlePromptChange}
              onRetry={handleRetry}
              onSkip={handleSkip}
              onCancel={handleCancel}
              onCancelResume={handleCancelResume}
              onResumeNow={handleResumeNow}
              onForceStart={handleForceStart}
              onMarkComplete={handleMarkComplete}
              onMarkIncomplete={handleMarkIncomplete}
              onExecutePlan={handleExecutePlan}
              onStopExecution={handleStopExecution}
              onApproveAll={handleApproveAll}
              onRunTask={handleRunTask}
              onSendMessage={handleTaskMessage}
              onSendMessageNow={handleTaskMessageNow}
              onResolveConflict={handleResolveConflict}
              onOpenLog={handleOpenTaskLog}
            />
          </TaskCommandsBridge.Provider>
          {run.handoff && !isExecuting && !run.runMerge?.waitingAtGate && (
            <HandoffCard
              repos={run.handoff.repos}
              landed={run.handoff.landed}
              deferredTo={run.handoff.deferredTo}
              mergeResult={run.mergeResult}
              onAction={(action) => handleIsolationAction(action)}
            />
          )}
          {run.runMerge?.waitingAtGate && (
            <HandoffCard
              repos={run.runMerge.repos}
              landed={run.runMerge.landed}
              mergeResult={run.mergeResult}
              midRun={{ paused: run.runMerge.paused }}
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
              <div className="executing-status">Tasks active: messages reach the planner now; new tasks wait while it replies</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <OpenPatchContext.Provider value={handleOpenPatch}>
    {/* Focus targets for a mouse selection, never tab stops. VS Code 1.143+
        answers a Cmd/Ctrl+C in a webview by refocusing the last-focused
        element before it copies whenever focus sits on <body>, and here that
        is the composer, whose focus wipes the selection. A drag in the
        conversation or the footer now focuses one of these instead, so focus
        never rests on <body>. The list is its own target so arrow keys and
        Page Down still scroll it after a click. */}
    <div className="chat-container" tabIndex={-1}>
      <div className="setup-panel">
        <button
          type="button"
          className={`setup-panel-toggle${setupCollapsed ? '' : ' open'}`}
          aria-expanded={!setupCollapsed}
          onClick={() => setSetupCollapsed((v) => !v)}
          title={
            activeBackend?.auth?.state === 'signed-out'
              ? `${activeBackend.label} is not logged in — open Settings to sign in`
              : setupCollapsed
                ? 'Expand settings'
                : 'Collapse settings'
          }
        >
          <span className="setup-panel-toggle-row">
            <span className="setup-panel-toggle-label">Settings</span>
            {activeBackend?.auth?.state === 'signed-out' && (
              <>
                <span className="planner-auth-dot" aria-hidden="true" />
                <span className="visually-hidden">not logged in: {activeBackend.label}</span>
              </>
            )}
            <span className={`setup-panel-chevron${setupCollapsed ? ' collapsed' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
        </button>
        <div className={`setup-panel-body${setupCollapsed ? ' collapsed' : ''}`}>
        <section className="setup-block">
          <div className="setup-block-title">Planner</div>
          <div className="setup-block-hint">
            Researches your codebase and writes the plan. A coding agent plans on its own
            subscription.
          </div>
          {offeredBackends.length > 0 ? (
            <>
              <div className="planner-backends">
                {offeredBackends.map((b) => {
                  const runnerId = b.runner ?? b.id;
                  const signingIn = Boolean(pendingLogin[runnerId]);
                  const signedOut = b.auth?.state === 'signed-out';
                  // The login is this agent's own and never selects the planner
                  // (ADR-0009); it stays offered here even while the empty state
                  // carries the same action, as long as there is a command to run.
                  const canLogIn = signedOut && (b.auth?.loginCommand?.length ?? 0) > 0;
                  return (
                    <span className={`planner-pill-item${canLogIn ? ' has-login' : ''}`} key={b.id} data-runner={runnerId}>
                      <span className={`planner-pill-group${signedOut ? ' signed-out' : ''}${b.id === activePlanner ? ' active' : ''}`}>
                        <button
                          type="button"
                          className={`planner-pill${b.id === activePlanner ? ' active' : ''}${signedOut ? ' signed-out' : ''}${pendingPlanner === b.id ? ' pending' : ''}`}
                          title={signedOut ? 'Not logged in — sign in from this chat' : b.reason}
                          onClick={() => handlePlannerChange(b.id)}
                        >
                          {signedOut && <span className="planner-auth-dot" aria-hidden="true" />}
                          {b.label}
                        </button>
                        {canLogIn && (
                          <PlannerLoginAction
                            className="planner-pill-login"
                            onLogIn={() => handleRunnerLogin(runnerId)}
                            pending={signingIn}
                            ariaLabel={signingIn ? `Signing in to ${b.label}` : `Log in to ${b.label}`}
                            title={signingIn ? `Signing in to ${b.label}` : `Log in to ${b.label}`}
                          />
                        )}
                      </span>
                      {canLogIn && (
                        <span className="planner-pill-failure-slot">
                          {!signingIn && loginFailure[runnerId] !== undefined && (
                            <span className="planner-pill-login-failure" role="status" title={loginFailure[runnerId]}>{loginFailure[runnerId]}</span>
                          )}
                        </span>
                      )}
                    </span>
                  );
                })}
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
                    ? <>No models discovered for this agent yet: run <code>/refresh</code>.</>
                    : <>No models available. Add an API key with <code>/key</code>, or pick a coding agent above.</>}
                </div>
              )}
              {Object.keys(modelDiscoveryErrors).length > 0 && !planner.runner && (
                <div className="model-discovery-error" role="alert">
                  ⚠ Couldn't load models for{' '}
                  {Object.entries(modelDiscoveryErrors)
                    .map(([p, msg]) => `${API_PROVIDER_LABELS[p as keyof typeof API_PROVIDER_LABELS] ?? p} (${msg})`)
                    .join('; ')}
                  . Check the API key / base URL: those models are omitted.
                </div>
              )}
            </>
          ) : (
            <span className="setup-block-empty">
              {plannerKnown
                ? <>No planner available — install {orNames(agentNames, 'a coding agent')}, or add a key with <code>/key</code>.</>
                : DETECTING}
            </span>
          )}
        </section>

        <section className="setup-block">
          <div className="setup-block-title">Runners</div>
          <div className="setup-block-hint">
            Coding agents that execute the plan's tasks. The planner assigns only the ones switched on.
          </div>
          <div className="runner-pills">
            {runnerList.map((r) => {
              const on = runners.includes(r.id);
              // Never emptied from here: with no runner on, no surface could assign a task.
              const last = on && runners.length === 1;
              const auth = runnerAuth[r.id];
              const signedOut = auth?.state === 'signed-out';
              const signingIn = Boolean(pendingLogin[r.id]);
              // A login never switches the runner on or off: it only signs that
              // agent in, exactly as the planner pill beside it does.
              const canLogIn = signedOut && (auth?.loginCommand?.length ?? 0) > 0;
              const title = signedOut
                ? 'Not logged in'
                : last
                  ? `${r.displayName} is the only runner on: switch another on first`
                  : on
                    ? `Stop assigning tasks to ${r.displayName}, on every surface`
                    : `Click to enable ${r.displayName} as a runner on every surface`;
              return (
                <span className={`runner-pill-item${canLogIn ? ' has-login' : ''}`} key={r.id} data-runner={r.id}>
                  <span className={`runner-pill-group${on ? ' on' : ' disabled'}${r.id in pendingRunners ? ' pending' : ''}${signedOut ? ' signed-out' : ''}`}>
                    <button className={`runner-pill ${on ? 'on' : 'disabled'}${r.id in pendingRunners ? ' pending' : ''}${signedOut ? ' signed-out' : ''}`}
                      onClick={() => { if (!last) handleRunnerPill(r.id, !on); }}
                      aria-pressed={on}
                      title={title}>
                      <span className={`runner-dot${signedOut ? ' planner-auth-dot' : ''}`} aria-hidden={signedOut ? true : undefined} /> {r.displayName}
                    </button>
                    {canLogIn && (
                      <PlannerLoginAction
                        className="planner-pill-login runner-pill-login"
                        onLogIn={() => handleRunnerLogin(r.id)}
                        pending={signingIn}
                        ariaLabel={signingIn ? `Signing in to ${r.displayName}` : `Log in to ${r.displayName}`}
                        title={signingIn ? `Signing in to ${r.displayName}` : `Log in to ${r.displayName}`}
                      />
                    )}
                  </span>
                  {canLogIn && (
                    <span className="planner-pill-failure-slot runner-pill-failure-slot">
                      {!signingIn && loginFailure[r.id] !== undefined && (
                        <span className="planner-pill-login-failure runner-pill-login-failure" role="status" title={loginFailure[r.id]}>{loginFailure[r.id]}</span>
                      )}
                    </span>
                  )}
                </span>
              );
            })}
            {runnerList.length === 0 && !runnersKnown && (
              <span className="setup-block-empty">{DETECTING}</span>
            )}
            {runnerList.length === 0 && runnersKnown && (
              <span className="setup-block-empty">
                No coding agent detected: install {orNames(agentNames, 'a coding agent')}, then run <code>/refresh</code>.
              </span>
            )}
          </div>
        </section>

        {host.runSettings && <RunSettingsBlock ref={runSettingsRef} value={host.runSettings} expanded={runExpanded} onToggle={() => setRunExpanded((v) => !v)} onChange={handleSettingsChange} />}
        </div>
      </div>

      {slashOutput && (
        <div className="slash-output">{slashOutput}</div>
      )}

      {showNewSessionConfirm && (
        <div className="new-session-confirm">
          <div className="new-session-confirm-text">
            Start a new session? The current plan and its progress are cleared: planning and any running tasks are stopped.
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

      <div className="message-list" tabIndex={-1} ref={messageListCallbackRef}>
        {!hasContent && !isReady && (
          <div className="loading-state">
            <div className="loading-pulse" />
            <p>Loading…</p>
          </div>
        )}

        {/* Who can plan comes from the probe for coding agents, which can answer after the catalog. */}
        {!hasContent && isReady && !canPlan && !plannerKnown && (
          <div className="loading-state">
            <div className="loading-pulse" />
            <p>{DETECTING}</p>
          </div>
        )}

        {!hasContent && isReady && !canPlan && plannerKnown && (
          <GetStarted runnerNames={agentNames} onConfigure={handleConfigureApiKey} runSettings={host.runSettings} isolationPreview={host.isolationPreview} />
        )}

        {emptyStateShown && (
          <EmptyState onLoadSession={handleLoadSession} runSettings={host.runSettings} signedOut={signedOutPlanners} isolationPreview={host.isolationPreview} />
        )}

        {error && (
          <div className="error-state">
            <div className="error-icon">!</div>
            <p className="error-message">{error}</p>
            <button onClick={() => setError('')}>Try Again</button>
          </div>
        )}

        <ConversationBlocks
          key={host.conversationEpoch}
          blocks={blocks}
          onShowPlan={handleShowPlan}
          onResolveApproval={handleResolveApproval}
        />
      </div>

      {renderPlanDock()}

      <UsageLine block={usageBlock} limits={accountLimitsOf(accountLimits, planner.runner, modelConfig?.orchestrator)} />

      {/* Pinned rather than the list's last row, and drawn for the whole turn:
          a turn can go minutes with nothing new to show, its thinking block
          still marked streaming while the model writes a tool call's input,
          and a reader scrolled back up would not see a row in the list. */}
      {isResearchActive && !compacting && (
        <div className="chat-msg-working" role="status">
          <span className="chat-msg-spinner" aria-hidden="true" /> Working&hellip;
          <ElapsedTime since={plannerTurnStartedAt} className="chat-msg-working-time" />
        </div>
      )}

      {/* Pinned for the same reason while the planner compacts, and kept as
          the one live region that tells its start and its end. */}
      {compaction && (
        <div className={compacting ? 'chat-msg-working' : 'visually-hidden'} role="status">
          {compacting && <span className="chat-msg-spinner" aria-hidden="true" />}
          {compactionNews}
        </div>
      )}

      {stopArmed && <div className="stop-hint" role="status">Press Esc again to stop</div>}

      <PlannerResendBar resend={plan?.plannerResend} onCancel={handleCancelResend} />

      <PlannerPauseBar pause={plan?.plannerContextPause} busy={plannerBusy} onRetry={handleRetryCompaction} onStop={stopTurn} />

      <PendingMessages messages={pending} />

      <ChatInput
        onSend={handleSend}
        onSendNow={handleSendNow}
        onStop={stopTurn}
        onEscape={handleEscape}
        disabled={false}
        placeholder={getPlaceholder()}
        isTurnRunning={plannerBusy}
        unsent={unsent}
        skills={skills}
      />
    </div>
    </OpenPatchContext.Provider>
  );
}
