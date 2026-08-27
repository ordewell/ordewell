import React, { useState } from 'react';
import ModelSelector, { getModelClass, providerLabel } from './ModelSelector';
import { taskOrderLabel } from '@ordewell/core/order-labels';
import type { Task, DiscoveredModel, TaskModelAssignment } from '@ordewell/core';
import { TaskCheck } from './TaskCard';
import { runnerOptionsFor } from './TaskCard';
import type { RunnerMode, RunnerOption } from './TaskCard';

interface SubTaskCardProps {
  task: Task;
  /** The subtask's parent, used to build its dotted order label (e.g. "2.1"). */
  parentTask?: Task;
  models: DiscoveredModel[];
  modes?: RunnerMode[];
  runners?: RunnerOption[];
  effectiveRunner?: string;
  configuredProviders?: ('openrouter' | 'google' | 'openai_compatible')[];
  modelApiMapping?: Record<string, ('openrouter' | 'google' | 'openai_compatible')[]>;
  isExecuting?: boolean;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  onModelsRefreshNeeded?: () => void;
  onModeChange?: (taskId: string, mode: string) => void;
  onRemoveTask?: (taskId: string) => void;
  onPromptChange?: (taskId: string, prompt: string) => void;
  onRetry?: (taskId: string) => void;
  onSkip?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onForceStart?: (taskId: string) => void;
  onMarkComplete?: (taskId: string) => void;
  onMarkIncomplete?: (taskId: string) => void;
  onRunTask?: (taskId: string) => void;
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  completed: { label: 'Done', cls: 'status-completed' },
  failed: { label: 'Failed', cls: 'status-failed' },
  in_progress: { label: 'Running', cls: 'status-running' },
  blocked: { label: 'Blocked', cls: 'status-blocked' },
  pending: { label: 'To do', cls: 'status-pending' },
  approved: { label: 'To do', cls: 'status-pending' },
  awaiting_user: { label: 'Awaiting User', cls: 'status-blocked' },
};

const DEFAULT_MODES: RunnerMode[] = [
  { id: 'build', label: 'Build', description: 'Edit files and run commands' },
  { id: 'plan', label: 'Plan', description: 'Read-only analysis' },
];

const RUNNER_ABBREV: Record<string, string> = {
  'claude-code': 'CC',
  'opencode': 'OC',
};

