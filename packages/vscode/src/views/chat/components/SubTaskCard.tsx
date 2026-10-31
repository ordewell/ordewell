import React, { useEffect, useState } from 'react';
import SkillChips from './SkillChips';
import ModelSelector from './ModelSelector';
import TaskAssignment, { TaskAssignmentReadout } from './TaskAssignment';
import TaskHandoff from './TaskHandoff';
import { cardEditable, pausedOnLimit, taskRefOf, taskRowView } from '@ordewell/core/plan-utils';
import type { Task, DiscoveredModel, TaskModelAssignment, TaskRowAction, AssignmentScope } from '@ordewell/core';
import { AssignmentFlag, IsolationBadges, StatusBadge, TaskActions, TaskCheck, TaskMarkControl, TaskRevertControl, UsageLimitControls, runnerOptionsFor, statusBadge } from './TaskCard';
import type { RunnerMode, RunnerOption, TaskCardRun } from './TaskCard';
import { checkLabel } from '../checkLabel';

interface SubTaskCardProps {
  task: Task;
  /** The subtask's parent, used to build its dotted order label (e.g. "2.1"). */
  parentTask?: Task;
  /** The plan tree, which tells what a failure blocks and labels it. */
  tasks?: Task[];
  models: DiscoveredModel[];
  modes?: RunnerMode[];
  runners?: RunnerOption[];
  runnerScope?: AssignmentScope;
  effectiveRunner?: string;
  configuredProviders?: ('openrouter' | 'google' | 'openai_compatible')[];
  modelApiMapping?: Record<string, ('openrouter' | 'google' | 'openai_compatible')[]>;
  isExecuting?: boolean;
  /** Anything that could still move a task on without being asked; defaults to `isExecuting`. */
  runActive?: boolean;
  /** This subtask's own run entry: what its status badges read, as a task's do. */
  run?: TaskCardRun;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  onModelsRefreshNeeded?: () => void;
  onModeChange?: (taskId: string, mode: string) => void;
  taskSkills?: { name: string; description: string }[];
  onSkillsChange?: (taskId: string, skills: string[]) => void;
  onRemoveTask?: (taskId: string) => void;
  onPromptChange?: (taskId: string, prompt: string) => void;
  onRetry?: (taskId: string) => void;
  onSkip?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onCancelResume?: (taskId: string) => void;
  onResumeNow?: (taskId: string) => void;
  onForceStart?: (taskId: string) => void;
  onMarkComplete?: (taskId: string) => void;
  onMarkIncomplete?: (taskId: string) => void;
  onRevert?: (taskId: string) => void;
  onRunTask?: (taskId: string) => void;
  /** Open (or focus) this subtask's log tab (ADR-0018, V1). */
  onOpenLog?: (taskId: string) => void;
}

const ACTION_LABELS: Record<TaskRowAction, string> = {
  cancel: 'Cancel', 'resume-now': 'Resume Now', 'cancel-resume': 'Don\'t Resume', skip: 'Skip', 'force-start': 'Force Start', complete: 'Mark Complete', uncomplete: 'Mark Not Done',
};

const DEFAULT_MODES: RunnerMode[] = [
  { id: 'build', label: 'Build', description: 'Edit files and run commands' },
  { id: 'plan', label: 'Read-only', description: 'Ordewell commands; lands nothing' },
];

