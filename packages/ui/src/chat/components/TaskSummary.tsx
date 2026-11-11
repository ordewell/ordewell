import React from 'react';
import { loopRowParts, scriptTaskText } from '@ordewell/core/plan-utils';
import type { Task, TaskRowView, TaskStatusKind } from '@ordewell/core';
// The design kit's runner badge and status shape, by path: chat stays free of
// Lucide, which neither runners.tsx nor status.tsx imports.
import { RunnerBadge } from '../../design/runners';
import { effortLabel, modelLabel } from '../../design/assignment';
import { StatusIndicator, statusLineOf, statusOf, type StatusLook } from '../../design/status';
import TaskAssignment, { assignmentLabel } from './TaskAssignment';

/**
 * Comfortable is the two-line header a card opens from: the title, then the
 * runner, model and effort. Compact is one line, with the runner badge kept
 * and the model and effort in the tooltip. Row is the plan panel's: status and
 * title, then the assignment, then the status word with its reason
 * (docs/desktop/design.md, Task row, card and header contents).
 */
export type TaskSummaryDensity = 'compact' | 'comfortable' | 'row';

export interface TaskSummaryProps {
  task: Task;
  row: TaskRowView;
  density?: TaskSummaryDensity;
  /** With `onToggle`, the summary opens and closes the details below it. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Shown only once an attempt has started, since only then is there a chat to open. */
  onOpenChat?: () => void;
  /**
   * The attention and loop badges, after the heading. A host that draws them
   * in a row of its own (the VS Code card's footer, with its actions) turns
   * them off here and renders `TaskSummaryBadges` there.
   */
  badges?: boolean;
  /** What a host adds under the title: a delegated task's subplanner link and counts. On a row, the actions its status line offers. */
  children?: React.ReactNode;
  className?: string;
  /** A row's status, when the host knows more than core: a done task whose work is not merged yet waits for merge. */
  status?: StatusLook;
  /** Since when a quiet task has been quiet, for a row's status line. */
  idleSince?: string | null;
}

/**
 * The whole header opens and closes the card, but a control inside it does
 * its own thing, and dragging across the title to copy it is not a click.
 * The heading button is the header's keyboard toggle, so the header itself
 * takes the mouse alone and nests no button role around its buttons.
 */
function headerClick(onToggle: (() => void) | undefined): React.MouseEventHandler<HTMLDivElement> | undefined {
  if (!onToggle) return undefined;
  return (e) => {
    const target = e.target as HTMLElement;
    const control = target.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]');
    if (control && e.currentTarget.contains(control)) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    onToggle();
  };
}

/**
 * One task's status, order, kind, title and assignment, the same wherever a
 * task is listed, so no two surfaces can disagree about it: the row view is
 * decided in core (`taskRowView`) and only drawn here.
 */
export default function TaskSummary(props: TaskSummaryProps) {
  if (props.density === 'row') return <TaskSummaryRow {...props} />;
  const { task, row, density = 'comfortable', expanded, onToggle, onOpenChat, badges = true, children, className } = props;
  const compact = density === 'compact';
  const openChat = onOpenChat && row.chatAvailable ? onOpenChat : undefined;
  const classes = ['task-card-header', 'task-summary', `task-summary-${density}`, className].filter(Boolean).join(' ');
  return (
    <div className={classes} onClick={headerClick(onToggle)} title={compact ? assignmentLabel(task) || undefined : undefined}>
      <span className="task-card-lead">
        <TaskCheck row={row} />
        <span className="task-order">{row.orderLabel}</span>
        <KindBadges task={task} row={row} />
      </span>
      <div className={`task-heading-block${openChat ? ' task-heading-block-with-log' : ''}`}>
        {onToggle ? (
          <button type="button" className="task-heading" aria-expanded={expanded}
            title={expanded ? 'Collapse task details' : 'Expand task details'}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <span className="task-title-text">{task.title}</span>
          </button>
        ) : (
          <span className="task-heading"><span className="task-title-text">{task.title}</span></span>
        )}
        {/* Outside the heading button, so Open chat can share its line without nesting a button in a button. */}
        {compact
          ? task.type === 'ai' && task.assignedRunner && <span className="task-assignment"><RunnerBadge runner={task.assignedRunner} short className="task-assignment-runner" /></span>
          : <TaskAssignment task={task} />}
        {children}
        {openChat && (
          <button type="button" className="task-log-open-btn task-log-open-btn-stacked"
            aria-label="Open chat"
            onClick={(e) => { e.stopPropagation(); openChat(); }}
            title="Open this task's chat in an editor tab">
            <span>Open</span>
            <span>chat</span>
          </button>
        )}
      </div>
      {badges && <span className="task-summary-badges"><TaskSummaryBadges row={row} /></span>}
    </div>
  );
}