export default function SubTaskCard({ task, parentTask, models, modes, runners, effectiveRunner, configuredProviders, modelApiMapping, isExecuting, onRunnerChange, onModelChange, onModelsRefreshNeeded, onModeChange, onRemoveTask, onPromptChange, onRetry: _onRetry, onSkip, onCancel, onForceStart, onMarkComplete, onMarkIncomplete, onRunTask }: SubTaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);

  const modelClass = task.assignedModel ? getModelClass(task.assignedModel.modelId) : '';
  const activeModes = modes && modes.length > 0 ? modes : DEFAULT_MODES;
  const runnerOptions = runnerOptionsFor(runners, task.assignedRunner);
  const runnerAbbrev = effectiveRunner ? (RUNNER_ABBREV[effectiveRunner] ?? effectiveRunner.slice(0, 2).toUpperCase()) : null;
  const status = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;

  const handlePromptSave = () => {
    if (editingPrompt !== null && editingPrompt !== task.prompt) {
      onPromptChange?.(task.id, editingPrompt);
    }
    setEditingPrompt(null);
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePromptSave();
    if (e.key === 'Escape') setEditingPrompt(null);
  };

  return (
    <div className={`subtask-card ${expanded ? 'expanded' : ''}`}>
      <div className="subtask-card-header" onClick={() => setExpanded(!expanded)}>
        <TaskCheck status={task.status} taskId={task.id} onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />
        <span className="subtask-order">{taskOrderLabel(task, parentTask)}.</span>
        <span className={`task-type-badge small ${task.type}`}>
          {task.type === 'ai' ? 'AI' : 'Manual'}
        </span>
        <span className="subtask-title-text">{task.title}</span>

        {(isExecuting || task.status === 'failed') && (
          <span className={`task-status-badge ${status.cls}`}>{status.label}</span>
        )}

        {!isExecuting && task.assignedModel && (
          <span className={`task-model-badge ${modelClass}`}>
            {task.assignedModel.modelLabel}
            {(() => {
              const m = models.find((x) => x.modelId === task.assignedModel!.modelId);
              const rp = m?.runnerProvider || task.assignedModel!.modelId.split('/')[0];
              if (rp) {
                return <> &middot; {providerLabel(rp, m?.runnerProviderLabel)}</>;
              }
              return null;
            })()}
            {task.assignedModel.thinkingEffort && (
              <> &middot; {task.assignedModel.thinkingEffort}</>
            )}
            {runnerAbbrev && (
              <span className="task-runner-abbrev">{runnerAbbrev}</span>
            )}
          </span>
        )}

        {/* Confirmed by the host's modal — a webview `confirm()` is sandboxed away. */}
        {!isExecuting && onRemoveTask && (
          <button className="task-remove-btn" onClick={(e) => { e.stopPropagation(); onRemoveTask(task.id); }} title="Remove subtask">&#10005;</button>
        )}

        <span className={`task-expand-icon ${expanded ? 'open' : ''}`}>&#9654;</span>
      </div>

      {expanded && (
        <div className="subtask-card-body">
          {!isExecuting && task.type === 'ai' && task.prompt && (
            editingPrompt === null ? (
              <div className="subtask-prompt subtask-prompt-editable" onClick={(e) => { e.stopPropagation(); setEditingPrompt(task.prompt ?? ''); }} title="Click to edit prompt">
                {task.prompt}
                <span className="task-prompt-edit-icon">&#9998;</span>
              </div>
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

          {isExecuting && task.type === 'ai' && task.prompt && (
            <div className="subtask-prompt subtask-prompt-readonly">{task.prompt}</div>
          )}

          {/* Runner first: it decides which models, efforts and modes exist below it. */}
          {!isExecuting && task.type === 'ai' && runnerOptions.length > 0 && onRunnerChange && (
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

          {!isExecuting && task.type === 'ai' && models.length > 0 && onModelChange && (
            <ModelSelector models={models} currentModel={task.assignedModel}
              configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
              onChange={(assignment) => onModelChange(task.id, assignment)}
              onOpen={onModelsRefreshNeeded} />
          )}

          {!isExecuting && task.type === 'ai' && onModeChange && (
            <div className="model-selector" style={{ marginTop: '8px' }}>
              <label htmlFor={`subtask-mode-${task.id}`}>Mode</label>
              <select id={`subtask-mode-${task.id}`} value={task.taskMode ?? activeModes[0]?.id ?? 'build'}
                onChange={(e) => onModeChange(task.id, e.target.value)}>
                {activeModes.map((m) => (
                  <option key={m.id} value={m.id}>{m.label} — {m.description}</option>
                ))}
              </select>
            </div>
          )}

          {!isExecuting && task.type === 'ai' && onRunTask && (
            <div className="task-run-btn-wrapper">
              <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); onRunTask(task.id); }}>
                Run Task
              </button>
            </div>
          )}

          {task.verdict && (
            <div className={`task-review ${task.verdict.outcome === 'pass' ? 'review-pass' : 'review-neutral'}`}>
              <div className="task-review-summary">
                {task.verdict.outcome === 'pass' ? 'Verified' : 'Failed verification'} — {task.verdict.reason}
              </div>
              {task.verdict.checks.length > 0 && (
                <div className="task-review-checks">
                  {task.verdict.checks.map((check) => (
                    <div key={check.name} className={`check-item ${check.skipped ? 'check-skipped' : check.passed ? 'check-passed' : 'check-failed'}`}>
                      <span className="check-icon">{check.skipped ? '\u00D7' : check.passed ? '\u2713' : '\u2717'}</span>
                      <span className="check-name">{check.name === 'completion_marker' ? 'Completion Marker' : check.name === 'exit_code' ? 'Exit Code' : check.name === 'workspace_changes' ? 'Changes' : check.name === 'verify_command' ? 'Verify Command' : 'Model Review'}</span>
                      <span className="check-status">{check.skipped ? 'skipped' : check.passed ? 'passed' : 'failed'}</span>
                      {check.detail && <span className="check-detail">{check.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isExecuting && (
            <div className="task-actions">
              {task.status === 'in_progress' && onCancel && (
                <button className="task-action-btn cancel" onClick={(e) => { e.stopPropagation(); onCancel(task.id); }}>Cancel</button>
              )}
              {task.status === 'in_progress' && task.type === 'ai' && onMarkComplete && (
                <button className="task-action-btn start" onClick={(e) => { e.stopPropagation(); onMarkComplete(task.id); }}>Mark Complete</button>
              )}
              {(task.status === 'pending' || task.status === 'approved') && task.type === 'ai' && onForceStart && (
                <button className="task-action-btn start" onClick={(e) => { e.stopPropagation(); onForceStart(task.id); }}>Force Start</button>
              )}
              {(task.status === 'pending' || task.status === 'approved') && onSkip && (
                <button className="task-action-btn skip" onClick={(e) => { e.stopPropagation(); onSkip(task.id); }}>Skip</button>
              )}
              {task.status === 'awaiting_user' && onMarkComplete && (
                <button className="task-action-btn start" onClick={(e) => { e.stopPropagation(); onMarkComplete(task.id); }}>Verify / Mark Complete</button>
              )}
              {task.status === 'completed' && onMarkIncomplete && (
                <button className="task-action-btn skip" onClick={(e) => { e.stopPropagation(); onMarkIncomplete(task.id); }}>Mark Not Done</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
