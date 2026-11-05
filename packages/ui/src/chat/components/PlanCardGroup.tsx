import React, { useState, useMemo } from 'react';
import TaskCard, { cardRowView } from './TaskCard';
import PlanHeader from './PlanHeader';
import { statusOf } from '../../design/status';
import NewTaskCard from './NewTaskCard';
import type { TaskDraft } from './NewTaskCard';
import type { RunnerMode, RunnerOption } from './TaskCard';
import type { Task, DiscoveredModel, TaskModelAssignment, RunTask, RunView, AssignmentScope } from '@ordewell/core';
import { tasksTotalText } from '@ordewell/core/plan-utils';

/** What each level allows, in the picker's tooltip: Act's risk is said where it is chosen (ADR-0029). */
interface PlanCardGroupProps {
  tasks: Task[];
  /** The run the host folded: each card's status badges read their own task entry. */
  run: RunView;
  models: DiscoveredModel[];
  modelsByRunner?: Partial<Record<string, DiscoveredModel[]>>;
  modesByRunner?: Record<string, RunnerMode[]>;
  /** Installed runners, in registry order — the per-task runner picker's options. */
  runners?: RunnerOption[];
  /** The enabled runners and allowlist each task is flagged against; absent until the host has sent them. */
  runnerScope?: AssignmentScope;
  isExecuting?: boolean;
  /** A whole-plan start is on its way: show it, and refuse a second one. */
  isStarting?: boolean;
  /** Anything that could still move a task on without being asked (core's `advancesOnItsOwn`): a queued start or usage-limit hold too, so Stop stays reachable and Mark waits. */
  runActive?: boolean;
  runnerLabels?: Record<string, string>;
  /** Tail of each running task's runner output, keyed by task id. */
  taskOutput?: Record<string, string>;
  /** Opt in to resolving a conflicted task's merge as a new AI task. */
  onResolveConflict?: (taskId: string) => void;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onDependenciesChange?: (taskId: string, dependencies: string[]) => void;
  onAddTask?: (draft: TaskDraft) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  onModelsRefreshNeeded?: () => void;
  onModeChange?: (taskId: string, mode: string) => void;
  /** Change versus ops (ADR-0020). */
  onOpsChange?: (taskId: string, ops: boolean) => void;
  /** The `applies-to: task` catalog the skill chips attach from. */
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
  onExecutePlan?: () => void;
  onStopExecution?: () => void;
  /** Approve every task that waits for approval: each starts once its dependencies finish (ADR-0035). */
  onApproveAll?: () => void;
  onRunTask?: (taskId: string) => void;
  /** Message a running or waiting task from its card (ADR-0018, M1; ADR-0023, F1). */
  onSendMessage?: (taskId: string, text: string) => void;
  onSendMessageNow?: (taskId: string, text: string) => void;
  /** Open (or focus) a structured task's log tab (ADR-0018, V1). */
  onOpenLog?: (taskId: string) => void;
  onOpenChild?: (taskId: string) => void;
  /** Owned by the host surface when it must close the open card itself (Esc). */
  expandedTaskId?: string | null;
  onExpandedTaskChange?: (taskId: string | null) => void;
  /**
   * Draw the plan for a tall, narrow panel (docs/desktop/design.md, W4): a
   * header with the goal and progress, tasks grouped by stage, compact rows
   * that open into the full card when selected.
   */
  rows?: boolean;
  /** The goal the header names; drawn only with `rows`. */
  goal?: string;
  /** Execute and Stop, where the host has no run controls of its own (the desktop's title bar has them). */
  runControls?: boolean;
}

/**
 * Each top-level task's stage: 1 with no dependencies, else one past the
 * latest stage it waits on. A dependency on a subtask counts as one on the
 * task that holds it, as the graph draws it; a loop falls back to stage 1.
 */
