import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { taskCommand, useRunnerCommands, useTaskCommands } from './RunnerCommands';
import SubTaskCard from './SubTaskCard';
import TaskAssignment, { TaskAssignmentReadout } from './TaskAssignment';
import ModelSelector from './ModelSelector';
import DependencyPicker from './DependencyPicker';
import SkillChips from './SkillChips';
import TaskHandoff from './TaskHandoff';
import { QUEUE_TITLE, SendKeyHint, isSendNowKey } from './PendingMessages';
import { lastLine } from '../taskOutput';
import { checkLabel } from '../checkLabel';
import { useFollowOutput } from '../followOutput';
import { blockedByLabel, dependencyCandidates, capConflictFiles, cardEditable, holdLabel, loopRowParts, pausedOnLimit, scriptTaskText, skippedLabel, taskRefOf, taskRowView } from '@ordewell/core/plan-utils';
import type { Task, DiscoveredModel, TaskModelAssignment, RunTask, TaskRowAction, TaskRowView, TaskStatusKind, AssignmentScope } from '@ordewell/core';

export interface RunnerMode {
  id: string;
  label: string;
  description: string;
  /** Tagged `autonomous: true` on the manifest — runs without permission prompts. */
  autonomous?: boolean;
  /** Why this host cannot run the mode; the option is listed, not selectable. */
  unavailable?: string;
}

export interface RunnerOption {
  id: string;
  displayName: string;
}

/**
 * A task's entry in the run view. Its status is the newest word while a run
 * streams — `task_started` reaches it before the plan refresh does — so the
 * card's editability reads it when present.
 */
export type TaskCardRun = Pick<RunTask, 'idleSince' | 'completionReceived' | 'attaching' | 'awaitingApproval' | 'isolation' | 'mergeGate' | 'continuable' | 'waitsForApproval' | 'holdReason' | 'loopStranded' | 'handoff' | 'verdict' | 'loopRound' | 'attempted' | 'attemptUsage'> & { status?: Task['status'] };

interface TaskCardProps {
  task: Task;
  models: DiscoveredModel[];
  modes?: RunnerMode[];
  /** Every runner's catalog, keyed by runner id — used to re-scope a subtask's
   *  own pickers to ITS `assignedRunner` rather than the parent's (a subtask
   *  can run on a different runner than its parent). */
  modelsByRunner?: Partial<Record<string, DiscoveredModel[]>>;
  modesByRunner?: Record<string, RunnerMode[]>;
  runners?: RunnerOption[];
  /** The enabled runners and allowlist an assignment is read against; absent until the host has sent them, and then no task is flagged. */
  runnerScope?: AssignmentScope;
  effectiveRunner?: string;
  configuredProviders?: ('openrouter' | 'google' | 'openai_compatible')[];
  modelApiMapping?: Record<string, ('openrouter' | 'google' | 'openai_compatible')[]>;
  isExecuting?: boolean;
  /** Anything that could still move a task on without being asked: a queued start or usage-limit hold too, not only a live attempt. Defaults to `isExecuting`. */
  runActive?: boolean;
  /** Tail of this task's live runner output, if any has arrived. */
  output?: string;
  /**
   * This task's own status as the run view holds it (#S8c): its stall mark,
   * runner approvals, isolation and merge gate. Absent before the host has
   * folded the run, in which case the plan's own fields are all there is.
   */
  run?: TaskCardRun;
  /** Every task's run entry, keyed by id, so a subtask card can read its own hold. */
  runsByTask?: ReadonlyMap<string, RunTask>;
  /** Opt in to resolving this task's merge conflict as an AI task. */
  onResolveConflict?: (taskId: string) => void;
  dependentCount?: number;
  /** The task list this task belongs to — the dependency editor's candidates and the tree its dependency references are labelled against. */
  siblings?: Task[];
  onDependenciesChange?: (taskId: string, dependencies: string[]) => void;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  /** Called when this task's model dropdown opens, so a stale/degraded catalog self-heals. */
  onModelsRefreshNeeded?: () => void;
  onModeChange?: (taskId: string, mode: string) => void;
  /** Change versus ops (ADR-0020); offered until the task starts. */
  onOpsChange?: (taskId: string, ops: boolean) => void;
  taskSkills?: { name: string; description: string }[];
  onSkillsChange?: (taskId: string, skills: string[]) => void;
  onRemoveTask?: (taskId: string) => void;
  onPromptChange?: (taskId: string, prompt: string) => void;
  onRetry?: (taskId: string) => void;
  onSkip?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  /** Keep a task paused on a usage limit from resuming on its own (#84). */
  onCancelResume?: (taskId: string) => void;
  /** Resume a task paused on a usage limit now, in its saved session, once the user says the limit has reset. */
  onResumeNow?: (taskId: string) => void;
  onForceStart?: (taskId: string) => void;
  onMarkComplete?: (taskId: string) => void;
  onMarkIncomplete?: (taskId: string) => void;
  /** Revert the task's landed work (ADR-0054); the host confirms what goes with it. */
  onRevert?: (taskId: string) => void;
  onRunTask?: (taskId: string) => void;
  /** Message the running or waiting task from its card (ADR-0018, M1); a plain message goes through the command seam. */
  onSendMessage?: (taskId: string, text: string) => void;
  /** Force send to the running task from its card (ADR-0023, F1): interrupt its turn and deliver this next. */
  onSendMessageNow?: (taskId: string, text: string) => void;
  /** Open (or focus) this task's log tab (ADR-0018, V1). */
  onOpenLog?: (taskId: string) => void;
  /** Controlled expansion. When both are supplied the parent owns which card is
   *  open (an accordion); omitted, the card keeps its own state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const STATUS_BADGE: Record<TaskStatusKind, { label: string; cls: string }> = {
  done: { label: 'Done', cls: 'status-completed' },
  failed: { label: 'Failed', cls: 'status-failed' },
  running: { label: 'Running', cls: 'status-running' },
  quiet: { label: 'Stalled', cls: 'status-stalled' },
  blocked: { label: 'Blocked', cls: 'status-blocked' },
  skipped: { label: 'Skipped', cls: 'status-skipped' },
  todo: { label: 'To do', cls: 'status-pending' },
  awaiting: { label: 'Awaiting User', cls: 'status-blocked' },
};

/** The status badge: what an awaiting task waits on, a report received, a runner still connecting Ordewell's tools, why it is held, the failure a blocked one waits on, or why one was skipped, outranks the generic word. */
export function statusBadge(row: Pick<TaskRowView, 'status' | 'awaiting' | 'receipt' | 'attaching' | 'blockedBy' | 'skipReason' | 'holdReason'>): { label: string; cls: string } {
  const badge = STATUS_BADGE[row.status];
  if (row.status === 'skipped') return { ...badge, label: skippedLabel(row.skipReason) };
  if (row.awaiting) return { ...badge, label: row.awaiting };
  if (row.receipt) return { ...badge, label: row.receipt };
  if (row.attaching) return { ...badge, label: row.attaching };
  if (row.holdReason) return { ...badge, label: holdLabel(row.holdReason) };
  return { ...badge, label: row.blockedBy ? blockedByLabel(row.blockedBy) : badge.label };
}

/**
 * A loop's check says its round, and each body task which check it runs for
 * (ADR-0045); what the loop waits for or stopped at is in the hover.
 */
function LoopBadge({ loop }: { loop: TaskRowView['loop'] }) {
  if (!loop) return null;
  const text = loop.role === 'body' ? loop.label : loop.state === 'waiting' || loop.state === 'ended' ? loop.label : `Loop · ${loop.label}`;
  return (
    <span className={`task-isolation-badge loop ${loop.role === 'check' ? loop.state : 'body'}`} title={loopRowParts(loop).join('. ')}>
      {text}
    </span>
  );
}

/** A skip or block reason can run to a sentence: it is cut to the row it
 *  shares with the dependency badges, and a click unfolds the whole of it. */
export function StatusBadge({ status }: { status: { label: string; cls: string } }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setClipped(el.scrollWidth > el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Once open it no longer overflows, so it stays a toggle until folded back.
  const toggles = clipped || open;
  const toggle = (): void => setOpen(o => !o);
  return (
    <span className="task-status-slot">
      <span ref={ref} className={`task-status-badge ${status.cls}${open ? ' expanded' : ''}${toggles ? ' toggles' : ''}`}
        title={toggles && !open ? status.label : undefined}
        {...(toggles && {
          role: 'button', tabIndex: 0, 'aria-expanded': open,
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); toggle(); },
          onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } },
        })}>
        {status.label}
      </span>
    </span>
  );
}

