import React, { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react';
import EmptyState, { type SignedOutPlannerRow } from './components/EmptyState';
import PlannerLoginAction from './components/PlannerLogin';
import GetStarted from './components/GetStarted';
import { orNames } from './runnerNames';
import ChatInput from './components/ChatInput';
import ElapsedTime from './components/ElapsedTime';
import PlannerResendBar from './components/PlannerResendBar';
import PlannerPauseBar from './components/PlannerPauseBar';
import EscalationInbox from './components/EscalationInbox';
import DockResizeHandle from './components/DockResizeHandle';
import { ConversationBlocks } from './components/ChatMessage';
import ChildPlanPanel, { ChildQuestions, NO_CHILD_NOTICE, UndeliveredAnswers, type ChildNotice } from './components/ChildPlanPanel';
import { reduceHost, runnersOn, INITIAL_HOST_STATE, type HostState } from './hostState';
import ModelSelector, { API_PROVIDER_LABELS } from './components/ModelSelector';
import PlanCardGroup from './components/PlanCardGroup';
import PlanApprovalCard from './components/PlanApprovalCard';
import { SpeakerLabelsContext } from './speakerLabels';
import UsageLine from './components/UsageLine';
import PendingMessages, { type PendingMessage } from './components/PendingMessages';
import HandoffCard from './components/HandoffCard';
import CheckpointPanel from './components/CheckpointPanel';
import RunSettingsBlock from './components/RunSettingsBlock';
import type { RunnerSignInView } from './components/TaskCard';
import type { TaskDraft } from './components/NewTaskCard';
import type { ChildPlanEntry, ChildPlanView, CompactionBlock, GlobalRunSettings, RunSettings, Task, TaskModelAssignment, RunnerId, RunnerAuth, SurfaceTask, DiscoveredModel, AiProvider } from '@ordewell/core';
import { accountLimitsOf, compactionText, describeRunnerSignIn, signInAction, signInOfVerdict, SUPERVISOR_LEVEL_LABEL, TERMINAL_UI_SIGN_IN, type RunnerSignIn } from '@ordewell/core/plan-utils';
import { DelegationOfferedContext, useDelegationOffered } from './delegationOffered';
import { planSummaryLabel, nextDock } from './planDock';
import { OpenPatchContext } from './openPatch';
import { useFollowOutput } from './followOutput';
import { INBOX_OFF_NOTE, useInboxPrefs } from './inboxView';
import { useEscalationAnswers } from './components/escalationAnswers';
import { ROOT_ANSWERS, useChildAnswers, useChildDrafts } from './childDrafts';
import { isBuiltinSlashCommand, slashHelp } from '../shared/slashCommands';
import type { EscalationAnswer, HostToWebview, SettingsChange } from '../shared/protocol';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks } from '../shared/conversationPatch';
import { useChatBridge } from '../bridge';

const STOP_ARM_MS = 2_000;

type Updatable<T> = T | ((prev: T) => T);

/** The dock's word on the supervisor, when there is one to speak of. */
/**
 * The run settings on the plan bar (ADR-0030): the user's level, and during a
 * run the run's own where a guard, a failure or another window left it
 * different.
 */
function runSettingsSummary(run: GlobalRunSettings | undefined, runSettings: RunSettings | undefined, isExecuting: boolean, delegationOffered: boolean): React.ReactNode {
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
      {delegationOffered && run.delegationTokens > 0 && <span className="plan-dock-summary">Delegation</span>}
    </>
  );
}

const DETECTING = 'Detecting coding agents…';

/**
 * "Detecting coding agents…" while the host's detection is under way, or why
 * it failed with a Retry, so the first screen never waits on an answer that
 * is not coming.
 */
function Detecting({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error === null) return <>{DETECTING}</>;
  return (
    <span className="detection-failed">
      Couldn't detect coding agents: {error}{' '}
      <button type="button" className="btn-secondary" onClick={onRetry}>Retry</button>
    </span>
  );
}

/**
 * Which part of the chat a surface draws. `chat` is the one-column webview;
 * a surface with room for both (the desktop app) mounts two instances over one
 * bridge, `conversation` without the plan dock and `plan` as the dock's body
 * alone.
 */
export type ChatLayout = 'chat' | 'conversation' | 'plan';

/** A host that keeps the open card elsewhere (the desktop's Graph shares it with this list). */
export interface TaskSelection {
  taskId: string | null;
  onChange(taskId: string | null): void;
  /**
   * Open the task's chat in its own tab: a preview the next one replaces,
   * unless the user asked to keep it. Without it a chat opens as the host's
   * log tab.
   */
  onOpen?(taskId: string, view: 'chat', options?: { preview?: boolean }): void;
}