export default function SubTaskCard({ task, parentTask, tasks, models, modes, runners, runnerScope, configuredProviders, modelApiMapping, isExecuting, runActive, run, onRunnerChange, onModelChange, onModelsRefreshNeeded, onModeChange, taskSkills, onSkillsChange, onRemoveTask, onPromptChange, onRetry, onSkip, onCancel, onCancelResume, onResumeNow, onForceStart, onMarkComplete, onMarkIncomplete, onRevert, onRunTask, onOpenLog }: SubTaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);

  const activeModes = modes && modes.length > 0 ? modes : DEFAULT_MODES;
  const runnerOptions = runnerOptionsFor(runners, task.assignedRunner);
  const handoff = run ? run.handoff : task.handoff;
  // The run's word on this subtask, as on a top-level card: approvals, its
  // isolation and merge gate, and the scheduler's hold are all its own.
  const isolation = run?.isolation ?? null;
  const row = taskRowView({
    ...task,
    handoff,
    idleSince: run?.idleSince ?? null,
    completionReceived: run?.completionReceived,
    attaching: run?.attaching,
    awaitingApproval: run?.awaitingApproval ?? 0,
    isolation,
    mergeGate: run?.mergeGate,
    holdReason: run?.holdReason,
    loopStranded: run?.loopStranded === true,
    continuable: run?.continuable === true,
    waitsForApproval: run?.waitsForApproval === true,
    attempted: run?.attempted ?? task.attempted,
    ...(run?.attemptUsage ? { attemptUsage: run.attemptUsage } : {}),
    ...(run ? { verdict: run.verdict ?? task.verdict, loopRound: run.loopRound } : {}),
  }, { parent: parentTask, placement: 'subtask', tasks, runnerScope });
  const status = statusBadge(row);
  const failed = task.status === 'failed';
  // A subtask's own state decides, never its parent's: a queued subtask of a
  // running parent keeps its editors, and one that has started keeps none. The
  // run's status is the newer word: `task_started` reaches it first.
  const canEdit = cardEditable(runActive ?? !!isExecuting, { status: run?.status ?? task.status }, run
    ? { awaitingApproval: run.awaitingApproval, isolation }
    : undefined);

  useEffect(() => {
    if (!canEdit) setEditingPrompt(null);
  }, [canEdit]);

  // Its own attempt history, never its parent's.
  const chatAvailable = row.chatAvailable;

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

  return (
    <div className="task-with-controls subtask-with-controls">
      <div className={`subtask-card ${expanded ? 'expanded' : ''}`}>
        <div className="subtask-card-header" onClick={() => setExpanded(!expanded)}>
          <TaskCheck row={row} />
          <span className="subtask-order">{row.orderLabel}.</span>
          <span className={`task-type-badge small ${task.type}`}>
            {task.type === 'ai' ? 'AI' : 'Manual'}
          </span>
          <button type="button" className="task-heading" aria-expanded={expanded}
            title={expanded ? 'Collapse task details' : 'Expand task details'}
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
            <span className="subtask-title-text">{task.title}</span>
            <TaskAssignment task={task} />
          </button>

          {/* Confirmed by the host's modal — a webview `confirm()` is sandboxed away. */}
          {!isExecuting && onRemoveTask && (
            <button className="task-remove-btn" onClick={(e) => { e.stopPropagation(); onRemoveTask(task.id); }} title="Remove subtask">&#10005;</button>
          )}
        </div>

        {expanded && (
          <div className="subtask-card-body">
            {handoff && <TaskHandoff handoff={handoff} taskName={(id) => taskRefOf(tasks ?? [], id)}
              onReadFull={onOpenLog && chatAvailable ? () => onOpenLog(task.id) : undefined} />}

            {canEdit && task.type === 'ai' && task.prompt && (
              editingPrompt === null ? (
                <button type="button" className="subtask-prompt subtask-prompt-editable" aria-label={`Edit subtask prompt: ${task.prompt}`}
                  onClick={(e) => { e.stopPropagation(); setEditingPrompt(task.prompt ?? ''); }} title="Click to edit prompt">
                  {task.prompt}
                  <span className="task-prompt-edit-icon">&#9998;</span>
                </button>
              ) : (
                <div className="task-prompt-edit-wrapper">
                  <textarea className="task-prompt-textarea" value={editingPrompt} onChange={(e) => setEditingPrompt(e.target.value)}
                    onBlur={handlePromptSave} onKeyDown={handlePromptKeyDown} onClick={(e) => e.stopPropagation()}
                    rows={Math.min(editingPrompt.split('\n').length, 12)} autoFocus />
                  <div className="task-prompt-edit-actions">
                    <span className="task-prompt-edit-hint">Ctrl+Enter to save &middot; Esc to cancel</span>
                    <button className="task-prompt-save-btn" onMouseDown={(e) => { e.preventDefault(); handlePromptSave(); }}>Save</button>
                  </div>
                </div>
              )
            )}

            {!canEdit && task.type === 'ai' && task.prompt && (
              <div className="subtask-prompt subtask-prompt-readonly">{task.prompt}</div>
            )}

            {/* A subtask execution has reached shows what its pickers decided; one still queued keeps them. */}
            {!canEdit && <TaskAssignmentReadout task={task} />}

            {/* Runner first: it decides which models, efforts and modes exist below it. */}
            {canEdit && task.type === 'ai' && runnerOptions.length > 0 && onRunnerChange && (
              <div className="model-selector" style={{ marginTop: '8px' }}>
                <label htmlFor={`subtask-runner-${task.id}`}>Runner</label>
                <select id={`subtask-runner-${task.id}`} value={task.assignedRunner}
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
                <label htmlFor={`subtask-mode-${task.id}`}>Mode</label>
                <select id={`subtask-mode-${task.id}`} value={task.taskMode ?? activeModes[0]?.id ?? 'build'}
                  onChange={(e) => onModeChange(task.id, e.target.value)}>
                  {activeModes.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}: {m.description}</option>
                  ))}
                </select>
              </div>
            )}

            {task.type === 'ai' && (
              <SkillChips idPrefix="subtask" taskId={task.id} skills={task.skills} catalog={taskSkills}
                onChange={canEdit ? onSkillsChange : undefined} />
            )}

            {!isExecuting && task.type === 'ai' && !failed && onRunTask && (
              <div className="task-run-btn-wrapper">
                <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); onRunTask(task.id); }}>
                  Run Task
                </button>
              </div>
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
                        <span className="check-icon">{check.skipped ? '\u00D7' : check.passed ? '\u2713' : '\u2717'}</span>
                        <span className="check-name">{checkLabel(check.name)}</span>
                        <span className="check-status">{check.skipped ? 'skipped' : check.passed ? 'passed' : 'failed'}</span>
                        {check.detail && <span className="check-detail">{check.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* A usage-limit pause holds the run, which then reads as not
                executing; a failure usually ends it, as on a top-level card. */}
            {(isExecuting || pausedOnLimit(task) || failed) && (
              <TaskActions taskId={task.id} actions={row.actions}
                labels={ACTION_LABELS}
                handlers={{ cancel: onCancel, 'resume-now': onResumeNow, 'cancel-resume': onCancelResume, skip: onSkip, 'force-start': onForceStart }}
                onRetry={failed && task.type !== 'user' ? onRetry : undefined} />
            )}

            <TaskMarkControl taskId={task.id} row={row} runActive={runActive ?? !!isExecuting}
              onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />

            <TaskRevertControl taskId={task.id} title={task.title} row={row} onRevert={onRevert} />
          </div>
        )}
      </div>
      <div className="task-footer-controls">
        {onOpenLog && chatAvailable && (
          <button type="button" className="task-log-open-btn"
            onClick={(e) => { e.stopPropagation(); onOpenLog(task.id); }}
            title="Open this task's chat in an editor tab">
            Open chat
          </button>
        )}

        {/* The run's word on this subtask, as on a top-level card. */}
        {row.waitsForApproval && (
          <span className="task-isolation-badge approval"
            title="Added after you approved the plan, so it does not start on its own. Approve it, or Approve all, and it starts once its dependencies finish.">
            {row.waitsForApproval}
          </span>
        )}
        {row.waitsForApproval && onForceStart && (
          <button type="button" className="task-log-open-btn"
            onClick={(e) => { e.stopPropagation(); onForceStart(task.id); }}
            title="Approve it to run: it starts once its dependencies finish">
            Approve
          </button>
        )}

        <IsolationBadges row={row} />

        {row.approvals && chatAvailable && (
          <button type="button" className="task-approval-badge"
            onClick={(e) => { e.stopPropagation(); onOpenLog?.(task.id); }}
            title="The runner is waiting for you to allow or deny a tool call: open the chat to answer">
            {row.approvals}
          </button>
        )}

        {(isExecuting || row.holdReason || row.status === 'failed' || row.status === 'awaiting' || row.status === 'blocked' || row.status === 'skipped') && (
          <StatusBadge status={status} />
        )}

        <AssignmentFlag row={row} />

        <UsageLimitControls taskId={task.id} row={row} onResumeNow={onResumeNow} onCancelResume={onCancelResume} />
      </div>
    </div>
  );
}
