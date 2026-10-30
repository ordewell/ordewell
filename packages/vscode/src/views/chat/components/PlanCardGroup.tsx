import React, { useState, useMemo } from 'react';
import TaskCard from './TaskCard';
import NewTaskCard from './NewTaskCard';
import type { TaskDraft } from './NewTaskCard';
import type { RunnerMode, RunnerOption } from './TaskCard';
import { Task, DiscoveredModel, TaskModelAssignment, RunTask, RunView, type AssignmentScope } from '@ordewell/core';
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
  /** Owned by the host surface when it must close the open card itself (Esc). */
  expandedTaskId?: string | null;
  onExpandedTaskChange?: (taskId: string | null) => void;
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
  expandedTaskId: expandedTaskIdProp,
  onExpandedTaskChange,
}: PlanCardGroupProps) {
  // Accordion: at most one top-level task open at a time.
  const [internalExpandedTaskId, setInternalExpandedTaskId] = useState<string | null>(null);
  const expandedTaskId = expandedTaskIdProp !== undefined ? expandedTaskIdProp : internalExpandedTaskId;
  const setExpandedTaskId = onExpandedTaskChange ?? setInternalExpandedTaskId;
  const totalUsage = tasksTotalText(tasks);
  const sorted = [...tasks].sort((a, b) => a.order - b.order);

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
  const stopNow = !!onStopExecution && (isExecuting || runActive);
  const showExecute = !isStarting && !isExecuting && !runActive && !!onExecutePlan;

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
      {(onExecutePlan || onStopExecution || isStarting || runActive || (onApproveAll && anyWaitsForApproval)) && (
        <div className="plan-action-bar">
          {isStarting && (
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
          {onApproveAll && anyWaitsForApproval && !isStarting && (
            <button className="plan-action-btn approve" onClick={onApproveAll}
              title="Approve every task that waits for your approval: each starts once its dependencies finish">
              Approve all
            </button>
          )}
        </div>
      )}
      <div className="task-list">
        {sorted.map((task) => {
          const effectiveRunner = task.assignedRunner;
          // Prefer this runner's discovered set; fall back to the flat merged
          // list only when the runner has NO models (an empty array is truthy —
          // guard on length so a degraded/empty runner doesn't render an empty
          // picker instead of the superset).
          const runnerModels = effectiveRunner ? modelsByRunner?.[effectiveRunner] : undefined;
          const taskModels = runnerModels && runnerModels.length > 0 ? runnerModels : models;
          const taskModes = effectiveRunner ? (modesByRunner?.[effectiveRunner] ?? []) : [];

          return (
            <div key={task.id} className="task-card-with-actions">
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
                expanded={expandedTaskId === task.id}
                onExpandedChange={(next) => setExpandedTaskId(next ? task.id : null)}
              />
            </div>
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
