import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import EmptyState from './components/EmptyState';
import GetStarted from './components/GetStarted';
import ChatInput from './components/ChatInput';
import ChatMessage from './components/ChatMessage';
import { applyToolResult, previewResult, type Activity } from './activity';
import { appendTaskOutput, type TaskOutputMap } from './taskOutput';
import ModelSelector, { API_PROVIDER_LABELS } from './components/ModelSelector';
import PlanCardGroup from './components/PlanCardGroup';
import CheckpointPanel from './components/CheckpointPanel';
import type { RunnerMode } from './components/TaskCard';
import type { TaskDraft } from './components/NewTaskCard';
import { LegacyPlanState, DiscoveredModel, TaskModelAssignment, RunnerId } from '@ordewell/core';
import type { AiProvider } from '@ordewell/core';
import { summarizeToolCall } from '@ordewell/core/plan-utils';
import { isPlanRevision, planSummaryLabel, nextDock } from './planDock';
import type { RunnerMeta, PlannerBackend } from '../../providers/ChatViewProvider';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface RunnerInfo {
  id: string;
  displayName: string;
}

/**
 * One entry in the strictly sequential chat timeline. Everything the user
 * sees — their requests, the planner's thinking, its command executions, and its
 * messages — renders top-to-bottom in arrival order.
 *
 * The plan itself is NOT one of these. It is a live, editable artifact, so it is
 * mounted once in the dock; what appears in the timeline is a `planRevision`
 * chip per commit, which is what makes a chat-driven edit visible at the point
 * in the conversation that caused it.
 */
type TimelineItem =
  | { id: string; kind: 'user'; text: string; timestamp: number }
  | { id: string; kind: 'planner'; activities: Activity[]; text: string; streaming: boolean; interrupted?: boolean; timestamp: number }
  | { id: string; kind: 'system'; text: string; timestamp: number }
  | { id: string; kind: 'planRevision'; label: string; timestamp: number };

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

