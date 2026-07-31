import React, { useState, useCallback, useMemo, useEffect } from 'react';
import TaskCard from './TaskCard';
import NewTaskCard from './NewTaskCard';
import type { TaskDraft } from './NewTaskCard';
import type { RunnerMode, RunnerOption } from './TaskCard';
import { Task, DiscoveredModel, TaskModelAssignment } from '@ordewell/core';
import { canMergeTasks, canSplitTask } from '@ordewell/core/plan-utils';

interface PlanCardGroupProps {
  tasks: Task[];
  models: DiscoveredModel[];
  modelsByRunner?: Partial<Record<string, DiscoveredModel[]>>;
  modesByRunner?: Record<string, RunnerMode[]>;
  /** Installed runners, in registry order — the per-task runner picker's options. */
  runners?: RunnerOption[];
  isExecuting?: boolean;
  runnerLabels?: Record<string, string>;
  /** Tail of each running task's runner output, keyed by task id. */
  taskOutput?: Record<string, string>;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onDependenciesChange?: (taskId: string, dependencies: string[]) => void;
  onAddTask?: (draft: TaskDraft) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  onModeChange?: (taskId: string, mode: string) => void;
  onRemoveTask?: (taskId: string) => void;
  onPromptChange?: (taskId: string, prompt: string) => void;
  onRetry?: (taskId: string) => void;
  onSkip?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onForceStart?: (taskId: string) => void;
  onMarkComplete?: (taskId: string) => void;
  onMarkIncomplete?: (taskId: string) => void;
  onMerge?: (taskIds: string[]) => void;
  onSplit?: (taskId: string) => void;
  onExecutePlan?: () => void;
  onStopExecution?: () => void;
  onRunTask?: (taskId: string) => void;
}