export function stagesOf(tasks: readonly Task[]): Map<string, number> {
  const owner = new Map<string, string>();
  for (const task of tasks) {
    const visit = (subs: readonly Task[]): void => subs.forEach((s) => { owner.set(s.id, task.id); visit(s.subtasks ?? []); });
    owner.set(task.id, task.id);
    visit(task.subtasks ?? []);
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stages = new Map<string, number>();
  const visiting = new Set<string>();
  const stageOf = (id: string): number => {
    const known = stages.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let stage = 1;
    for (const dep of byId.get(id)?.dependencies ?? []) {
      const holder = owner.get(dep);
      if (holder && holder !== id) stage = Math.max(stage, stageOf(holder) + 1);
    }
    visiting.delete(id);
    stages.set(id, stage);
    return stage;
  };
  for (const task of tasks) stageOf(task.id);
  return stages;
}

const ROW_HEADING = '.task-row-item > .task-row-card > .task-summary-row .task-heading';

/**
 * The plan panel's keys on a row heading (design.md, Keyboard): ↑ ↓ move to
 * the row above or below; → opens a row that holds subtasks, and ← folds
 * them away again, from the row or from one of its subtasks.
 */
function rowKeys(e: React.KeyboardEvent<HTMLElement>, tasks: readonly Task[], fold: (taskId: string, open: boolean) => void): void {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('task-heading')) return;
  const row = target.closest<HTMLElement>('[data-task-id]');
  const task = tasks.find((t) => t.id === row?.dataset.taskId);
  if (!row || !task) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (task.subtasks.length === 0) return;
    const own = row.querySelector<HTMLElement>(ROW_HEADING) ?? undefined;
    const open = e.key === 'ArrowRight';
    // From a subtask, → has nothing more to open.
    if (open && target !== own) return;
    e.preventDefault();
    fold(task.id, open);
    if (!open) own?.focus();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const headings = [...e.currentTarget.querySelectorAll<HTMLElement>(ROW_HEADING)];
  const at = headings.indexOf(target);
  if (at < 0) return;
  const next = headings[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

export default function PlanCardGroup({
  tasks,
  run,
  models,
  modelsByRunner,
  modesByRunner,
  runners,
  runnerScope,
  isExecuting,
  isStarting,
  runActive: runActiveProp,
  runnerLabels: _runnerLabels,
  taskOutput,
  onResolveConflict,
  onRunnerChange,
  onDependenciesChange,
  onAddTask,
  onModelChange,
  onModelsRefreshNeeded,
  onModeChange,
  onOpsChange,
  taskSkills,
  onSkillsChange,
  onRemoveTask,
  onPromptChange,
  onRetry,
  onSkip,
  onCancel,
  onCancelResume,
  onResumeNow,
  onForceStart,
  onMarkComplete,
  onMarkIncomplete,
  onRevert,
  onExecutePlan,
  onStopExecution,
  onApproveAll,
  onRunTask,
  onSendMessage,
  onSendMessageNow,
  onOpenLog,
  onOpenChild,
  expandedTaskId: expandedTaskIdProp,
  onExpandedTaskChange,
  rows = false,
  goal,
  runControls = true,
}: PlanCardGroupProps) {
  // Accordion: at most one top-level task open at a time.
  const [internalExpandedTaskId, setInternalExpandedTaskId] = useState<string | null>(null);
  const expandedTaskId = expandedTaskIdProp !== undefined ? expandedTaskIdProp : internalExpandedTaskId;
  const setExpandedTaskId = onExpandedTaskChange ?? setInternalExpandedTaskId;
  const totalUsage = tasksTotalText(tasks);
  const stages = useMemo(() => (rows ? stagesOf(tasks) : null), [rows, tasks]);
  // Rows are grouped under one heading per stage: a task ordered after a later stage's still sits in its own.
  const sorted = [...tasks].sort((a, b) => (stages ? stages.get(a.id)! - stages.get(b.id)! : 0) || a.order - b.order);

  // One lookup for every card's own run entry, keyed by id: the plan draws the
  // card, the run tells it what its status badges say.
  const runByTask = useMemo(() => {
    const byId = new Map<string, RunTask>();
    const index = (entries: readonly RunTask[]): void => entries.forEach((t) => { byId.set(t.id, t); index(t.subtasks); });
    index(run.tasks);
    return byId;
  }, [run]);
  // A body task's card reads its check off the plan tree, and the run holds the check's newest verdict and round (ADR-0045).
  const withLoopState = (task: Task): Task => {
    const entry = task.loop && runByTask.get(task.id);
    if (!entry) return task;
    return { ...task, loopRound: entry.loopRound, verdict: entry.verdict ? { ...entry.verdict, decidedAt: task.verdict?.decidedAt ?? '' } : task.verdict };
  };
  const rowTasks = sorted.map(withLoopState);
  const anyWaitsForApproval = useMemo(() => [...runByTask.values()].some((t) => t.waitsForApproval === true), [runByTask]);
  // The run's own word when the host does not pass one: a card is never
  // offered a mark the core would refuse, even when it is drawn from `run`.
  const runActive = runActiveProp ?? run.activity?.advancesOnItsOwn ?? false;
  // Stop is owed to anything that could still move a task on, even when
  // nothing is executing: a force start queued behind its dependencies, or a
  // task waiting out a usage limit. Execute is offered only when nothing is.
  const stopNow = runControls && !!onStopExecution && (isExecuting || runActive);
  // A finished plan has nothing left to execute: Retry restarts a task on its own.
  const finished = sorted.length > 0 && sorted.every((t) => {
    const status = runByTask.get(t.id)?.status ?? t.status;
    return status === 'completed' || status === 'skipped';
  });
  const showExecute = runControls && !finished && !isStarting && !isExecuting && !runActive && !!onExecutePlan;
  const showApproveAll = !!onApproveAll && anyWaitsForApproval && !isStarting;
  const looks = rows ? rowTasks.map((task) => statusOf(cardRowView(task, runByTask.get(task.id), { tasks: rowTasks }).status, {
    unmerged: runByTask.get(task.id)?.isolation?.state === 'integrated' && (!!run.handoff || (run.runMerge?.landed.length ?? 0) > 0),
  })) : [];

  const dependentCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      for (const depId of t.dependencies) {
        m.set(depId, (m.get(depId) ?? 0) + 1);
      }
    }
    return m;
  }, [tasks]);

  return (
    <div className="plan-card-group">
      {totalUsage && <div className="plan-usage">{totalUsage}</div>}
      {rows && <PlanHeader goal={goal} looks={looks} />}
      {(showExecute || stopNow || (runControls && isStarting) || showApproveAll) && (
        <div className="plan-action-bar">
          {runControls && isStarting && (
            <button className="plan-action-btn starting" type="button" disabled aria-busy="true">
              <span className="plan-action-spinner" /> Starting&hellip;
            </button>
          )}
          {stopNow && (
            <button className="plan-action-btn stop" onClick={onStopExecution}>Stop</button>
          )}
          {showExecute && (
            <button className="plan-action-btn execute" onClick={onExecutePlan}>Execute Plan</button>
          )}
          {showApproveAll && (
            <button className="plan-action-btn approve" onClick={onApproveAll}
              title="Approve every task that waits for your approval: each starts once its dependencies finish">
              Approve all
            </button>
          )}
        </div>
      )}
      <div className={`task-list${rows ? ' task-list-rows' : ''}`} onKeyDown={rows ? (e) => rowKeys(e, sorted, (id, open) => setExpandedTaskId(open ? id : null)) : undefined}>
        {sorted.map((task, index) => {
          const effectiveRunner = task.assignedRunner;
          // Prefer this runner's discovered set; fall back to the flat merged
          // list only when the runner has NO models (an empty array is truthy —
          // guard on length so a degraded/empty runner doesn't render an empty
          // picker instead of the superset).
          const runnerModels = effectiveRunner ? modelsByRunner?.[effectiveRunner] : undefined;
          const taskModels = runnerModels && runnerModels.length > 0 ? runnerModels : models;
          const taskModes = effectiveRunner ? (modesByRunner?.[effectiveRunner] ?? []) : [];

          const stage = stages?.get(task.id);
          const previous = index > 0 ? stages?.get(sorted[index - 1]!.id) : undefined;
          // Selecting a row only opens its card: its Open chat button is what opens a tab.
          const select = (next: boolean): void => setExpandedTaskId(next ? task.id : null);
          return (
            <React.Fragment key={task.id}>
            {stage !== undefined && stage !== previous && (
              <h3 className="plan-stage-head">Stage {stage}</h3>
            )}
            <div className="task-card-with-actions" data-task-id={task.id}>
              <TaskCard
                task={task}
                run={runByTask.get(task.id)}
                runsByTask={runByTask}
                models={taskModels}
                modes={taskModes}
                modelsByRunner={modelsByRunner}
                modesByRunner={modesByRunner}
                runners={runners}
                runnerScope={runnerScope}
                effectiveRunner={effectiveRunner}
                isExecuting={isExecuting}
                runActive={runActive}
                dependentCount={dependentCountMap.get(task.id) ?? 0}
                output={taskOutput?.[task.id]}
                onResolveConflict={onResolveConflict}
                siblings={rowTasks}
                onDependenciesChange={onDependenciesChange}
                onRunnerChange={onRunnerChange}
                onModelChange={onModelChange}
                onModelsRefreshNeeded={onModelsRefreshNeeded}
                onModeChange={onModeChange}
                onOpsChange={onOpsChange}
                taskSkills={taskSkills}
                onSkillsChange={onSkillsChange}
                onRemoveTask={onRemoveTask}
                onPromptChange={onPromptChange}
                onRetry={onRetry}
                onSkip={onSkip}
                onCancel={onCancel}
                onCancelResume={onCancelResume}
                onResumeNow={onResumeNow}
                onForceStart={onForceStart}
                onMarkComplete={onMarkComplete}
                onMarkIncomplete={onMarkIncomplete}
                onRevert={onRevert}
                onRunTask={onRunTask}
                onSendMessage={onSendMessage}
                onSendMessageNow={onSendMessageNow}
                onOpenLog={onOpenLog}
                onOpenChild={onOpenChild}
                expanded={expandedTaskId === task.id}
                onExpandedChange={select}
                variant={rows ? 'row' : 'card'}
                status={rows ? looks[index] : undefined}
              />
            </div>
            </React.Fragment>
          );
        })}
      </div>
      {!isExecuting && onAddTask && (
        <NewTaskCard tasks={sorted} runners={runners} models={models}
          modelsByRunner={modelsByRunner} modesByRunner={modesByRunner}
          onAdd={onAddTask} />
      )}
    </div>
  );
}