const CHECK_STATE: Record<TaskStatusKind, 'done' | 'running' | 'stalled' | 'failed' | 'skipped' | 'todo'> = {
  done: 'done', running: 'running', quiet: 'stalled', todo: 'todo', awaiting: 'todo', blocked: 'todo', failed: 'failed', skipped: 'skipped',
};

/** Minimal to-do / done indicator: empty ring → sweeping ring → filled check.
 *  It only reports the task's status. Completion is changed deliberately, from
 *  Mark complete / Mark not done at the bottom of the expanded details. */
export function TaskCheck({ row }: { row: Pick<TaskRowView, 'status'> }) {
  const state = CHECK_STATE[row.status];
  const title = state === 'done'
    ? 'Executed'
    : state === 'running'
      ? 'Running'
      : state === 'stalled'
        ? 'Stalled: no output recently'
        : state === 'skipped'
          ? 'Skipped: nothing of it landed'
          : state === 'failed'
            ? 'Failed'
            : 'To do';
  return (
    <span className={`task-check ${state}`} role="img" aria-label={title} title={title}>
      {state === 'done' && (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 8.6l2.4 2.4 5.2-5.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

/**
 * Mark complete / Mark not done, at the bottom of a task's expanded details and
 * nowhere else. The host asks the user to confirm an AI or script task's
 * override, and the core refuses it while a run could advance the task
 * (ADR-0029); the button is held back here as well so the refusal is explained
 * before the click. A manual task is the user's own sign-off, so a run never
 * holds it up.
 */
export function TaskMarkControl({ taskId, row, runActive, hint, onMarkComplete, onMarkIncomplete }: {
  taskId: string;
  row: Pick<TaskRowView, 'status' | 'mark' | 'kind'>;
  /** The run could still move this task on without being asked — a queued start or a usage-limit hold included. */
  runActive: boolean;
  /** Why a manual task cannot be signed off yet; the button waits for it. */
  hint?: string;
  onMarkComplete?: (taskId: string) => void;
  onMarkIncomplete?: (taskId: string) => void;
}) {
  const handler = row.mark === 'uncomplete' ? onMarkIncomplete : onMarkComplete;
  if (!handler || row.status === 'running' || row.status === 'quiet') return null;
  const stopFirst = runActive && row.kind !== 'user';
  const label = row.mark === 'uncomplete' ? 'Mark not done' : 'Mark complete';
  const why = stopFirst ? 'Stop the run first: the run could still move this task on' : hint;
  return (
    <div className="task-mark-control">
      <button type="button" className="task-mark-btn" disabled={!!why} title={why ?? label}
        onClick={(e) => { e.stopPropagation(); handler(taskId); }}>
        {label}
      </button>
      {why && <span className="task-mark-hint">{why}</span>}
    </div>
  );
}

/**
 * Revert, beside the mark control: only where core's isolation mark says the
 * landing can be reverted. The button names its task, since a plan holds many
 * of them; the host's modal lists what else goes with it.
 */
export function TaskRevertControl({ taskId, title, row, onRevert }: {
  taskId: string;
  title: string;
  row: Pick<TaskRowView, 'revertible' | 'orderLabel'>;
  onRevert?: (taskId: string) => void;
}) {
  if (!onRevert || !row.revertible) return null;
  return (
    <div className="task-mark-control">
      <button type="button" className="task-mark-btn" aria-label={`Revert task #${row.orderLabel} ${title}`}
        title="Take this landed work back off the integration branch, with the tasks that landed on top of it"
        onClick={(e) => { e.stopPropagation(); onRevert(taskId); }}>
        Revert
      </button>
    </div>
  );
}

const ACTION_CLASS: Record<TaskRowAction, string> = {
  cancel: 'cancel', 'resume-now': 'start', 'cancel-resume': 'cancel', skip: 'skip', 'force-start': 'start', complete: 'start', uncomplete: 'skip',
};

const ACTION_LABELS: Record<TaskRowAction, string> = {
  cancel: 'Cancel', 'resume-now': 'Resume Now', 'cancel-resume': 'Don\'t Resume', skip: 'Skip', 'force-start': 'Start', complete: 'Mark Complete', uncomplete: 'Mark Not Done',
};

/** The cue to move a task off a runner or model the user has since moved away from; core words what it means for the task as it stands. */
export function AssignmentFlag({ row }: { row: Pick<TaskRowView, 'assignmentFlag' | 'assignmentConsequence'> }) {
  if (!row.assignmentFlag || !row.assignmentConsequence) return null;
  const consequence = row.assignmentConsequence;
  return (
    <span className="task-isolation-badge gate"
      title={`${consequence[0].toUpperCase()}${consequence.slice(1)}. Change its runner or model to move it, or ask the planner to.`}>
      {row.assignmentFlag}
    </span>
  );
}

/** What holds a task back or runs on its isolated work, on the collapsed card: a merge gate, a stopped integration, a conflict repair. */
export function IsolationBadges({ row }: { row: Pick<TaskRowView, 'mergeGate' | 'conflict' | 'repairing' | 'repairWaiting'> }) {
  return (
    <>
      {row.mergeGate && (
        <span className="task-isolation-badge gate"
          title={`The work of ${row.mergeGate.join(', ')} is not merged into your branch yet. Merge all lets this task go on.`}>
          Waits for Merge all
        </span>
      )}

      {/* A stopped integration is not a hidden failure (US33) — visible on the
          collapsed card, since it is the one isolation state that needs a
          decision, not just inspection. */}
      {row.conflict && (
        <span className="task-isolation-badge conflict" title={`Integrating this task conflicted${row.conflict.repo ? ` in ${row.conflict.repo}` : ''}${row.conflict.files ? `: ${row.conflict.files}` : ''}. Its worktree and branch are kept.${row.conflict.resolver ? ` Task ${row.conflict.resolver} is resolving it.` : ''}`}>
          Conflict{row.conflict.repo ? ` in ${row.conflict.repo}` : ''}
        </span>
      )}

      {/* It starts by itself, so it reads as progress; Cancel withdraws it (ADR-0015). */}
      {row.repairWaiting && (
        <span className="task-isolation-badge repairing" title={`It repairs its conflict in its own worktree${row.repairWaiting.files ? `: ${row.repairWaiting.files}` : ''}. Cancel withdraws the repair, and the conflict waits for you.`}>
          {row.repairWaiting.label}
        </span>
      )}

      {/* Still running, so it reads as progress, not a blocker like a conflict (ADR-0015). */}
      {row.repairing && (
        <span className="task-isolation-badge repairing" title={`Repairing the conflict in its own worktree${row.repairing.files ? `: ${row.repairing.files}` : ''}.`}>
          Repairing{row.repairing.attempt ? ` (${row.repairing.attempt.attempt} of ${row.repairing.attempt.limit})` : ''}
        </span>
      )}
    </>
  );
}

/**
 * The header's controls for a task paused on a usage limit (#84), shown
 * whether or not the plan reads as executing: the pause holds the run, so a
 * held run's card would otherwise hide them.
 */
export function UsageLimitControls({ taskId, row, onResumeNow, onCancelResume }: {
  taskId: string;
  row: Pick<TaskRowView, 'resumes' | 'actions'>;
  onResumeNow?: (taskId: string) => void;
  onCancelResume?: (taskId: string) => void;
}) {
  return (
    <>
      {row.resumes && (
        <span className="task-isolation-badge gate" title="Its runner hit its usage limit. The task resumes on its own once the limit resets.">
          {row.resumes}
        </span>
      )}
      {row.actions.includes('resume-now') && onResumeNow && (
        <button type="button" className="task-log-open-btn"
          onClick={(e) => { e.stopPropagation(); onResumeNow(taskId); }}
          title="The limit has reset: resume it in its saved session now">
          Resume now
        </button>
      )}
      {row.resumes && onCancelResume && (
        <button type="button" className="task-log-open-btn"
          onClick={(e) => { e.stopPropagation(); onCancelResume(taskId); }}
          title="Keep it from resuming on its own: resume or retry it yourself once the limit resets">
          Don't resume
        </button>
      )}
    </>
  );
}

/**
 * The buttons a running plan offers on a card, in the order core lays them out.
 * `onRetry` is a failed task's fresh retry, first as in the TUI: core refuses
 * Run Task on a failed task, so it is the task's own way back.
 */
export function TaskActions({ taskId, actions, labels, handlers, onRetry }: {
  taskId: string;
  actions: TaskRowAction[];
  labels: Record<TaskRowAction, string>;
  handlers: Partial<Record<TaskRowAction, (taskId: string) => void>>;
  onRetry?: (taskId: string) => void;
}) {
  return (
    <div className="task-actions">
      {onRetry && (
        <button className="task-action-btn start" onClick={(e) => { e.stopPropagation(); onRetry(taskId); }}>
          Retry
        </button>
      )}
      {actions.filter((action) => action !== 'complete' && action !== 'uncomplete').map((action) => {
        const handler = handlers[action];
        return handler && (
          <button key={action} className={`task-action-btn ${ACTION_CLASS[action]}`} onClick={(e) => { e.stopPropagation(); handler(taskId); }}>
            {labels[action]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A compact composer on a running or waiting task's card (ADR-0018, M1;
 * ADR-0023, F1). Send is the plain task message the log sends; Ctrl+Enter
 * interrupts the running turn and delivers this one next, as `ctrl-s` does in
 * the TUI and in the log. A task paused on a usage limit has no turn to
 * interrupt: its message resumes it, after the reset notice.
 */
export function TaskMessageBox({ taskId, onSend, onSendNow, working = false, resumes = false }: {
  taskId: string;
  onSend: (taskId: string, text: string) => void;
  onSendNow: (taskId: string, text: string) => void;
  /** A turn is live, so Enter queues and Ctrl+Enter sends now. */
  working?: boolean;
  resumes?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const { commands, invoke } = useTaskCommands(taskId);
  const completion = useRunnerCommands(text, setText, commands);
  const canSend = text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    try {
      const command = taskCommand(text.trim(), commands);
      if (command && !resumes) invoke(command.name, command.args);
      else onSend(taskId, text.trim());
      setError('');
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const nativeSlash = text.trim().startsWith('/') && commands.length > 0;
  const queues = working && canSend && !resumes && !nativeSlash;
  const sendNow = () => { if (nativeSlash) { send(); return; } if (canSend) { onSendNow(taskId, text.trim()); setText(''); } };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || completion.keyDown(e)) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (isSendNowKey(e) && !resumes) sendNow(); else send();
  };
  return (
    <div className="task-message-box" onClick={(e) => e.stopPropagation()}>
      {completion.palette}
      {error && <span className="task-command-error" role="alert">{error}</span>}
      <textarea className="task-message-input" value={text} rows={1}
        placeholder={resumes ? 'The limit has reset? A message to resume it with… (Enter to resume)' : 'Message the task… (Enter to send)'}
        onChange={(e) => completion.change(e.target.value)} onKeyDown={onKeyDown} />
      <button type="button" className="task-message-send" disabled={!canSend} onClick={send}
        title={queues ? QUEUE_TITLE : `${resumes ? 'Resume' : 'Send'} (Enter)`}>
        {resumes ? 'Resume' : 'Send'}
      </button>
      {queues && <SendKeyHint />}
    </div>
  );
}

const DEFAULT_MODES: RunnerMode[] = [
  { id: 'build', label: 'Build', description: 'Edit files and run commands' },
  { id: 'plan', label: 'Read-only', description: 'Ordewell commands; lands nothing' },
];

/**
 * The runner list a task's picker offers. The task's own runner is always in it,
 * even when missing from the installed set (uninstalled since planning, or a
 * model discovery didn't see): a select that dropped it would fall back to
 * displaying some other runner and misreport what the task will be spawned on.
 */
export function runnerOptionsFor(runners: RunnerOption[] | undefined, assignedRunner: string): RunnerOption[] {
  if (!runners || runners.length === 0) return [];
  if (runners.some((r) => r.id === assignedRunner)) return runners;
  return [...runners, { id: assignedRunner, displayName: assignedRunner }];
}

export default function TaskCard({ task, run, runsByTask, models, modes, modelsByRunner, modesByRunner, runners, runnerScope, configuredProviders, modelApiMapping, isExecuting, runActive, output, onResolveConflict, dependentCount, siblings, onDependenciesChange, onRunnerChange, onModelChange, onModelsRefreshNeeded, onModeChange, onOpsChange, taskSkills, onSkillsChange, onRemoveTask, onPromptChange, onRetry, onSkip, onCancel, onCancelResume, onResumeNow, onForceStart, onMarkComplete, onMarkIncomplete, onRevert, onRunTask, onSendMessage, onSendMessageNow, onOpenLog, expanded: expandedProp, onExpandedChange }: TaskCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = expandedProp !== undefined;
  const expanded = isControlled ? expandedProp : internalExpanded;
  const setExpanded = (next: boolean) => {
    if (isControlled) onExpandedChange?.(next);
    else setInternalExpanded(next);
  };
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [editingDeps, setEditingDeps] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [offeringResolve, setOfferingResolve] = useState(false);
  const sortedSubtasks = [...task.subtasks].sort((a, b) => a.order - b.order);

  // The run's word on this task: absent until the host has folded a run, and
  // then authoritative over the plan for everything status-only.
  const idleSince = run?.idleSince ?? null;
  const awaitingApproval = run?.awaitingApproval ?? 0;
  const isolation = run?.isolation ?? null;
  const mergeGate = run?.mergeGate;
  const handoff = run ? run.handoff : task.handoff;

  const isolatedWork = isolation && isolation.state !== 'none' ? isolation : null;
  const activeModes = modes && modes.length > 0 ? modes : DEFAULT_MODES;
  // The run's verdict and round are the newer word on a loop's check: they say whether it is between rounds (ADR-0045).
  const row = taskRowView({
    ...task,
    handoff,
    idleSince,
    completionReceived: run?.completionReceived,
    attaching: run?.attaching,
    awaitingApproval,
    isolation,
    mergeGate,
    holdReason: run?.holdReason,
    loopStranded: run?.loopStranded === true,
    continuable: run?.continuable === true,
    waitsForApproval: run?.waitsForApproval === true,
    attempted: run?.attempted ?? task.attempted,
    ...(run?.attemptUsage ? { attemptUsage: run.attemptUsage } : {}),
    ...(run ? { verdict: run.verdict ?? task.verdict, loopRound: run.loopRound } : {}),
  }, { tasks: siblings, modes: activeModes, runnerScope });
  // Its chat exists only once an attempt has started; status alone never says so.
  const chatAvailable = row.chatAvailable;
  const conflictFiles = isolatedWork?.conflictFiles ?? [];
  const repair = isolatedWork?.repair ?? null;

  const outputRef = useFollowOutput<HTMLPreElement>([output]);

  const status = statusBadge(row);
  const isUserTask = task.type === 'user';
  // While anything could still move the plan on (a live attempt, a start, a
  // scheduler waiting on a manual task or a hold), a task that has not itself
  // started keeps its editors; execution, a start the run already shows, and a
  // settled task do not. The host's edit guard reads the same fact. The run's
  // status is the newer word: `task_started` reaches it first.
  const canEdit = cardEditable(runActive ?? !!isExecuting, { status: run?.status ?? task.status }, run
    ? { awaitingApproval, isolation }
    : undefined);

  // A draft is not the plan's: once execution reaches the task, drop it rather
  // than bring it back if the task returns to pending.
  useEffect(() => {
    if (canEdit) return;
    setEditingPrompt(null);
    setEditingDeps(false);
  }, [canEdit]);

  const handlePromptSave = () => {
    if (editingPrompt !== null && editingPrompt !== task.prompt) {
      onPromptChange?.(task.id, editingPrompt);
    }
    setEditingPrompt(null);
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePromptSave();
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditingPrompt(null);
    }
  };

  const toggleStep = (order: number) => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(order)) next.delete(order); else next.add(order);
      return next;
    });
  };

  const allStepsComplete = task.userSteps?.every((s) => completedSteps.has(s.order)) ?? false;



  const runnerOptions = runnerOptionsFor(runners, task.assignedRunner);
  const canEditDeps = canEdit && !!onDependenciesChange;
  // Only a running or waiting AI task has a runner turn to reach; a manual task
  // or one not yet started has none. One paused on a usage limit is reached
  // by resuming it, which needs its saved session.
  const paused = pausedOnLimit(task);
  const failed = task.status === 'failed';
  const resumable = row.actions.includes('resume-now');
  const canMessage = task.type === 'ai'
    && (row.status === 'running' || row.status === 'quiet' || (row.status === 'awaiting' && (!paused || resumable)))
    && !!onSendMessage && !!onSendMessageNow;

  return (
    <div className="task-with-controls task-with-controls-top">
      <div className={`task-card task-${task.type} ${expanded ? 'expanded' : ''}`}>
        <div className="task-card-header" onClick={() => setExpanded(!expanded)}>
          <span className="task-card-lead">
            <TaskCheck row={row} />
            <span className="task-order">{row.orderLabel}</span>
            <span className={`task-type-badge ${task.type}`}>
              {isUserTask ? 'Manual' : row.kind === 'script' ? 'Script' : 'AI'}
            </span>
            {row.research && (
              <span className="task-type-badge research" title="A research task: read-only, it lands nothing. Its report comes back to the planner and wakes it when the task ends.">Research</span>
            )}
            {row.kind === 'ops' && (
              <span className="task-type-badge ops" title="An ops task: it changes no repository files and runs in your checkout, once the work it depends on is merged">Ops</span>
            )}
          </span>
          <div className={`task-heading-block${onOpenLog && chatAvailable ? ' task-heading-block-with-log' : ''}`}>
            <button type="button" className="task-heading" aria-expanded={expanded}
              title={expanded ? 'Collapse task details' : 'Expand task details'}
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
              <span className="task-title-text">{task.title}</span>
            </button>
            {/* Outside the heading button, so Open chat can share its line without nesting a button in a button. */}
            <TaskAssignment task={task} />
            {onOpenLog && chatAvailable && (
              <button type="button" className="task-log-open-btn task-log-open-btn-stacked"
                aria-label="Open chat"
                onClick={(e) => { e.stopPropagation(); onOpenLog(task.id); }}
                title="Open this task's chat in an editor tab">
                <span>Open</span>
                <span>chat</span>
              </button>
            )}
          </div>
        </div>

        {/* Collapsed, the newest line is the whole signal — "which test is it on"
            without having to open the card. */}
        {!expanded && output && (
          <div className="task-output-peek" onClick={() => setExpanded(true)} title="Show the full tail">
            {lastLine(output)}
          </div>
        )}

        {expanded && (
          <div className="task-card-body">
            <p className="task-description">{task.description}</p>

            {handoff && <TaskHandoff handoff={handoff} taskName={(id) => taskRefOf(siblings ?? [], id)}
              onReadFull={onOpenLog && chatAvailable ? () => onOpenLog(task.id) : undefined} />}

            {/* Worktrees are an implementation detail unless something needs the
                user's attention (US34) — so the branch and path live in the
                details, and only a conflict earns a header badge. */}
            {isolatedWork && (
              <div className="task-isolation">
                <div className="task-isolation-row"><span className="task-isolation-label">Branch</span><code>{isolatedWork.branch}</code></div>
                <div className="task-isolation-row"><span className="task-isolation-label">Worktree</span><code>{isolatedWork.worktree}</code></div>
                {row.repos.length > 0 && (
                  <div className="task-isolation-row task-isolation-repos"><span className="task-isolation-label">Repos</span><code>{row.repos.join(', ')}</code></div>
                )}
                {row.conflict?.repo && (
                  <div className="task-isolation-row task-isolation-conflict-repo"><span className="task-isolation-label">Conflict</span><code>{row.conflict.repo}</code></div>
                )}
                {conflictFiles.length > 0 && (
                  <div className="task-isolation-row task-isolation-conflict-files"><span className="task-isolation-label">Files</span><code>{capConflictFiles(conflictFiles)}</code></div>
                )}
                {repair && (
                  <div className="task-isolation-row task-isolation-repair"><span className="task-isolation-label">Repair</span><code>{repair.attempt} of {repair.limit}</code></div>
                )}
                {row.repaired && (
                  <div className="task-isolation-row task-isolation-repaired-note">Landed after repairing a conflict in {row.repaired.files}.</div>
                )}
                {row.conflict && !row.conflict.resolver && onResolveConflict && (
                  offeringResolve ? (
                    <div className="task-isolation-resolve">
                      <span>Resolve this conflict as a new AI task?</span>
                      <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); onResolveConflict(task.id); setOfferingResolve(false); }}>Resolve as a task</button>
                      <button className="task-action-btn" onClick={(e) => { e.stopPropagation(); setOfferingResolve(false); }}>Cancel</button>
                    </div>
                  ) : (
                    <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); setOfferingResolve(true); }}>Resolve</button>
                  )
                )}
              </div>
            )}

            {row.opsChangedFiles && (
              <div className="task-ops-note warn">This ops task changed tracked files in your checkout, and nothing was committed. Check the changes, then mark it complete or retry it.</div>
            )}
            {row.forcedPastGate && (
              <div className="task-ops-note">Force-started before the work of {row.forcedPastGate.join(', ')} was merged into your branch.</div>
            )}

            {output && (
              <div className="task-output">
                <div className="task-output-header">Runner output (tail)</div>
                <pre className="task-output-pre" ref={outputRef}>{output}</pre>
              </div>
            )}

            {canEditDeps ? (
              <div className="task-deps">
                <span className="task-deps-label" onClick={(e) => { e.stopPropagation(); setEditingDeps(!editingDeps); }}
                  title="Edit dependencies">
                  Depends on: {row.dependencies.length > 0 ? row.dependencies.join(', ') : 'nothing'}
                  <span className="task-prompt-edit-icon">&#9998;</span>
                </span>
                {editingDeps && (
                  <DependencyPicker candidates={dependencyCandidates(siblings ?? [], task.id)}
                    selected={task.dependencies}
                    onChange={(ids) => onDependenciesChange!(task.id, ids)}
                    onDone={() => setEditingDeps(false)} />
                )}
              </div>
            ) : task.dependencies.length > 0 && (
              <div className="task-deps">Depends on: {row.dependencies.join(', ')}</div>
            )}

            {task.verdict && (
              <div className={`task-review ${task.verdict.outcome === 'pass' ? 'review-pass' : 'review-neutral'}`}>
                <div className="task-review-summary">
                  {task.verdict.outcome === 'pass' ? 'Verified' : 'Failed verification'}: {task.verdict.reason}
                </div>
                {task.verdict.checks.length > 0 && (
                  <div className="task-review-checks">
                    {task.verdict.checks.map((check) => (
                      <div key={check.name} className={`check-item ${check.skipped ? 'check-skipped' : check.passed ? 'check-passed' : 'check-failed'}`}>
                        <span className="check-icon">{check.skipped ? '×' : check.passed ? '✓' : '✗'}</span>
                        <span className="check-name">{checkLabel(check.name)}</span>
                        <span className="check-status">{check.skipped ? 'skipped' : check.passed ? 'passed' : 'failed'}</span>
                        {check.detail && <span className="check-detail">{check.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isExecuting && isUserTask && task.userSteps && task.userSteps.length > 0 && (
              <div className="user-step-guide">
                <div className="user-step-guide-header">Step-by-Step Guide</div>
                {task.userSteps.map((step) => (
                  <div key={step.order} className="user-step-item">
                    <span className="user-step-number">{step.order}</span>
                    <span className="user-step-text">{step.instruction}</span>
                  </div>
                ))}
              </div>
            )}

            {isExecuting && isUserTask && task.userSteps && task.userSteps.length > 0 && (
              <div className="steps-section">
                <div className="steps-section-header">Steps</div>
                <ol className="steps-list">
                  {task.userSteps.sort((a, b) => a.order - b.order).map((step) => (
                    <li key={step.order} className={`step-item ${completedSteps.has(step.order) ? 'completed' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleStep(step.order); }}>
                      <span className="step-checkbox">{completedSteps.has(step.order) ? '✓' : '○'}</span>
                      <span className="step-text">{step.instruction}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* Where the prompt goes, read-only: only the planner writes a script's body, and it is what the user consents to (ADR-0035). */}
            {row.kind === 'script' && (
              <div className="task-script">
                <pre className="task-script-body" aria-label="Script body">{scriptTaskText(task)}</pre>
                <div className="task-ops-note">Runs in your checkout with no model, once the work it depends on is merged.</div>
              </div>
            )}

            {canEdit && task.type === 'ai' && task.prompt && (
              editingPrompt === null ? (
                <button type="button" className="task-prompt task-prompt-editable" aria-label={`Edit task prompt: ${task.prompt}`}
                  onClick={(e) => { e.stopPropagation(); setEditingPrompt(task.prompt ?? ''); }} title="Click to edit prompt">
                  {task.prompt}
                  <span className="task-prompt-edit-icon">&#9998;</span>
                </button>
              ) : (
                <div className="task-prompt-edit-wrapper">
                  <textarea className="task-prompt-textarea" value={editingPrompt} onChange={(e) => setEditingPrompt(e.target.value)}
                    onBlur={handlePromptSave} onKeyDown={handlePromptKeyDown} onClick={(e) => e.stopPropagation()}
                    rows={Math.min(editingPrompt.split('\n').length, 20)} autoFocus />
                  <div className="task-prompt-edit-actions">
                    <span className="task-prompt-edit-hint">Ctrl+Enter to save &middot; Esc to cancel</span>
                    <button className="task-prompt-save-btn" onMouseDown={(e) => { e.preventDefault(); handlePromptSave(); }}>Save</button>
                  </div>
                </div>
              )
            )}

            {!canEdit && task.type === 'ai' && task.prompt && (
              <div className="task-prompt task-prompt-readonly">{task.prompt}</div>
            )}

            {/* A task execution has reached shows what its pickers decided; one still queued keeps them. */}
            {!canEdit && <TaskAssignmentReadout task={task} />}

            {/* Runner first: it decides which models, efforts and modes exist below it. */}
            {canEdit && task.type === 'ai' && runnerOptions.length > 0 && onRunnerChange && (
              <div className="model-selector" style={{ marginTop: '8px' }}>
                <label htmlFor={`task-runner-${task.id}`}>Runner</label>
                <select id={`task-runner-${task.id}`} value={task.assignedRunner}
                  onChange={(e) => onRunnerChange(task.id, e.target.value)}>
                  {runnerOptions.map((r) => (
                    <option key={r.id} value={r.id}>{r.displayName}</option>
                  ))}
                </select>
              </div>
            )}

            {canEdit && task.type === 'ai' && models.length > 0 && onModelChange && (
              <ModelSelector models={models} currentModel={task.assignedModel}
                configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
                onChange={(assignment) => onModelChange(task.id, assignment)}
                onOpen={onModelsRefreshNeeded} />
            )}

            {canEdit && task.type === 'ai' && onModeChange && (
              <div className="model-selector" style={{ marginTop: '8px' }}>
                <label htmlFor={`task-mode-${task.id}`}
                  title={row.autonomous ? 'Full: runs without permission prompts. /settings changes the level' : undefined}>
                  Mode{row.autonomous && ' ⚡'}
                </label>
                <select id={`task-mode-${task.id}`} value={task.taskMode ?? activeModes[0]?.id ?? 'build'}
                  onChange={(e) => onModeChange(task.id, e.target.value)}>
                  {activeModes.map((m) => (
                    <option key={m.id} value={m.id} disabled={!!m.unavailable}>{m.label}: {m.unavailable ?? m.description}</option>
                  ))}
                </select>
              </div>
            )}

            {task.type === 'ai' && (
              <SkillChips idPrefix="task" taskId={task.id} skills={task.skills} catalog={taskSkills}
                onChange={canEdit ? onSkillsChange : undefined} />
            )}

            {canEdit && onOpsChange && row.opsEditable && (
              <label className="task-ops-toggle" title="An ops task changes no repository files: it acts on outside systems or on your branch's refs, from your checkout, once the work it depends on is merged.">
                <input type="checkbox" checked={!!task.ops} onChange={(e) => onOpsChange(task.id, e.target.checked)} />
                Ops task: runs in your checkout, not a worktree
              </label>
            )}

            {!isExecuting && task.type === 'ai' && !failed && onRunTask && (
              <div className="task-run-btn-wrapper">
                <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); onRunTask(task.id); }}>
                  Run Task
                </button>
              </div>
            )}

            {sortedSubtasks.length > 0 && (
              <div className="subtasks">
                {sortedSubtasks.map((sub) => {
                  // A subtask can run on a different runner than its parent, so its
                  // pickers must be scoped to ITS OWN assignedRunner, not the
                  // parent's — reusing the parent's `models`/`modes` here would
                  // show the wrong runner's catalog (or none at all).
                  const subRunner = sub.assignedRunner;
                  const subRunnerModels = subRunner ? modelsByRunner?.[subRunner] : undefined;
                  const subModels = subRunnerModels && subRunnerModels.length > 0 ? subRunnerModels : models;
                  const subModes = subRunner ? (modesByRunner?.[subRunner] ?? []) : [];
                  return (
                    <SubTaskCard key={sub.id} task={sub} parentTask={task} tasks={siblings} models={subModels}
                      modes={subModes} runners={runners} runnerScope={runnerScope} effectiveRunner={subRunner}
                      configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
                      isExecuting={isExecuting} runActive={runActive} run={runsByTask?.get(sub.id)}
                      onRunnerChange={onRunnerChange}
                      onModelChange={onModelChange} onModelsRefreshNeeded={onModelsRefreshNeeded} onModeChange={onModeChange}
                      taskSkills={taskSkills} onSkillsChange={onSkillsChange}
                      onRemoveTask={onRemoveTask} onPromptChange={onPromptChange}
                      onRetry={onRetry} onSkip={onSkip} onCancel={onCancel} onCancelResume={onCancelResume} onResumeNow={onResumeNow}
                      onForceStart={onForceStart} onMarkComplete={onMarkComplete}
                      onMarkIncomplete={onMarkIncomplete} onRevert={onRevert}
                      onRunTask={onRunTask} onOpenLog={onOpenLog} />
                  );
                })}
              </div>
            )}

            {canMessage && <TaskMessageBox taskId={task.id} onSend={onSendMessage!} onSendNow={onSendMessageNow!}
              working={row.status === 'running' || row.status === 'quiet'} resumes={paused} />}

            {/* A usage-limit pause holds the run, which then reads as not
                executing; a failure usually ends it, and the failed task
                still needs its Retry and Skip. */}
            {(isExecuting || paused || failed) && (
              <TaskActions taskId={task.id} actions={row.actions} labels={ACTION_LABELS}
                handlers={{ cancel: onCancel, 'resume-now': onResumeNow, 'cancel-resume': onCancelResume, skip: onSkip, 'force-start': onForceStart }}
                onRetry={failed && task.type !== 'user' ? onRetry : undefined} />
            )}

            <TaskMarkControl taskId={task.id} row={row} runActive={runActive ?? !!isExecuting}
              hint={isExecuting && isUserTask && task.userSteps && task.userSteps.length > 0 && !allStepsComplete ? 'Complete all steps above first' : undefined}
              onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />

            <TaskRevertControl taskId={task.id} title={task.title} row={row} onRevert={onRevert} />
          </div>
        )}
      </div>
      <div className="task-footer-controls">
        {/* As plain as a task that waits on the user (ADR-0020). */}
        <UsageLimitControls taskId={task.id} row={row} onResumeNow={onResumeNow} onCancelResume={onCancelResume} />

        {/* The scheduler leaves it for the user (ADR-0035): it must read as waiting on them, not as next in line. */}
        {row.waitsForApproval && (
          <span className="task-isolation-badge approval"
            title="Added after you approved the plan, so it does not start on its own. Approve it, or Approve all, and it starts once its dependencies finish.">
            {row.waitsForApproval}
          </span>
        )}
        {/* A force start: core approves it, and never starts it before its dependencies finish. */}
        {row.waitsForApproval && onForceStart && (
          <button type="button" className="task-log-open-btn"
            onClick={(e) => { e.stopPropagation(); onForceStart(task.id); }}
            title="Approve it to run: it starts once its dependencies finish">
            Approve
          </button>
        )}

        <AssignmentFlag row={row} />

        <LoopBadge loop={row.loop} />

        <IsolationBadges row={row} />

        {/* Approvals arrive mid-turn and leave the status alone (ADR-0018,
            A1), so waiting on one is a badge beside it, which opens the log
            where the request is answered. */}
        {row.approvals && chatAvailable && (
          <button type="button" className="task-approval-badge"
            onClick={(e) => { e.stopPropagation(); onOpenLog?.(task.id); }}
            title="The runner is waiting for you to allow or deny a tool call: open the chat to answer">
            {row.approvals}
          </button>
        )}

        {canEditDeps ? (
          <button className="task-dep-badge dep-in task-dep-badge-btn"
            title={task.dependencies.length > 0
              ? `Depends on: ${row.dependencies.join(', ')}. Click to edit`
              : 'Click to set dependencies'}
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setEditingDeps(true); }}>
            &#8593;{task.dependencies.length}
          </button>
        ) : task.dependencies.length > 0 && (
          <span className="task-dep-badge dep-in" title={`Depends on: ${row.dependencies.join(', ')}`}>
            &#8593;{task.dependencies.length}
          </span>
        )}
        {!!dependentCount && (
          <span className="task-dep-badge dep-out" title={`Required by ${dependentCount} task${dependentCount > 1 ? 's' : ''}`}>
            &#8595;{dependentCount}
          </span>
        )}

        {/* The awaiting reason is a badge in its own right (ADR-0018, W1): a
            task held for the user must read as such whether or not a run is
            still being drawn as active — and so must one a failure blocks,
            one on hold, or a skipped one. */}
        {(isExecuting || row.holdReason || row.status === 'failed' || row.status === 'awaiting' || row.status === 'blocked' || row.status === 'skipped') && (
          <StatusBadge status={status} />
        )}
        {/* In the footer rather than in the header, where it held the title's
            last stretch for a button only shown on hover. The host confirms
            removal with a real modal: a `confirm()` here would never fire — VS
            Code sandboxes the webview without `allow-modals`. */}
        {!isExecuting && onRemoveTask && (
          <button className="task-remove-btn" onClick={(e) => { e.stopPropagation(); onRemoveTask(task.id); }} title="Remove task">&#10005;</button>
        )}
      </div>
    </div>
  );
}