export default function PlanCardGroup({
  tasks,
  models,
  modelsByRunner,
  modesByRunner,
  runners,
  isExecuting,
  runnerLabels: _runnerLabels,
  taskOutput,
  onRunnerChange,
  onDependenciesChange,
  onAddTask,
  onModelChange,
  onModeChange,
  onRemoveTask,
  onPromptChange,
  onRetry,
  onSkip,
  onCancel,
  onForceStart,
  onMarkComplete,
  onMarkIncomplete,
  onMerge,
  onSplit,
  onExecutePlan,
  onStopExecution,
  onRunTask,
}: PlanCardGroupProps) {
  const [mergeSelectedIds, setMergeSelectedIds] = useState<string[]>([]);
  const [mergeValidationError, setMergeValidationError] = useState<string | null>(null);
  const sorted = [...tasks].sort((a, b) => a.order - b.order);
  const taskOrderMap = new Map(tasks.map((t) => [t.id, t.order]));
  const mergeMode = mergeSelectedIds.length > 0;

  const dependentCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      for (const depId of t.dependencies) {
        m.set(depId, (m.get(depId) ?? 0) + 1);
      }
    }
    return m;
  }, [tasks]);

  useEffect(() => {
    if (!mergeValidationError) return;
    const timer = setTimeout(() => setMergeValidationError(null), 4000);
    return () => clearTimeout(timer);
  }, [mergeValidationError]);

  const canMerge = !isExecuting && onMerge && sorted.length > 1;
  const canSplit = !isExecuting && onSplit;

  const handleMergeClick = useCallback((taskId: string) => {
    setMergeSelectedIds((prev) => {
      if (prev.includes(taskId)) {
        return prev.filter((id) => id !== taskId);
      }
      return [...prev, taskId];
    });
    setMergeValidationError(null);
  }, []);

  const handleApplyMerge = useCallback(() => {
    const sortedIds = mergeSelectedIds
      .map((id) => ({ id, order: tasks.find((t) => t.id === id)?.order ?? 0 }))
      .sort((a, b) => a.order - b.order);

    const selectedSet = new Set(sortedIds.map((s) => s.id));
    const allOrderedIds = sorted.map((t) => t.id);
    const minOrderIdx = allOrderedIds.indexOf(sortedIds[0].id);
    const maxOrderIdx = allOrderedIds.indexOf(sortedIds[sortedIds.length - 1].id);

    const hasGap = allOrderedIds
      .slice(minOrderIdx, maxOrderIdx + 1)
      .some((id) => !selectedSet.has(id));

    if (hasGap) {
      const titles = sortedIds.map((s) => `"${tasks.find((t) => t.id === s.id)?.title ?? s.id}"`);
      setMergeValidationError(`Cannot merge non-consecutive tasks. Unselected task(s) exist between ${titles.join(', ')}.`);
      return;
    }

    const compat = canMergeTasks(tasks, sortedIds.map((s) => s.id));
    if (!compat.ok) {
      setMergeValidationError(compat.error ?? 'These tasks cannot be merged.');
      return;
    }

    onMerge?.(sortedIds.map((s) => s.id));
    setMergeSelectedIds([]);
  }, [mergeSelectedIds, tasks, sorted, onMerge]);

  const cancelMerge = useCallback(() => {
    setMergeSelectedIds([]);
    setMergeValidationError(null);
  }, []);

  const handleSplitClick = useCallback((taskId: string) => {
    const compat = canSplitTask(tasks, taskId);
    if (!compat.ok) {
      setMergeValidationError(compat.error ?? 'This task cannot be split.');
      return;
    }
    onSplit?.(taskId);
  }, [tasks, onSplit]);

  const handleMergeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelMerge();
    }
  }, [cancelMerge]);

  return (
    <div className="plan-card-group">
      {mergeMode && (
        <div className="plan-merge-banner" onKeyDown={handleMergeKeyDown}>
          <span>Merge selected tasks (<strong>{mergeSelectedIds.length}</strong> selected)</span>
          <button className="plan-merge-apply" onClick={handleApplyMerge} disabled={mergeSelectedIds.length < 2}>
            Merge {mergeSelectedIds.length} tasks
          </button>
          <button className="plan-merge-cancel" onClick={cancelMerge}>Cancel</button>
        </div>
      )}
      {mergeValidationError && (
        <div className="merge-validation-error-banner" onClick={() => setMergeValidationError(null)}>
          {mergeValidationError}
          <span className="merge-error-dismiss">&times;</span>
        </div>
      )}

      {(onExecutePlan || onStopExecution) && (
        <div className="plan-action-bar">
          {isExecuting ? (
            onStopExecution && (
              <button className="plan-action-btn stop" onClick={onStopExecution}>Stop</button>
            )
          ) : (
            onExecutePlan && (
              <button className="plan-action-btn execute" onClick={onExecutePlan}>Execute Plan</button>
            )
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
          const isMergeSelected = mergeSelectedIds.includes(task.id);
          const isMergeTarget = mergeMode && !isMergeSelected;
          const isMergeSource = isMergeSelected;

          return (
            <div
              key={task.id}
              className={`task-card-with-actions ${isMergeSource ? 'merge-source' : ''} ${isMergeTarget ? 'merge-target' : ''}`}
            >
              <TaskCard
                task={task}
                models={taskModels}
                modes={taskModes}
                runners={runners}
                effectiveRunner={effectiveRunner}
                isExecuting={isExecuting}
                taskOrderMap={taskOrderMap}
                dependentCount={dependentCountMap.get(task.id) ?? 0}
                output={taskOutput?.[task.id]}
                siblings={sorted}
                onDependenciesChange={onDependenciesChange}
                onRunnerChange={onRunnerChange}
                onModelChange={onModelChange}
                onModeChange={onModeChange}
                onRemoveTask={onRemoveTask}
                onPromptChange={onPromptChange}
                onRetry={onRetry}
                onSkip={onSkip}
                onCancel={onCancel}
                onForceStart={onForceStart}
                onMarkComplete={onMarkComplete}
                onMarkIncomplete={onMarkIncomplete}
                onRunTask={onRunTask}
              />
              {/* Gated on having a button to show: an empty action row is still a
                  bordered strip under every card. */}
              {!isExecuting && (canMerge || canSplit) && (
                <div className="task-inline-actions">
                  {canMerge && (
                    <button
                      className={`task-merge-btn ${isMergeSelected ? 'active' : ''}`}
                      onClick={() => handleMergeClick(task.id)}
                      title={isMergeSelected ? 'Deselect task' : mergeMode ? 'Select task to merge' : 'Select tasks to merge'}
                    >
                      {isMergeSelected ? 'Selected' : 'Merge'}
                    </button>
                  )}
                  {canSplit && !mergeMode && (
                    <button className="task-split-btn" onClick={() => handleSplitClick(task.id)} title="Split this task into multiple parts (the planner generates the breakdown)">Split</button>
                  )}
                </div>
              )}
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