export default function App({ layout = 'chat', selection, goal }: {
  layout?: ChatLayout;
  selection?: TaskSelection;
  /** The session's goal, named at the head of the `plan` layout. */
  goal?: string;
} = {}) {
  const bridge = useChatBridge();
  const [host, dispatch] = useReducer(reduceHost, INITIAL_HOST_STATE);
  const [childTree, setChildTree] = useState<{ rootId: string; children: ChildPlanEntry[] }>({ rootId: '', children: [] });
  const [childView, setChildView] = useState<ChildPlanView | null>(null);
  const childViewRef = useRef<ChildPlanView | null>(null);
  childViewRef.current = childView;
  const [childConversation, setChildConversation] = useState(EMPTY_PATCHED_VIEW);
  const [childChoice, setChildChoice] = useState<string | null>(null);
  const [childNotice, setChildNotice] = useState<ChildNotice>(NO_CHILD_NOTICE);
  const childComposer = useChildDrafts(bridge, setChildNotice);
  const childAnswers = useChildAnswers(bridge, setChildNotice);
  // A childView on its way when the person left, of any child, is one the host
  // has since closed, so none is drawn until they open one again.
  const childLeft = useRef(false);
  const childOpener = useRef<HTMLElement | null>(null);
  const inChild = childView !== null;
  useEffect(() => {
    if (inChild) return;
    childOpener.current?.focus();
    childOpener.current = null;
  }, [inChild]);
  // The webview's own switch is false in any build; the host says (ADR-0055 D21).
  const told = host.runSettings?.delegationOffered === true;
  const delegationOffered = useDelegationOffered() || told;
  const {
    conversation, plan, isExecuting, isResearchActive, error, models, modelsByRunner,
    runnerList, enabledRunnerIds, pendingRunners, modelAllowlist, held, unsent, modesByRunner, runnerNotice, modelConfig,
    modelOptions, configuredProviders, planner, plannerKnown, plannerDetecting, runnersKnown, detectionError, isReady, modelDiscoveryErrors,
    runnerDiscoveryErrors,
    skills, taskSkills, checkpoint, taskOutput, run, activity, starting, dockExpanded, dockHeight, settingsRequest, accountLimits, plannerTurnStartedAt,
  } = host;
  const setPlan = useCallback((v: Updatable<HostState['plan']>) => dispatch({ type: 'patchPlan', plan: v }), []);
  const setError = useCallback((v: string) => dispatch({ type: 'patchError', error: v }), []);
  const setIsReady = useCallback((v: boolean) => dispatch({ type: 'patchReady', ready: v }), []);
  const setDockHeight = useCallback((v: number | undefined) => dispatch({ type: 'patchDockHeight', height: v }), []);
  const setDockExpanded = useCallback((v: Updatable<boolean>) => dispatch({ type: 'patchDockExpanded', expanded: v }), []);
  const blocks = useMemo(() => patchedBlocks(conversation), [conversation]);
  useEffect(() => {
    if (delegationOffered && plan?.tasks.some((task) => task.type === 'delegated')) bridge.post({ type: 'refreshChildren' });
  }, [delegationOffered, plan]);
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
  const [ownExpandedTaskId, setOwnExpandedTaskId] = useState<string | null>(null);
  const expandedTaskId = selection ? selection.taskId : ownExpandedTaskId;
  const onSelectionChange = useRef(selection?.onChange);
  onSelectionChange.current = selection?.onChange;
  const setExpandedTaskId = useCallback((taskId: string | null): void => {
    if (onSelectionChange.current) onSelectionChange.current(taskId);
    else setOwnExpandedTaskId(taskId);
  }, []);
  const [slashOutput, setSlashOutput] = useState('');
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  /** The person opened or closed the setup themselves, or asked for its settings: theirs from then on. */
  const setupChosen = useRef(false);
  const [composerSession, setComposerSession] = useState(0);
  /** The approval card's Edit, which opens the run settings as the host's request does. */
  const [ownSettingsRequest, setOwnSettingsRequest] = useState(0);
  const [runExpanded, setRunExpanded] = useState(false);
  /** The coding agent whose login is running, by runner id: each action waits on its own. */
  const [pendingLogin, setPendingLogin] = useState<Record<string, true>>({});
  /** Each login that did not finish and why, by runner id: shown inline on the row or pill that asked. */
  const [loginFailure, setLoginFailure] = useState<Record<string, string>>({});

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const planListRef = useRef<HTMLDivElement>(null);
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
    const handler = (msg: HostToWebview) => {
      lastActivityRef.current = Date.now();
      if (msg.type === 'restoreChat' && childViewRef.current) bridge.post({ type: 'refreshChildren' });
      // Another session's conversation: a half-typed message was written to the last one.
      if (msg.type === 'restoreChat') setComposerSession((n) => n + 1);
      if (msg.type === 'children') { setChildTree({ rootId: msg.rootId, children: msg.children }); return; }
      if (msg.type === 'childClosed') { setChildView(null); setChildChoice(null); setChildConversation(EMPTY_PATCHED_VIEW); return; }
      if (msg.type === 'childView') { if (!childLeft.current) setChildView(msg.view); return; }
      if (msg.type === 'childConversation') { setChildConversation((current) => applyConversationPatch(current, msg.message)); return; }
      if (msg.type === 'childNotice') { setChildNotice({ childId: msg.childId, message: msg.message }); return; }
      if (msg.type === 'childMessageResult') return;
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
    return bridge.subscribe(handler);
  }, [bridge]);

  useEffect(() => {
    bridge.post({ type: 'ready' });
    const fallback = setTimeout(() => setIsReady(true), 4000);
    return () => clearTimeout(fallback);
  }, []);

  const settingsAsked = settingsRequest + ownSettingsRequest;
  useEffect(() => {
    if (settingsAsked === 0) return;
    setupChosen.current = true;
    setSetupCollapsed(false);
    setRunExpanded(true);
  }, [settingsAsked]);

  // Focus after the section has rendered open, so the scroll lands on its full height.
  useEffect(() => {
    if (settingsAsked === 0) return;
    runSettingsRef.current?.focus();
    runSettingsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [settingsAsked, runExpanded]);

  // The planner tab gives the conversation the room once there is one: the
  // setup is the step before it (docs/desktop/design.md, W2), a click away after.
  // A choice made in one conversation is not one made in the next (a session switch, a reload).
  const conversing = blocks.length > 0;
  const epoch = host.conversationEpoch;
  useEffect(() => {
    setupChosen.current = false;
    setSetupCollapsed(false);
  }, [epoch]);
  useEffect(() => {
    if (layout !== 'conversation' || !conversing || setupChosen.current) return;
    setupChosen.current = true;
    setSetupCollapsed(true);
  }, [layout, conversing, epoch]);

  const pushSystem = useCallback((text: string) => {
    bridge.post({ type: 'addNote', text });
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
    bridge.post({ type: 'newSession' });
  }, []);

  const handleEscalationAnswer = useCallback((answer: EscalationAnswer) => {
    bridge.post({ type: 'answerEscalation', ...answer });
  }, []);
  const escalationAnswers = useEscalationAnswers(handleEscalationAnswer);
  const inboxView = useInboxPrefs(bridge);
  const { update: updateInboxView } = inboxView;
  const handleToggleInbox = useCallback(() => updateInboxView({ open: !inboxView.open }), [inboxView.open, updateInboxView]);

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
    if (/^\/inbox(\s|$)/i.test(text)) {
      updateInboxView({ enabled: !inboxView.enabled });
      if (inboxView.enabled) bridge.post({ type: 'addNote', text: INBOX_OFF_NOTE });
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
      bridge.post({ type: 'sendMessage', text, runners, typed: true });
      return;
    }

    if (plannerBusy) {
      bridge.post({ type: 'holdPrompt', text });
      return;
    }

    setSlashOutput('');
    clearTimeout(helpTimerRef.current);
    setShowNewSessionConfirm(false);
    // Locked at once rather than when the turn opens: the host may take a
    // moment to start it, and a second send in between would race the first.
    dispatch({ type: 'turnRequested' });
    bridge.post({ type: 'sendMessage', text, runners, typed: true });
  }, [runners, handleNewSession, showNewSessionConfirm, plannerBusy, inboxView.enabled, updateInboxView]);

  // The pills are the saved choice every surface and planner turn reads
  // (ADR-0043), so a click asks the host to save it. The request names the
  // state wanted, which keeps a quick second click or a repeat from flipping
  // it back; the pill shows the click until the host answers this request.
  const handleRunnerPill = useCallback((runnerId: RunnerId, enabled: boolean) => {
    nextRunnerRequest.current += 1;
    const requestId = `${runnerRequestPrefix.current}-${nextRunnerRequest.current}`;
    dispatch({ type: 'runnerChoiceRequested', runnerId, enabled, requestId });
    bridge.post({ type: 'setRunnerEnabled', runnerId, enabled, requestId });
  }, []);

  const handleConfigureApiKey = useCallback(() => {
    bridge.post({ type: 'sendMessage', text: '/key', runners });
  }, [runners]);

  const handleLoadSession = useCallback(() => {
    bridge.post({ type: 'sendMessage', text: '/sessions', runners });
  }, [runners]);

  // A task card's own edit shows at once; the host's next plan settles it.
  const echoTask = useCallback((taskId: string, patch: Partial<Task>) => {
    const patchIn = (tasks: SurfaceTask[]): SurfaceTask[] => tasks.map((t) => {
      if (t.id === taskId) return { ...t, ...patch };
      return t.subtasks.length > 0 ? { ...t, subtasks: patchIn(t.subtasks) } : t;
    });
    setPlan((current) => (current ? { ...current, tasks: patchIn(current.tasks) } : current));
  }, []);

  const handlePromptChange = useCallback((taskId: string, prompt: string) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'prompt', prompt } });
    echoTask(taskId, { prompt, description: prompt });
  }, [echoTask]);

  // No optimistic removal: the host asks for confirmation, so the card must
  // survive a "Cancel" and only disappear when the host echoes the new plan.
  const handleRemoveTask = useCallback((taskId: string) => {
    bridge.post({ type: 'removeTask', taskId });
  }, []);

  // Not echoed either: the host validates the edit against the whole graph and
  // refuses some lists, so the checkboxes must show what was accepted.
  const handleDependenciesChange = useCallback((taskId: string, dependencies: string[]) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'dependencies', dependencies } });
  }, []);

  const handleAddTask = useCallback((draft: TaskDraft) => {
    bridge.post({ type: 'addTask', draft });
  }, []);

  // Activation-time discovery can cache a degraded (empty) catalog for a runner
  // that was cold or unconfigured at that moment (see ModelDiscovery's
  // warnDegradedDiscovery). Unlike the TUI's task-model picker, which
  // re-fetches on every open, this webview only refreshes on activation, a
  // config change, or reconnect — so a stale empty list for an already-
  // assigned task's runner never self-heals on its own. Re-discover whenever a
  // task's model dropdown opens, same as the TUI does.
  const handleModelsRefreshNeeded = useCallback(() => {
    bridge.post({ type: 'refreshModels' });
  }, []);

  const handleModelChange = useCallback((taskId: string, assignment: TaskModelAssignment) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'model', assignment } });
    echoTask(taskId, { assignedModel: assignment });
  }, [echoTask]);

  // Only the runner is echoed optimistically. The model, effort and mode that
  // follow from it come from the new runner's catalog, which only the host can
  // read — guessing them here would display an unspawnable assignment until the
  // retargeted plan arrives.
  const handleRunnerChange = useCallback((taskId: string, runner: string) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'runner', runner } });
    echoTask(taskId, { assignedRunner: runner });
  }, [echoTask]);

  const handleModeChange = useCallback((taskId: string, mode: string) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'mode', mode } });
    echoTask(taskId, { taskMode: mode });
  }, [echoTask]);

  const handleSkillsChange = useCallback((taskId: string, skills: string[]) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'skills', skills } });
    echoTask(taskId, { skills: skills.length > 0 ? skills : undefined });
  }, [echoTask]);

  const handleOpsChange = useCallback((taskId: string, ops: boolean) => {
    bridge.post({ type: 'editTask', taskId, edit: { kind: 'ops', ops } });
    echoTask(taskId, { ops });
  }, [echoTask]);

  const handleRetry = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'retry', taskId });
  }, []);

  // The controls below go through the command seam, which keeps each one in
  // the timeline, a refusal too: a note written here first could only
  // contradict that line.
  const handleSkip = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'skip', taskId });
  }, []);

  const handleCancel = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'cancel', taskId });
  }, []);

  const handleCancelResend = useCallback(() => {
    bridge.post({ type: 'sendSystemCommand', command: 'cancelPlannerResend' });
    pushSystem('Resend cancelled: what waits goes with your next message.');
  }, [pushSystem]);

  const handleRetryCompaction = useCallback(() => {
    bridge.post({ type: 'sendSystemCommand', command: 'retryPlannerCompaction' });
  }, []);

  const handleCancelResume = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'cancelResume', taskId });
  }, []);

  const handleResumeNow = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'resumeNow', taskId });
  }, []);

  const handleForceStart = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'forceStart', taskId });
  }, []);

  const requestStart = useCallback(() => {
    // Shown before the host is even asked, and only once: two clicks while
    // the first is still with the host are one start.
    if (startPendingRef.current) return;
    const requestId = nextStartRequest.current + 1;
    nextStartRequest.current = requestId;
    startPendingRef.current = true;
    dispatch({ type: 'startRequested', requestId });
    bridge.post({ type: 'sendSystemCommand', command: 'executePlan', requestId });
  }, []);

  const handleExecutePlan = requestStart;

  const handleApproveAll = requestStart;

  const handleStopExecution = useCallback(() => {
    bridge.post({ type: 'sendSystemCommand', command: 'stopExecution' });
  }, []);

  const handleRunTask = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'runTask', taskId });
  }, []);

  // The log tab is the host's webview panel (ADR-0018, V1); the chat only asks
  // for it. Opening is idempotent host-side — an open tab is focused.
  const onOpenTask = useRef(selection?.onOpen);
  onOpenTask.current = selection?.onOpen;
  const handleOpenTaskLog = useCallback((taskId: string) => {
    if (onOpenTask.current) onOpenTask.current(taskId, 'chat');
    else bridge.post({ type: 'openTaskLog', taskId });
  }, []);

  // The card is where a task's evidence is, so opening the task is opening its
  // card in the dock, whatever the user had collapsed.
  const handleOpenEscalatedTask = useCallback((taskId: string) => {
    setDockExpanded((v) => nextDock(v, 'user-expanded'));
    setExpandedTaskId(taskId);
  }, []);

  // A handoff's saved patch is a workspace file beside the attempt's log
  // (ADR-0050): the host opens it in an editor tab, as it opens a run's diff.
  const handleOpenPatch = useCallback((path: string) => {
    bridge.post({ type: 'openFile', path });
  }, []);

  // A card's message box (ADR-0018, M1; ADR-0023, F1) uses the same routes the
  // task log does: a plain message through the command seam, Send now through
  // the Session's force send.
  const handleTaskMessage = useCallback((taskId: string, text: string) => {
    bridge.post({ type: 'sendTaskMessage', taskId, text });
  }, []);

  const handleTaskMessageNow = useCallback((taskId: string, text: string) => {
    bridge.post({ type: 'sendTaskMessageNow', taskId, text });
  }, []);

  const handleMarkComplete = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'markComplete', taskId });
  }, []);

  const handleMarkIncomplete = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'markIncomplete', taskId });
  }, []);

  // The host asks core what goes with the task and confirms in a real modal.
  const handleRevert = useCallback((taskId: string) => {
    bridge.post({ type: 'sendSystemCommand', command: 'revertTask', taskId });
  }, []);

  // The card answers into the same resolution every surface uses; the outcome
  // comes back as `approval_settled` and redraws the card.
  const handleResolveApproval = useCallback((id: string, granted: boolean) => {
    bridge.post({ type: 'resolveApproval', id, granted });
  }, []);

  // Whether the composer is empty, as it last said: the newest row's × must
  // do what Esc does, and Esc is told this by the composer itself.
  const composerEmptyRef = useRef(true);
  const handleComposerEmpty = useCallback((empty: boolean) => { composerEmptyRef.current = empty; }, []);

  // Takes back the newest held prompt. It refills an empty composer; over a
  // draft it is discarded, so taking it back never buries what is being typed.
  const handleUnsend = useCallback((toComposer: boolean) => {
    bridge.post({ type: 'unsendPrompt', toComposer });
  }, []);

  // Send now (ADR-0023, F5): stop the planner turn and send everything held,
  // glued in the order typed with `text` last, as one message ahead of
  // anything else. `text` is empty when only what is held goes. With no turn
  // running it is a plain send. A built-in slash command is the host's either
  // way — the hold never applies to commands — but a skill invocation
  // (`/name …`) is a planner prompt, so Send now stops the turn.
  const handleSendNow = useCallback((text: string) => {
    if (isBuiltinSlashCommand(text) || (!plannerBusy && text)) {
      handleSend(text);
      return;
    }
    if (!plannerBusy) return;
    setStopArmed(false);
    bridge.post({ type: 'sendMessageNow', text });
  }, [plannerBusy, handleSend]);

  // The held group's own Send all now sends only what is held; the composer's
  // draft stays where it is.
  const handleSendHeldNow = useCallback(() => {
    setStopArmed(false);
    bridge.post({ type: 'sendMessageNow', text: '' });
  }, []);

  // Prompts held for the next planner turn. Only the newest carries the ×:
  // unsend always takes the newest, as Esc does, so it never promises another.
  const pending = useMemo((): PendingMessage[] => held.map((text, index) => ({
    key: String(index),
    text,
    state: 'queued',
    onRemove: index === held.length - 1 ? () => handleUnsend(composerEmptyRef.current) : undefined,
    removeTitle: 'Take back (Esc)',
  })), [held, handleUnsend]);

  const stopTurn = useCallback(() => {
    dispatch({ type: 'turnStopped' });
    bridge.post({ type: 'stopResearch' });
  }, []);

  // Esc during a planner turn, in order of intent: take back the newest queued
  // prompt, else arm a stop, else commit it. Outside a turn it is the input's.
  // The stop is the turn's even mid-run: Esc Esc never halts the tasks.
  const handleEscape = useCallback((composerEmpty: boolean): boolean => {
    if (expandedTaskId !== null) {
      setExpandedTaskId(null);
      return true;
    }
    if (!plannerBusy) return false;
    if (held.length > 0) {
      setStopArmed(false);
      handleUnsend(composerEmpty);
    } else if (stopArmed) {
      setStopArmed(false);
      stopTurn();
    } else {
      setStopArmed(true);
    }
    return true;
  }, [expandedTaskId, plannerBusy, held, stopArmed, handleUnsend, stopTurn]);

  // Esc closes an open card first, wherever in this app focus is. Inner
  // handlers (card editors, pickers, the input) mark theirs with
  // preventDefault, so one Esc does one thing. A host that draws other layers
  // beside the app (the desktop's drawers and dialogs) keeps their Esc theirs.
  useEffect(() => {
    if (expandedTaskId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const root = (chatContainerRef.current ?? planListRef.current)?.parentElement;
      const target = e.target instanceof Node ? e.target : null;
      if (root && target && target !== document.body && !root.contains(target)) return;
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

  // Kept with the children's answers, not in the card: the card closes when an
  // answer is given, and a refusal can come when the question has moved on.
  const rootAnswers = childAnswers.of({ sessionId: ROOT_ANSWERS, title: checkpoint?.taskTitle ?? '' });

  const handleApproveCheckpoint = (words?: string, raiseTokens?: number) => {
    if (!checkpoint) return;
    dispatch({ type: 'checkpointAnswered', answerId: rootAnswers.give(checkpoint.taskId, { question: checkpoint.summary, answer: 'approve', words, raiseTokens }) });
  };

  const handleRejectCheckpoint = (reason: string) => {
    if (!checkpoint) return;
    // Reject resumes the paused agent with the reason (rather than cancelling
    // the task), and the panel is torn down immediately — leaving a decision
    // box on screen after the decision is made asks the user to answer twice.
    dispatch({ type: 'checkpointAnswered', answerId: rootAnswers.give(checkpoint.taskId, { question: checkpoint.summary, answer: 'reject', words: reason }) });
  };

  // The host owns every isolation action: opening the diff, and the merge,
  // discard and cleanup that touch the user's real branches.
  const handleIsolationAction = useCallback((action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict', taskId?: string) => {
    bridge.post({ type: 'isolationAction', action, taskId });
  }, []);

  const handleDockResize = useCallback((height: number) => {
    setDockHeight(height);
    bridge.post({ type: 'setPlanDockHeight', height });
  }, []);
  const handleShowPlan = useCallback(() => setDockExpanded((v) => nextDock(v, 'user-expanded')), []);

  const handleResolveConflict = useCallback((taskId: string) => {
    handleIsolationAction('resolveConflict', taskId);
  }, [handleIsolationAction]);

  // Only what is happening now; an idle composer shows a command tip instead (#137).
  const getPlaceholder = (): string | undefined => {
    if (compacting) return 'Queue a message for when the context is compacted...';
    if (isResearchActive) return 'Queue a message for when the planner is done...';
    if (isExecuting) return 'AI is working...';
    if (isStarting) return 'Starting the plan...';
    return undefined;
  };

  // With no plan yet, the last word the planner had is what a reply answers.
  // The tip has taken the placeholder, so this cue sits under the input instead
  // of replacing it (#137).
  const replyCue = (): string | undefined => {
    if (getPlaceholder() !== undefined) return undefined;
    if (plan && plan.tasks.length > 0) return undefined;
    // The usage line always sits last (core keeps it there), so look for the
    // last thing said rather than the last block. A later user message answers
    // the planner, and streaming text is not a settled reply yet.
    const last = [...blocks].reverse().find((b) => b.type === 'message');
    return last?.type === 'message' && last.role === 'planner' && !last.streaming
      ? 'Reply to the planner'
      : undefined;
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
    bridge.post({ type: 'setPlannerModel', modelId: assignment.modelId, effort: assignment.thinkingEffort });
  }, []);

  const handleSettingsChange = useCallback((change: SettingsChange) => {
    bridge.post({ type: 'changeSettings', change });
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
    bridge.post({ type: 'setPlanner', provider });
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
    bridge.post({ type: 'loginPlanner', runner });
  }, []);

  /**
   * What each signed-out agent's surfaces say and what their Log in does, keyed
   * by runner id. The words are the terminal UI's, since this chat takes the
   * same `/login <runner>` and `/key` (ADR-0052).
   */
  const signInByRunner = useMemo<Record<string, RunnerSignInView>>(() => {
    const byRunner: Record<string, RunnerSignInView> = {};
    for (const backend of planner.backends) {
      const runner = backend.runner ?? backend.id;
      if (backend.auth?.state !== 'signed-out') continue;
      const signIn: RunnerSignIn | undefined = signInOfVerdict(runner, backend.label, backend.auth);
      const hint = describeRunnerSignIn({ state: 'signed-out', ...(signIn ? { signIn } : {}) }, TERMINAL_UI_SIGN_IN)
        ?? `${backend.label} is not signed in.`;
      const action = signInAction(signIn);
      const provider = signIn?.key?.provider;
      byRunner[runner] = {
        label: backend.label,
        hint,
        ...(action === 'login' ? { logIn: () => handleRunnerLogin(runner) } : {}),
        // A key needs no runner process, so nothing waits on it: the key entry is the whole action.
        ...(action === 'key' && provider ? { logIn: () => bridge.post({ type: 'sendMessage', text: `/key ${provider}`, runners }) } : {}),
      };
    }
    return byRunner;
  }, [planner.backends, handleRunnerLogin, runners]);


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
          hint: signInByRunner[runner]?.hint,
          ...(signInByRunner[runner]?.logIn ? { onLogIn: signInByRunner[runner].logIn } : {}),
        };
      });
    // Stable sort: the active planner first, everything else as the host listed it.
    return rows.sort((a, b) => Number(b.id === activePlanner) - Number(a.id === activePlanner));
  }, [planner.backends, activePlanner, pendingLogin, loginFailure, signInByRunner]);

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

  /** The plan's cards and run controls: the dock's body, or a surface's whole plan view. */
  const renderPlanBody = () => {
    if (!plan) return null;
    return (
      <>
      {checkpoint && (
        <CheckpointPanel
          taskTitle={checkpoint.taskTitle}
          summary={checkpoint.summary}
          pausedAt={checkpoint.pausedAt}
          delegated={delegationOffered && checkpoint.delegated}
          draft={rootAnswers.draft(checkpoint.taskId, checkpoint.summary)}
          onDraft={(draft) => rootAnswers.edit(checkpoint.taskId, checkpoint.summary, draft)}
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
      <PlanCardGroup
        expandedTaskId={expandedTaskId}
        onExpandedTaskChange={setExpandedTaskId}
        // A surface task carries its skills as notices, without bodies. No
        // card reads them, but the cards and core's row helpers still type
        // their argument as a whole Task.
        tasks={plan.tasks as Task[]}
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
        runnerSignIn={signInByRunner}
        onSkip={handleSkip}
        onCancel={handleCancel}
        onCancelResume={handleCancelResume}
        onResumeNow={handleResumeNow}
        onForceStart={handleForceStart}
        onMarkComplete={handleMarkComplete}
        onMarkIncomplete={handleMarkIncomplete}
        onRevert={handleRevert}
        onExecutePlan={handleExecutePlan}
        onStopExecution={handleStopExecution}
        onApproveAll={handleApproveAll}
        onRunTask={handleRunTask}
        onSendMessage={handleTaskMessage}
        onSendMessageNow={handleTaskMessageNow}
        onResolveConflict={handleResolveConflict}
        onOpenLog={handleOpenTaskLog}
        onOpenChild={(taskId) => setChildChoice(taskId)}
        // The tall panel beside the conversation: the title bar holds Run and Stop, and the header its progress.
        rows={layout === 'plan'}
        goal={goal}
        runControls={layout !== 'plan'}
      />
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
      {isExecuting && layout !== 'plan' && (
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
      </>
    );
  };

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
          {runSettingsSummary(host.runSettings?.run, plan.runSettings, isExecuting, delegationOffered)}
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
          {renderPlanBody()}
        </div>
      </div>
    );
  };

  const openChild = (childId: string) => {
    childLeft.current = false;
    childOpener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setChildChoice(null);
    setChildConversation(EMPTY_PATCHED_VIEW);
    setChildNotice(NO_CHILD_NOTICE);
    bridge.post({ type: 'openChild', childId });
  };
  const leaveChild = () => {
    childLeft.current = true;
    bridge.post({ type: 'closeChild' });
    setChildView(null);
    setChildChoice(null);
    setChildConversation(EMPTY_PATCHED_VIEW);
    setChildNotice(NO_CHILD_NOTICE);
  };

  if (layout === 'plan') {
    return (
      <DelegationOfferedContext.Provider value={delegationOffered}>
      <OpenPatchContext.Provider value={handleOpenPatch}>
      <div className="plan-list" ref={planListRef}>
        {plan && plan.tasks.length > 0
          ? renderPlanBody()
          : <p className="plan-list-empty">No plan yet. Describe a goal to the planner.</p>}
      </div>
      </OpenPatchContext.Provider>
      </DelegationOfferedContext.Provider>
    );
  }

  return (
    <DelegationOfferedContext.Provider value={delegationOffered}>
    <OpenPatchContext.Provider value={handleOpenPatch}>
    {/* Focus targets for a mouse selection, never tab stops. VS Code 1.143+
        answers a Cmd/Ctrl+C in a webview by refocusing the last-focused
        element before it copies whenever focus sits on <body>, and here that
        is the composer, whose focus wipes the selection. A drag in the
        conversation or the footer now focuses one of these instead, so focus
        never rests on <body>. The list is its own target so arrow keys and
        Page Down still scroll it after a click. */}
    {childView && <ChildPlanPanel
      key={childView.child.sessionId}
      view={childView}
      tree={childTree.children}
      conversation={childConversation}
      notice={childNotice}
      composer={childComposer(childView.child)}
      answers={childAnswers.of(childView.child)}
      rootQuestion={checkpoint?.taskTitle}
      post={bridge.post}
      onOpen={openChild}
      // The depth, not the root id: the tree may not have been told yet.
      onBack={() => { if (childView.child.depth <= 1) leaveChild(); else openChild(childView.child.parent); }}
      onRootQuestion={() => { leaveChild(); setDockExpanded(true); }}
    />}
    {/* Hidden, not unmounted: the composer's draft and the scroll position are the root's own. */}
    <SpeakerLabelsContext.Provider value={layout === 'conversation'}>
    <div className={`chat-container chat-layout-${layout}`} tabIndex={-1} hidden={inChild} ref={chatContainerRef}>
      {!inChild && childNotice.message && <p role="status">{childNotice.message}</p>}
      <ChildQuestions tree={childTree.children} onOpen={openChild} />
      {/* A refusal can come after the child plan has closed, with no panel left to read the words in. */}
      {!inChild && <UndeliveredAnswers
        items={childAnswers.stranded({
          inTree: (childId) => childTree.children.some((entry) => entry.sessionId === childId),
          offered: (taskId, question) => checkpoint?.taskId === taskId && checkpoint.summary === question,
        })}
        named
        onDismiss={childAnswers.dismiss}
      />}
      {childChoice && <div role="region" aria-label="Subplanner sessions">
        <button type="button" onClick={() => setChildChoice(null)}>Close</button>
        {childTree.children.filter((entry) => entry.parent === childTree.rootId && entry.taskId === childChoice).map((entry) =>
          <button type="button" key={entry.sessionId} onClick={() => openChild(entry.sessionId)}>{entry.title} · {entry.state}</button>)}
        {!childTree.children.some((entry) => entry.parent === childTree.rootId && entry.taskId === childChoice) && <p>No child plan has started.</p>}
      </div>}
      <div className="setup-panel">
        <button
          type="button"
          className={`setup-panel-toggle${setupCollapsed ? '' : ' open'}`}
          aria-expanded={!setupCollapsed}
          onClick={() => { setupChosen.current = true; setSetupCollapsed((v) => !v); }}
          title={
            activeBackend?.auth?.state === 'signed-out'
              ? signInByRunner[activeBackend.runner ?? activeBackend.id]?.hint
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
                  const way = signedOut ? signInByRunner[runnerId] : undefined;
                  const canLogIn = way?.logIn !== undefined;
                  return (
                    <span className={`planner-pill-item${canLogIn ? ' has-login' : ''}`} key={b.id} data-runner={runnerId}>
                      <span className={`planner-pill-group${signedOut ? ' signed-out' : ''}${b.id === activePlanner ? ' active' : ''}`}>
                        <button
                          type="button"
                          className={`planner-pill${b.id === activePlanner ? ' active' : ''}${signedOut ? ' signed-out' : ''}${pendingPlanner === b.id ? ' pending' : ''}`}
                          title={way ? way.hint : b.reason}
                          onClick={() => handlePlannerChange(b.id)}
                        >
                          {signedOut && <span className="planner-auth-dot" aria-hidden="true" />}
                          {b.label}
                        </button>
                        {canLogIn && (
                          <PlannerLoginAction
                            className="planner-pill-login"
                            onLogIn={() => way?.logIn?.()}
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
                    ? (runnerDiscoveryErrors[planner.runner] ?? <>No models discovered for this agent yet: run <code>/refresh</code>.</>)
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
                : <Detecting error={detectionError} onRetry={handleModelsRefreshNeeded} />}
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
              const way = signedOut ? signInByRunner[r.id] : undefined;
              const canLogIn = way?.logIn !== undefined;
              const title = way
                ? way.hint
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
                        onLogIn={() => way?.logIn?.()}
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
              <span className="setup-block-empty"><Detecting error={detectionError} onRetry={handleModelsRefreshNeeded} /></span>
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
            {detectionError === null && <div className="loading-pulse" />}
            <p><Detecting error={detectionError} onRetry={handleModelsRefreshNeeded} /></p>
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

        {/* The desktop's planner tab answers a draft where it is read (W3); VS
            Code's sidebar answers it in the plan dock below. */}
        {layout === 'conversation' && plan && plan.tasks.length > 0 && (plan.status === 'draft' || plan.status === 'rejected')
          && !isExecuting && !isStarting && !plannerBusy && (
          <PlanApprovalCard
            tasks={plan.tasks}
            isolationPreview={host.isolationPreview}
            runSettings={host.runSettings}
            settings={runSettingsSummary(host.runSettings?.run, plan.runSettings, isExecuting, delegationOffered)}
            onApprove={requestStart}
            onAskForChanges={() => chatContainerRef.current?.querySelector<HTMLTextAreaElement>('.chat-input-wrapper textarea')?.focus()}
            onEditSettings={() => setOwnSettingsRequest((n) => n + 1)}
          />
        )}
      </div>

      {layout === 'chat' && renderPlanDock()}

      <UsageLine
        block={usageBlock}
        limits={accountLimitsOf(accountLimits, planner.runner, modelConfig?.orchestrator)}
        inbox={inboxView.enabled && ((run.escalations ?? []).length > 0 || escalationAnswers.refusals.length > 0)
          ? <EscalationInbox escalations={run.escalations ?? []} answers={escalationAnswers} open={inboxView.open} onToggle={handleToggleInbox} onOpenTask={handleOpenEscalatedTask} />
          : undefined}
      />

      {/* Pinned rather than the list's last row, and drawn for the whole turn:
          a turn can go minutes with nothing new to show, its thinking block
          still marked streaming while the model writes a tool call's input,
          and a reader scrolled back up would not see a row in the list. */}
      {isResearchActive && !compacting && (
        <div className="chat-msg-working" role="status">
          <span className="chat-msg-spinner" aria-hidden="true" /> {plannerDetecting ? DETECTING : <>Working&hellip;</>}
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

      <PendingMessages messages={pending} onSendAllNow={plannerBusy ? handleSendHeldNow : undefined} />

      <ChatInput
        key={composerSession}
        onSend={handleSend}
        onSendNow={handleSendNow}
        heldCount={held.length}
        onEmptyChange={handleComposerEmpty}
        onStop={stopTurn}
        onEscape={handleEscape}
        disabled={false}
        placeholder={getPlaceholder()}
        hint={replyCue()}
        isTurnRunning={plannerBusy}
        unsent={unsent}
        skills={skills}
      />
    </div>
    </SpeakerLabelsContext.Provider>
    </OpenPatchContext.Provider>
    </DelegationOfferedContext.Provider>
  );
}