/** The second line of a row: who runs it and how, or for a script the command it runs. */
function rowAssignment(task: Task, row: TaskRowView): React.ReactNode {
  if (row.kind === 'script') {
    const command = scriptTaskText(task).split('\n')[0];
    return <code className="task-row-command" title={command}>{command}</code>;
  }
  if (task.type !== 'ai') return null;
  const effort = task.assignedModel?.thinkingEffort;
  const label = [modelLabel(task.assignedModel), effort && effortLabel(effort)].filter(Boolean).join(' · ');
  return (
    <>
      {task.assignedRunner && <RunnerBadge runner={task.assignedRunner} className="task-assignment-runner" />}
      <span className="task-row-model" title={label}>{label}</span>
    </>
  );
}

/**
 * The plan panel's row: three lines in a tall, narrow panel, so the title gets
 * the whole width of its line. The title button is the row's name for a screen
 * reader, worded as the graph names its node ("#2 Add the route, needs you"),
 * so the panel and the graph never describe one task differently.
 */
function TaskSummaryRow({ task, row, expanded, onToggle, onOpenChat, badges = true, children, className, status, idleSince }: TaskSummaryProps) {
  const look = status ?? statusOf(row.status);
  const line = statusLineOf(row, look, idleSince);
  const name = `#${row.orderLabel} ${task.title}, ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  const openChat = onOpenChat && row.chatAvailable ? onOpenChat : undefined;
  const assignment = rowAssignment(task, row);
  const classes = ['task-card-header', 'task-summary', 'task-summary-row', `task-row-${look.tone}`, className].filter(Boolean).join(' ');
  return (
    <div className={classes} data-status={look.id} onClick={headerClick(onToggle)}>
      <div className="task-row-line task-row-head">
        <StatusIndicator status={look.id} size={14} label={line} />
        <span className="task-order">{row.orderLabel}</span>
        <KindBadges task={task} row={row} ai={false} />
        {onToggle ? (
          <button type="button" className="task-heading" aria-expanded={expanded} aria-label={name} title={task.title}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <span className="task-title-text">{task.title}</span>
          </button>
        ) : (
          <span className="task-heading" aria-label={name}><span className="task-title-text">{task.title}</span></span>
        )}
      </div>
      {assignment && <div className="task-row-line task-row-assignment">{assignment}</div>}
      <div className="task-row-line task-row-status">
        <span className="task-row-status-text" title={line}>{line}</span>
        {badges && <TaskSummaryBadges row={row} />}
        {children}
        {openChat && (
          <button type="button" className="task-row-action" aria-label="Open chat" title="Open this task's chat in a tab"
            onClick={(e) => { e.stopPropagation(); openChat(); }}>
            Open chat
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What kind of work the task is: the one word for its type, then Research or
 * Ops beside it. A row leaves out AI, the kind nearly every task is, so the
 * badge it does show is one that says something.
 */
function KindBadges({ task, row, ai = true }: { task: Task; row: Pick<TaskRowView, 'kind' | 'research'>; ai?: boolean }) {
  const word = task.type === 'user' ? 'Manual' : row.kind === 'script' ? 'Script' : row.kind === 'delegated' ? 'Delegated' : ai ? 'AI' : null;
  return (
    <>
      {word && <span className={`task-type-badge ${task.type}`}>{word}</span>}
      {row.research && (
        <span className="task-type-badge research" title="A research task: read-only, it lands nothing. Its report comes back to the planner and wakes it when the task ends.">Research</span>
      )}
      {row.kind === 'ops' && (
        <span className="task-type-badge ops" title="An ops task: it changes no repository files and runs in your checkout, once the work it depends on is merged">Ops</span>
      )}
    </>
  );
}

/** The badges that ask for the user or say where a loop is: a stale assignment, the loop's round, a merge gate, a conflict or its repair. */
export function TaskSummaryBadges({ row }: { row: Pick<TaskRowView, 'assignmentFlag' | 'assignmentConsequence' | 'loop' | 'mergeGate' | 'conflict' | 'repairing' | 'repairWaiting'> }) {
  return (
    <>
      <AssignmentFlag row={row} />
      <LoopBadge loop={row.loop} />
      <IsolationBadges row={row} />
    </>
  );
}

/**
 * A loop's check says its round, and each body task which check it runs for
 * (ADR-0045); what the loop waits for or stopped at is in the hover.
 */
export function LoopBadge({ loop }: { loop: TaskRowView['loop'] }) {
  if (!loop) return null;
  const text = loop.role === 'body' ? loop.label : loop.state === 'waiting' || loop.state === 'ended' ? loop.label : `Loop · ${loop.label}`;
  return (
    <span className={`task-isolation-badge loop ${loop.role === 'check' ? loop.state : 'body'}`} title={loopRowParts(loop).join('. ')}>
      {text}
    </span>
  );
}

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