export default function App() {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [plan, setPlan] = useState<LegacyPlanState | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isResearchActive, setIsResearchActive] = useState(false);
  const [error, setError] = useState<string>('');
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [modelsByRunner, setModelsByRunner] = useState<Partial<Record<string, DiscoveredModel[]>>>({});
  const [runnerList, setRunnerList] = useState<RunnerInfo[]>([]);
  const [enabledRunnerIds, setEnabledRunnerIds] = useState<string[]>(['claude-code']);
  const [runners, setRunners] = useState<RunnerId[]>(['claude-code']);
  const [queueCount, setQueueCount] = useState(0);
  const [, setCurrentGoal] = useState<string>('');
  const [showModelInfo, setShowModelInfo] = useState(false);
  const [slashOutput, setSlashOutput] = useState('');
  const [modesByRunner, setModesByRunner] = useState<Record<string, RunnerMode[]>>({});
  const [modelConfig, setModelConfig] = useState<{ orchestrator: string; orchestratorProvider?: string } | null>(null);
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>([]);
  const [configuredProviders, setConfiguredProviders] = useState<AiProvider[]>([]);
  /** Who plans (ADR-0009): the backends offered, the one in use, and its runner + effort. */
  const [planner, setPlanner] = useState<{
    backends: PlannerBackend[];
    provider: string;
    runner?: string;
    effort?: string;
  }>({ backends: [], provider: '' });
  const [isReady, setIsReady] = useState(false);
  const [, setModelApiMapping] = useState<Record<string, AiProvider[]>>({});
  const [modelDiscoveryErrors, setModelDiscoveryErrors] = useState<Record<string, string>>({});
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [tddEnabled, setTddEnabled] = useState(true);
  const [verifyEnabled, setVerifyEnabled] = useState(false);
  /** Discovered skills (~/.ordewell/skills/ + .ordewell/skills/) for the /skill-name suggestion dropdown. */
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [checkpoint, setCheckpoint] = useState<{ taskId: string; taskTitle: string; summary: string; pausedAt: number } | null>(null);
  const [taskOutput, setTaskOutput] = useState<TaskOutputMap>({});
  /** Advisory silence timestamp per task id, keyed like taskOutput; null/absent means not stalled. */
  const [taskIdle, setTaskIdle] = useState<Record<string, string | null>>({});
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  /** Is the plan dock open? See planDock.ts for when this flips. */
  const [dockExpanded, setDockExpanded] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef(false);
  const stoppedRef = useRef(false);
  const sessionClearedRef = useRef(false);
  const stopFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef(Date.now());
  const planRef = useRef(plan);
  planRef.current = plan;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const userPinnedToBottomRef = useRef(true);

  const isGenerating = isResearchActive || isExecuting;

  useEffect(() => {
    processingRef.current = isResearchActive || isExecuting;
  }, [isResearchActive, isExecuting]);

  const isNearBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < 50;

  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;

    const handleScroll = () => {
      userPinnedToBottomRef.current = isNearBottom(el);
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (userPinnedToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [timeline]);

  /** Mutate the trailing streaming planner item (creating one if needed). */
  const updateActivePlanner = useCallback((fn: (item: Extract<TimelineItem, { kind: 'planner' }>) => Extract<TimelineItem, { kind: 'planner' }>) => {
    setTimeline((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === 'planner' && last.streaming) {
        return [...prev.slice(0, -1), fn(last)];
      }
      const fresh: Extract<TimelineItem, { kind: 'planner' }> = {
        id: nextId('planner'), kind: 'planner', activities: [], text: '', streaming: true, timestamp: Date.now(),
      };
      return [...prev, fn(fresh)];
    });
  }, []);

  /** Stop streaming on the trailing planner item, optionally replacing its text. */
  const finalizePlanner = useCallback((opts?: { text?: string; interrupted?: boolean; dropIfEmpty?: boolean }) => {
    setTimeline((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.kind !== 'planner' || !last.streaming) {
        // No active turn (e.g. a message pushed by the host after a reload) —
        // append it as a fresh, completed planner message.
        if (opts?.text) {
          return [...prev, { id: nextId('planner'), kind: 'planner', activities: [], text: opts.text, streaming: false, timestamp: Date.now() }];
        }
        return prev;
      }
      const text = opts?.text !== undefined ? opts.text : last.text;
      if (opts?.dropIfEmpty && !text.trim() && last.activities.length === 0) {
        return prev.slice(0, -1);
      }
      return [...prev.slice(0, -1), { ...last, text, streaming: false, interrupted: opts?.interrupted ?? last.interrupted }];
    });
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      lastActivityRef.current = Date.now();
      switch (msg.type) {
        case 'setState':
          if (msg.state === 'empty') {
            setError('');
            setPlan(null);
            setTimeline([]);
            setCheckpoint(null);
            setTaskOutput({});
            setDockExpanded((v) => nextDock(v, 'session-reset'));
          }
          setIsResearchActive(msg.state === 'researching');
          setIsExecuting(msg.state === 'approved');
          break;

        case 'showPlan':
        case 'planUpdated': {
          if (stoppedRef.current) break;
          const incoming: LegacyPlanState | null = msg.plan ?? null;
          setPlan(incoming);
          setIsResearchActive(false);
          if (incoming) {
            setIsExecuting(incoming.status === 'running');
          }
          if (incoming && incoming.tasks && incoming.tasks.length > 0) {
            // The streamed text was the plan JSON — the task cards replace it.
            finalizePlanner({ text: '', dropIfEmpty: true });
            // One `planUpdated` carries two different events. A revision earns a
            // chip and opens the dock; a status tick during execution must do
            // neither, or a running plan would spam the transcript and fight a
            // user who collapsed the dock.
            const previous = planRef.current?.tasks ?? [];
            if (isPlanRevision(previous, incoming.tasks)) {
              setTimeline((prev) => {
                const first = !prev.some((i) => i.kind === 'planRevision');
                const count = incoming.tasks.length;
                return [...prev, {
                  id: nextId('revision'),
                  kind: 'planRevision',
                  label: `Plan ${first ? 'generated' : 'updated'} · ${count} task${count === 1 ? '' : 's'}`,
                  timestamp: Date.now(),
                }];
              });
              setDockExpanded((v) => nextDock(v, 'plan-revised'));
            } else {
              setDockExpanded((v) => nextDock(v, 'plan-progressed'));
            }
          }
          break;
        }

        case 'newMessage': {
          // A planner conversation message (question, outline, PRD preview…).
          // It finalizes the streaming turn: the streamed text and the final
          // content are the same message.
          if (sessionClearedRef.current) break;
          finalizePlanner({ text: msg.message.content });
          setIsResearchActive(false);
          // A completed turn ends any prior stop-gate — later streams belong
          // to new turns and must render.
          stoppedRef.current = false;
          break;
        }

        case 'restoreChat': {
          // Authoritative timeline rebuild from the persisted dialogue (session
          // load, webview reload, window restore). Also clears stuck state: a
          // restore always leaves the chat usable. The plan is cleared here so a
          // session with no tasks does not keep the previously-loaded session's
          // plan cards — a follow-up planUpdated/showPlan repopulates it when
          // the restored session has tasks.
          stoppedRef.current = false;
          sessionClearedRef.current = false;
          setIsResearchActive(false);
          setIsExecuting(false);
          setError('');
          setCheckpoint(null);
          setPlan(null);
          setTaskOutput({});
          setDockExpanded((v) => nextDock(v, 'session-reset'));
          const history: { role: string; content: string; timestamp: string; kind?: string }[] = msg.history ?? [];
          const items: TimelineItem[] = [];
          for (const m of history) {
            const ts = new Date(m.timestamp).getTime() || Date.now();
            if (m.kind === 'plan_generated') {
              // Every marker gets its own chip. Folding them into one anchor
              // (which is what the plan-as-chat-message layout had to do) threw
              // away the order the plan was revised in — the one thing the
              // transcript is for.
              const first = !items.some((i) => i.kind === 'planRevision');
              items.push({
                id: nextId('revision'),
                kind: 'planRevision',
                label: `Plan ${first ? 'generated' : 'updated'}`,
                timestamp: ts,
              });
              continue;
            }
            if (m.kind === 'system') {
              items.push({ id: nextId('sys'), kind: 'system', text: m.content, timestamp: ts });
            } else if (m.role === 'user') {
              items.push({ id: nextId('user'), kind: 'user', text: m.content, timestamp: ts });
            } else {
              items.push({ id: nextId('planner'), kind: 'planner', activities: [], text: m.content, streaming: false, timestamp: ts });
            }
          }
          // Sessions saved before plan markers existed: one chip at the end.
          if (msg.hasPlan && !items.some((i) => i.kind === 'planRevision')) {
            items.push({ id: nextId('revision'), kind: 'planRevision', label: 'Plan generated', timestamp: Date.now() });
          }
          setTimeline(items);
          break;
        }

        case 'showWarnings':
          if (sessionClearedRef.current) break;
          // A modify that produced warnings still ends the turn — without this
          // the input stayed disabled forever.
          setIsResearchActive(false);
          finalizePlanner({ dropIfEmpty: true });
          setTimeline((prev) => [...prev, { id: nextId('sys'), kind: 'system', text: `Plan modification warnings:\n${msg.warnings ?? ''}`, timestamp: Date.now() }]);
          break;

        case 'showError':
          if (sessionClearedRef.current) break;
          setError(msg.error || msg.message || '');
          setIsResearchActive(false);
          finalizePlanner({ dropIfEmpty: true });
          break;

        case 'streamToken':
          if (stoppedRef.current) break;
          setIsResearchActive(true);
          updateActivePlanner((item) => ({ ...item, text: item.text + msg.token }));
          break;

        case 'taskOutput':
          setTaskOutput((prev) => appendTaskOutput(prev, msg.taskId, msg.text ?? ''));
          break;

        case 'taskIdle':
          setTaskIdle((prev) => ({ ...prev, [msg.taskId]: msg.idleSince }));
          break;

        case 'researchProgress': {
          if (stoppedRef.current) break;
          const progress = msg.step || msg.progress;
          setIsResearchActive(true);

          if (progress.type === 'thinking' && progress.text) {
            updateActivePlanner((item) => {
              if (progress.subagentId) {
                // Reasoning from within a subagent nests under its own block,
                // independently expandable — never the top-level thinking trace.
                const idx = item.activities.findIndex((a) => a.id === progress.subagentId && a.type === 'subagent');
                if (idx >= 0) {
                  const subagent = item.activities[idx];
                  const children = subagent.children ?? [];
                  const last = children[children.length - 1];
                  const nextChildren = last && last.type === 'thinking'
                    ? [...children.slice(0, -1), { ...last, text: last.text + progress.text }]
                    : [...children, { id: nextId('think'), type: 'thinking' as const, text: progress.text }];
                  const next = [...item.activities];
                  next[idx] = { ...subagent, children: nextChildren };
                  return { ...item, activities: next };
                }
              }
              const last = item.activities[item.activities.length - 1];
              if (last && last.type === 'thinking') {
                return { ...item, activities: [...item.activities.slice(0, -1), { ...last, text: last.text + progress.text }] };
              }
              return { ...item, activities: [...item.activities, { id: nextId('think'), type: 'thinking', text: progress.text }] };
            });
          }
          if (progress.type === 'tool_call' && progress.tool) {
            updateActivePlanner((item) => {
              // Prose streamed before a command is the model thinking out loud
              // (models without a reasoning channel narrate between tool calls).
              // Fold it into a thinking dropdown at this point in the timeline,
              // so commands and thinking stay interleaved in execution order
              // instead of all prose pooling below the activity list.
              let activities = item.activities;
              let text = item.text;
              if (text.trim()) {
                const last = activities[activities.length - 1];
                activities = last && last.type === 'thinking'
                  ? [...activities.slice(0, -1), { ...last, text: `${last.text}\n${text}` }]
                  : [...activities, { id: nextId('think'), type: 'thinking' as const, text }];
                text = '';
              }

              if (progress.subagentId && progress.tool === 'spawn_research_agent') {
                // Initiating call for a new research subagent (issue #34): its own
                // expandable block, nested activities collected as they arrive.
                const label = summarizeToolCall(progress.tool, progress.toolArgs || '{}');
                return {
                  ...item, text,
                  activities: [...activities, { id: progress.subagentId, type: 'subagent' as const, text: label, children: [] }],
                };
              }

              if (progress.subagentId) {
                // An inner tool call made by that subagent — nest it under its block.
                const idx = activities.findIndex((a) => a.id === progress.subagentId && a.type === 'subagent');
                if (idx >= 0) {
                  const subagent = activities[idx];
                  const child: Activity = { id: nextId('call'), type: 'tool_call', text: `${progress.tool}`, tool: progress.tool, toolArgs: progress.toolArgs, toolCallId: progress.toolCallId };
                  const next = [...activities];
                  next[idx] = { ...subagent, children: [...(subagent.children ?? []), child] };
                  return { ...item, text, activities: next };
                }
              }

              return {
                ...item,
                text,
                activities: [...activities, {
                  // A harness planner's own tool name wins over the member it
                  // mapped to, so the card says `Edit`, never `agent_tool`.
                  id: nextId('call'), type: 'tool_call' as const, text: progress.toolLabel || `${progress.tool}`, tool: progress.tool, toolArgs: progress.toolArgs, toolCallId: progress.toolCallId,
                }],
              };
            });
          }
          if (progress.type === 'tool_result' && progress.step) {
            const step = progress.step;
            const update = {
              tool: step.tool,
              toolCallId: progress.toolCallId ?? step.toolCallId,
              summary: summarizeToolCall(step.tool, step.args, step.toolLabel),
              resultText: previewResult(step.result ?? ''),
              outcome: step.outcome,
              fallbackId: step.id || nextId('result'),
            };
            // Fold the result into its command line — one entry per execution.
            updateActivePlanner((item) => {
              if (progress.subagentId) {
                const idx = item.activities.findIndex((a) => a.id === progress.subagentId && a.type === 'subagent');
                if (idx >= 0) {
                  const subagent = item.activities[idx];
                  const next = [...item.activities];
                  next[idx] = step.tool === 'spawn_research_agent'
                    // The subagent's own completion: mark done, attach its digest.
                    ? { ...subagent, done: true, outcome: step.outcome, resultText: step.result }
                    // An inner tool result: fold into the matching pending child.
                    : { ...subagent, children: applyToolResult(subagent.children ?? [], update) };
                  return { ...item, activities: next };
                }
              }
              return { ...item, activities: applyToolResult(item.activities, update) };
            });
          }
          if (progress.type === 'plan_token' && progress.planToken) {
            updateActivePlanner((item) => ({ ...item, text: item.text + progress.planToken }));
          }
          break;
        }

        case 'plannerInterrupted':
          if (sessionClearedRef.current) break;
          if (stopFallbackRef.current) { clearTimeout(stopFallbackRef.current); stopFallbackRef.current = null; }
          setIsResearchActive(false);
          if (msg.message?.content) {
            finalizePlanner({ text: msg.message.content, interrupted: true });
          } else {
            finalizePlanner({ interrupted: true, dropIfEmpty: true });
          }
          // The interrupted turn is closed; stop gating subsequent streams.
          stoppedRef.current = false;
          break;

        case 'setModels':
          setModels(msg.models ?? []);
          break;

        case 'setModelsByRunner':
          setModelsByRunner(msg.modelsByRunner ?? {});
          break;

        case 'setModesByRunner':
          setModesByRunner(msg.modesByRunner ?? {});
          break;

        case 'setModelConfig':
          setModelConfig(msg.modelConfig ?? null);
          break;

        case 'setModelOptions':
          setModelOptions(msg.modelOptions ?? []);
          break;

        case 'setConfiguredProviders':
          setConfiguredProviders(msg.providers ?? []);
          setIsReady(true);
          break;

        case 'setPlannerBackends':
          setPlanner({
            backends: msg.backends ?? [],
            provider: msg.provider ?? '',
            runner: msg.runner,
            effort: msg.effort || undefined,
          });
          break;

        case 'setModelDiscoveryErrors':
          setModelDiscoveryErrors(msg.errors ?? {});
          break;
        case 'setModelApiMapping':
          setModelApiMapping(msg.modelApiMapping ?? {});
          break;

        case 'setRunners': {
          const list = msg.runners ?? [];
          const ids = list.filter((r: RunnerMeta) => r.enabled).map((r: RunnerMeta) => r.id);
          setRunnerList(list.map((r: RunnerMeta) => ({ id: r.id, displayName: r.displayName })));
          setEnabledRunnerIds(ids);
          setRunners((prev) => {
            if (ids.length === 1) return ids;
            if (ids.length === 0) return ['claude-code'];
            const valid = prev.filter((r) => ids.includes(r));
            return valid.length > 0 ? valid : ids;
          });
          break;
        }

        case 'setEnabledRunnerIds': {
          const ids = msg.enabledRunnerIds ?? [];
          setEnabledRunnerIds(ids);
          setRunners((prev) => {
            if (ids.length === 1) return ids;
            if (ids.length === 0) return ['claude-code'];
            const valid = prev.filter((r) => ids.includes(r));
            return valid.length > 0 ? valid : ids;
          });
          break;
        }

        case 'setRunnerList': {
          setRunnerList(msg.runnerList ?? []);
          break;
        }

        case 'executionStatus':
          if (msg.status === 'in_progress') setIsExecuting(true);
          break;

        case 'queueStatus':
          setQueueCount(msg.count ?? msg.queueCount ?? 0);
          break;

        case 'setGoal':
          setCurrentGoal(msg.goal ?? '');
          break;

        case 'focusTask':
          break;

        case 'setSkillToggles':
          if (msg.toggles) {
            setTddEnabled(msg.toggles.tdd ?? true);
            setVerifyEnabled(msg.toggles.verify ?? false);
          }
          break;

        case 'setSkills':
          setSkills(msg.skills ?? []);
          break;

        case 'checkpoint':
          setCheckpoint({
            taskId: msg.taskId ?? '',
            taskTitle: msg.taskTitle ?? '',
            summary: msg.summary ?? '',
            pausedAt: Date.now(),
          });
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [finalizePlanner, updateActivePlanner]);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const fallback = setTimeout(() => setIsReady(true), 4000);
    return () => clearTimeout(fallback);
  }, []);

  const pushSystem = useCallback((text: string) => {
    setTimeline((prev) => [...prev, { id: nextId('sys'), kind: 'system', text, timestamp: Date.now() }]);
  }, []);

  // Watchdog: if the planner is "working" but nothing has arrived from the
  // host for a long stretch (a terminal message was lost, the turn died
  // silently), unlock the input instead of leaving the chat bricked. The
  // window is generous — non-streaming providers can legitimately stay quiet
  // for a minute while a model thinks.
  const WATCHDOG_MS = 120_000;
  useEffect(() => {
    if (!isResearchActive) return;
    lastActivityRef.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActivityRef.current < WATCHDOG_MS) return;
      setIsResearchActive(false);
      finalizePlanner({ interrupted: true, dropIfEmpty: true });
      setTimeline((prev) => [...prev, {
        id: nextId('sys'), kind: 'system',
        text: 'The planner stopped responding, so the input was re-enabled. Your last message may not have been processed — try sending it again.',
        timestamp: Date.now(),
      }]);
    }, 5_000);
    return () => clearInterval(timer);
  }, [isResearchActive, finalizePlanner]);

  const handleNewSession = useCallback(() => {
    stoppedRef.current = true;
    sessionClearedRef.current = true;
    if (stopFallbackRef.current) { clearTimeout(stopFallbackRef.current); stopFallbackRef.current = null; }
    setTimeline([]);
    setPlan(null);
    setIsResearchActive(false);
    setIsExecuting(false);
    setError('');
    setCheckpoint(null);
    setTaskOutput({});
    setDockExpanded((v) => nextDock(v, 'session-reset'));
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
      const hasContent = timelineRef.current.length > 0 || planRef.current !== null;
      if ((hasContent || processingRef.current) && !showNewSessionConfirm) {
        setShowNewSessionConfirm(true);
        return;
      }
      setShowNewSessionConfirm(false);
      handleNewSession();
      return;
    }
    if (text === '/help') {
      setSlashOutput('Commands: /model, /model set <id>, /key set, /sessions, /new, /refresh, /auto, /allowlist, /help\n\nType / after a command to see model suggestions.');
      setTimeout(() => setSlashOutput(''), 6000);
      return;
    }

    if (text.startsWith('retry ')) {
      const taskId = text.slice(6).trim();
      setPrefill(undefined);
      setTimeline((prev) => [...prev, { id: nextId('user'), kind: 'user', text, timestamp: Date.now() }]);
      vscode.postMessage({
        type: 'sendMessage',
        text: text.trim(),
        runners,
        actionContext: { type: 'retry', taskId },
      });
      return;
    }

    if (text.startsWith('/')) {
      setTimeline((prev) => [...prev, { id: nextId('user'), kind: 'user', text, timestamp: Date.now() }]);
      vscode.postMessage({ type: 'sendMessage', text, runners });
      return;
    }

    setShowModelInfo(false);
    setSlashOutput('');
    setShowNewSessionConfirm(false);
    stoppedRef.current = false;
    sessionClearedRef.current = false;
    setError('');
    // Append the user's request and open a streaming planner turn right below
    // it — everything stays strictly top-to-bottom.
    setTimeline((prev) => [
      ...prev,
      { id: nextId('user'), kind: 'user', text, timestamp: Date.now() },
      { id: nextId('planner'), kind: 'planner', activities: [], text: '', streaming: true, timestamp: Date.now() },
    ]);
    setIsResearchActive(true);
    vscode.postMessage({ type: 'sendMessage', text, runners });
  }, [runners, handleNewSession, showNewSessionConfirm]);

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

  const handlePromptChange = useCallback((taskId: string, prompt: string) => {
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify({ prompt }), runners, actionContext: { type: 'execute', taskId } });
    const current = planRef.current;
    if (current) {
      const updateTasks = (tasks: typeof current.tasks): typeof current.tasks =>
        tasks.map((t) => {
          if (t.id === taskId) return { ...t, prompt, description: prompt };
          if (t.subtasks.length > 0) return { ...t, subtasks: updateTasks(t.subtasks) };
          return t;
        });
      setPlan({ ...current, tasks: updateTasks(current.tasks) });
    }
  }, [runners]);

  // No optimistic removal: the host asks for confirmation, so the card must
  // survive a "Cancel" and only disappear when the host echoes the new plan.
  const handleRemoveTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendMessage', text: '', runners, actionContext: { type: 'execute', taskId } });
  }, [runners]);

  // Not echoed either: the host validates the edit against the whole graph and
  // refuses some lists, so the checkboxes must show what was accepted.
  const handleDependenciesChange = useCallback((taskId: string, dependencies: string[]) => {
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify({ dependencies }), runners, actionContext: { type: 'execute', taskId } });
  }, [runners]);

  const handleAddTask = useCallback((draft: TaskDraft) => {
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify(draft), runners, actionContext: { type: 'addTask' } });
  }, [runners]);

  // Activation-time discovery can cache a degraded (empty) catalog for a runner
  // that was cold or unconfigured at that moment (see extension.ts's
  // maybeWarnDegradedDiscovery). Unlike the TUI's task-model picker, which
  // re-fetches on every open, this webview only refreshes on activation, a
  // config change, or reconnect — so a stale empty list for an already-
  // assigned task's runner never self-heals on its own. Re-discover whenever a
  // task's model dropdown opens, same as the TUI does.
  const handleModelsRefreshNeeded = useCallback(() => {
    vscode.postMessage({ type: 'refreshModels' });
  }, []);

  const handleModelChange = useCallback((taskId: string, assignment: TaskModelAssignment) => {
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify(assignment), runners, actionContext: { type: 'execute', taskId } });
    const current = planRef.current;
    if (current) {
      const updateTasks = (tasks: typeof current.tasks): typeof current.tasks =>
        tasks.map((t) => {
          if (t.id === taskId) return { ...t, assignedModel: assignment };
          if (t.subtasks.length > 0) return { ...t, subtasks: updateTasks(t.subtasks) };
          return t;
        });
      setPlan({ ...current, tasks: updateTasks(current.tasks) });
    }
  }, [runners]);

  // Only the runner is echoed optimistically. The model, effort and mode that
  // follow from it come from the new runner's catalog, which only the host can
  // read — guessing them here would display an unspawnable assignment until the
  // retargeted plan arrives.
  const handleRunnerChange = useCallback((taskId: string, runner: string) => {
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify({ runner }), runners, actionContext: { type: 'execute', taskId } });
    const current = planRef.current;
    if (current) {
      const updateTasks = (tasks: typeof current.tasks): typeof current.tasks =>
        tasks.map((t) => {
          if (t.id === taskId) return { ...t, assignedRunner: runner };
          if (t.subtasks.length > 0) return { ...t, subtasks: updateTasks(t.subtasks) };
          return t;
        });
      setPlan({ ...current, tasks: updateTasks(current.tasks) });
    }
  }, [runners]);

  const handleModeChange = useCallback((taskId: string, mode: string) => {
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify({ mode }), runners, actionContext: { type: 'execute', taskId } });
    const current = planRef.current;
    if (current) {
      const updateTasks = (tasks: typeof current.tasks): typeof current.tasks =>
        tasks.map((t) => {
          if (t.id === taskId) return { ...t, taskMode: mode };
          if (t.subtasks.length > 0) return { ...t, subtasks: updateTasks(t.subtasks) };
          return t;
        });
      setPlan({ ...current, tasks: updateTasks(current.tasks) });
    }
  }, [runners]);

  const handleRetry = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendMessage', text: '', runners, actionContext: { type: 'retry', taskId } });
  }, [runners]);

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

  const handleForceStart = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'forceStart', taskId });
    pushSystem(`Task "${taskTitle}" force started.`);
  }, [pushSystem]);

  const handleExecutePlan = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'executePlan' });
    pushSystem('Plan execution started.');
  }, [pushSystem]);

  const handleStopExecution = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
    pushSystem('Execution stopped.');
  }, [pushSystem]);

  const handleRunTask = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'runTask', taskId });
    pushSystem(`Task "${taskTitle}" started.`);
  }, [pushSystem]);

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

  const handleStop = useCallback(() => {
    stoppedRef.current = true;
    if (isExecuting) {
      setIsExecuting(false);
      vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
      pushSystem('Execution stopped.');
    } else {
      setIsResearchActive(false);
      vscode.postMessage({ type: 'stopResearch' });
      // Fallback: if the host doesn't send plannerInterrupted within 1.5s
      // (e.g. no lastPlannerContent was accumulated), finalize locally so the
      // streaming bubble doesn't stay open forever.
      if (stopFallbackRef.current) clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = setTimeout(() => {
        setTimeline((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === 'planner' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, streaming: false, interrupted: true }];
          }
          return prev;
        });
      }, 1500);
    }
  }, [isExecuting, pushSystem]);

  const handleToggleSkill = useCallback((skillId: string) => {
    if (skillId === 'tdd') {
      const next = !tddEnabled;
      setTddEnabled(next);
      vscode.postMessage({ type: 'toggleSkill', skillId, enabled: next });
    } else if (skillId === 'verify') {
      const next = !verifyEnabled;
      setVerifyEnabled(next);
      vscode.postMessage({ type: 'toggleSkill', skillId, enabled: next });
    }
  }, [tddEnabled, verifyEnabled]);

  const handleApproveCheckpoint = useCallback(() => {
    if (!checkpoint) return;
    vscode.postMessage({ type: 'sendMessage', text: '', runners, actionContext: { type: 'approve', taskId: checkpoint.taskId } });
    setCheckpoint(null);
  }, [checkpoint, runners]);

  const handleRejectCheckpoint = useCallback((reason: string) => {
    if (!checkpoint) return;
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify({ reason }), runners, actionContext: { type: 'cancel', taskId: checkpoint.taskId } });
    setCheckpoint(null);
  }, [checkpoint, runners]);

  const handleMergeTasks = useCallback((taskIds: string[]) => {
    const current = planRef.current;
    if (!current) return;
    const titles = taskIds.map((id) => current.tasks.find((t) => t.id === id)?.title ?? id);
    pushSystem(`Requesting merge of: ${titles.join(' + ')}.`);
    vscode.postMessage({ type: 'sendMessage', text: JSON.stringify({ taskIds }), runners, actionContext: { type: 'merge' } });
  }, [runners, pushSystem]);

  const handleSplitTask = useCallback((taskId: string) => {
    const current = planRef.current;
    if (!current) return;
    const task = current.tasks.find((t) => t.id === taskId);
    pushSystem(`Requesting split of: ${task?.title ?? taskId}.`);
    vscode.postMessage({ type: 'sendMessage', text: '', runners, actionContext: { type: 'split', taskId } });
  }, [runners, pushSystem]);

  const getPlaceholder = (): string => {
    if (isResearchActive || isExecuting) return 'AI is working...';
    if (plan && plan.tasks.length > 0) return 'Modify the plan...';
    if (timeline.some((i) => i.kind === 'planner')) return 'Reply to the planner...';
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

  const hasContent = timeline.length > 0 || isResearchActive || isExecuting || !!error;

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
        <div className="plan-dock-body" hidden={!dockExpanded}>
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
            runnerLabels={runnerLabelMap}
            runners={runnerList}
            onRunnerChange={handleRunnerChange}
            onDependenciesChange={handleDependenciesChange}
            onAddTask={handleAddTask}
            onModelChange={handleModelChange}
            onModelsRefreshNeeded={handleModelsRefreshNeeded}
            onModeChange={handleModeChange}
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
          />
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
              {queueCount > 0 && (
                <div className="queue-badge">
                  <span className="queue-dot" /> {queueCount} message{queueCount > 1 ? 's' : ''} queued
                </div>
              )}
              <div className="executing-status">Tasks active &mdash; send follow-ups to queue</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
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

      <div className="skill-bar">
        <button className={`skill-toggle-pill ${tddEnabled ? 'on' : 'off'}`}
          onClick={() => handleToggleSkill('tdd')} title="TDD: test-driven development prompt augmentation">
          <span className="skill-toggle-dot" /> TDD
        </button>
        <button className={`skill-toggle-pill ${verifyEnabled ? 'on' : 'off'}`}
          onClick={() => handleToggleSkill('verify')} title="Verify (run tests): adds a final evidence-based task that runs the full suite, writes missing spec checks, and must exit green">
          <span className="skill-toggle-dot" /> Verify
        </button>
      </div>

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

      <div className="message-list" ref={messageListRef}>
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

        {timeline.map((item) => {
          if (item.kind === 'planRevision') {
            return (
              <div key={item.id} className="plan-revision-chip-row">
                <button
                  type="button"
                  className="plan-revision-chip"
                  onClick={() => setDockExpanded((v) => nextDock(v, 'user-expanded'))}
                  title="Show the plan"
                >
                  {item.label}
                </button>
              </div>
            );
          }
          if (item.kind === 'user') {
            return <ChatMessage key={item.id} message={{ id: item.id, role: 'user', content: item.text, timestamp: item.timestamp }} />;
          }
          if (item.kind === 'system') {
            return <ChatMessage key={item.id} message={{ id: item.id, role: 'system', content: item.text, timestamp: item.timestamp }} />;
          }
          return (
            <ChatMessage
              key={item.id}
              message={{ id: item.id, role: 'planner', content: item.text, timestamp: item.timestamp }}
              activities={item.activities}
              streaming={item.streaming}
              interrupted={item.interrupted}
            />
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {renderPlanDock()}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        disabled={isResearchActive}
        placeholder={getPlaceholder()}
        modelOptions={modelOptions}
        configuredProviders={configuredProviders}
        isProcessing={isGenerating}
        queueCount={queueCount}
        prefill={prefill}
        skills={skills}
      />
    </div>
  );
}
