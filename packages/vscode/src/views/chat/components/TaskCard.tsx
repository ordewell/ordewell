import React, { useState, useEffect, useRef } from 'react';
import SubTaskCard from './SubTaskCard';
import ModelSelector, { getModelClass, providerLabel } from './ModelSelector';
import DependencyPicker from './DependencyPicker';
import { lastLine } from '../taskOutput';
import { dependencyCandidates } from '@ordewell/core/plan-utils';
import { Task, DiscoveredModel, TaskModelAssignment, TaskIsolation } from '@ordewell/core';

export interface RunnerMode {
  id: string;
  label: string;
  description: string;
  /** Tagged `autonomous: true` on the manifest — runs without permission prompts. */
  autonomous?: boolean;
}

export interface RunnerOption {
  id: string;
  displayName: string;
}

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
  effectiveRunner?: string;
  configuredProviders?: ('openrouter' | 'google' | 'openai_compatible')[];
  modelApiMapping?: Record<string, ('openrouter' | 'google' | 'openai_compatible')[]>;
  isExecuting?: boolean;
  /** Tail of this task's live runner output, if any has arrived. */
  output?: string;
  /** Advisory silence timestamp (VerdictEngine) — set while in_progress with no recent output. */
  idleSince?: string | null;
  /** Per-task isolation state (ADR-0013), only when the plan has an isolation run. */
  isolation?: TaskIsolation | null;
  /** Opt in to resolving this task's merge conflict as an AI task. */
  onResolveConflict?: (taskId: string) => void;
  taskOrderMap?: Map<string, number>;
  dependentCount?: number;
  /** The task list this task belongs to — the dependency editor's candidate pool. */
  siblings?: Task[];
  onDependenciesChange?: (taskId: string, dependencies: string[]) => void;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  /** Called when this task's model dropdown opens, so a stale/degraded catalog self-heals. */
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
  /** Controlled expansion. When both are supplied the parent owns which card is
   *  open (an accordion); omitted, the card keeps its own state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  completed: { label: 'Done', cls: 'status-completed' },
  failed: { label: 'Failed', cls: 'status-failed' },
  in_progress: { label: 'Running', cls: 'status-running' },
  blocked: { label: 'Blocked', cls: 'status-blocked' },
  pending: { label: 'To do', cls: 'status-pending' },
  approved: { label: 'To do', cls: 'status-pending' },
  awaiting_user: { label: 'Awaiting User', cls: 'status-blocked' },
  stalled: { label: 'Stalled', cls: 'status-stalled' },
};

/** Minimal to-do / done indicator: empty ring → pulsing ring → filled check.
 *  The ring is a toggle: clicking an unfinished task marks it executed, clicking
 *  a done one takes it back to not-executed. */
export function TaskCheck({ status, taskId, stalled, onMarkComplete, onMarkIncomplete }: { status: string; taskId?: string; stalled?: boolean; onMarkComplete?: (taskId: string) => void; onMarkIncomplete?: (taskId: string) => void }) {
  const state = status === 'completed' ? 'done' : status === 'in_progress' ? (stalled ? 'stalled' : 'running') : 'todo';
  const toggle = state === 'done' ? onMarkIncomplete : onMarkComplete;
  const clickable = !!toggle && !!taskId;
  const title = state === 'done'
    ? (clickable ? 'Executed — click to mark not done' : 'Executed')
    : state === 'running'
      ? 'Running'
      : state === 'stalled'
        ? 'Stalled — no output recently'
        : (clickable ? 'Click to mark executed' : 'To do');
  return (
    <span
      className={`task-check ${state} ${clickable ? 'clickable' : ''}`}
      title={title}
      onClick={(e) => {
        if (!clickable) return;
        e.stopPropagation();
        toggle!(taskId!);
      }}
    >
      {state === 'done' && (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 8.6l2.4 2.4 5.2-5.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

const RUNNER_ABBREV: Record<string, string> = {
  'claude-code': 'CC',
  'opencode': 'OC',
};

const DEFAULT_MODES: RunnerMode[] = [
  { id: 'build', label: 'Build', description: 'Edit files and run commands' },
  { id: 'plan', label: 'Plan', description: 'Read-only analysis' },
];

/**
 * The runner list a task's picker offers. The task's own runner is always in it,
 * even when missing from the installed set (uninstalled since planning, or a
 * plugin discovery didn't see): a select that dropped it would fall back to
 * displaying some other runner and misreport what the task will be spawned on.
 */
export function runnerOptionsFor(runners: RunnerOption[] | undefined, assignedRunner: string): RunnerOption[] {
  if (!runners || runners.length === 0) return [];
  if (runners.some((r) => r.id === assignedRunner)) return runners;
  return [...runners, { id: assignedRunner, displayName: assignedRunner }];
}

export default function TaskCard({ task, models, modes, modelsByRunner, modesByRunner, runners, effectiveRunner, configuredProviders, modelApiMapping, isExecuting, output, idleSince, isolation, onResolveConflict, taskOrderMap, dependentCount, siblings, onDependenciesChange, onRunnerChange, onModelChange, onModelsRefreshNeeded, onModeChange, onRemoveTask, onPromptChange, onRetry, onSkip, onCancel, onForceStart, onMarkComplete, onMarkIncomplete, onRunTask, expanded: expandedProp, onExpandedChange }: TaskCardProps) {
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

  const hasConflict = isolation?.state === 'conflict';
  const isolatedWork = isolation && isolation.state !== 'none' ? isolation : null;
  // A lone repository at the workspace root is not named: the group of one
  // reads exactly as it did before repo groups existed.
  const changedRepos = isolatedWork ? (isolatedWork.repos ?? []).filter((r) => r !== '.') : [];
  const conflictRepo = isolatedWork?.conflictRepo && isolatedWork.conflictRepo !== '.' ? isolatedWork.conflictRepo : null;

  // A live tail is only useful pinned to its newest line; left alone the pane
  // holds the top of the buffer and the incoming output scrolls out of sight.
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const pre = outputRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [output, expanded]);

  const modelClass = task.assignedModel ? getModelClass(task.assignedModel.modelId) : '';
  // Stalled overrides the spinning "Running" badge — same status, distinct
  // visual, and reverts the instant idleSince clears on resumed output.
  const isStalled = task.status === 'in_progress' && !!idleSince;
  const status = isStalled ? STATUS_CONFIG.stalled : (STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending);
  const isUserTask = task.type === 'user';
  const activeModes = modes && modes.length > 0 ? modes : DEFAULT_MODES;

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

  const toggleStep = (order: number) => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(order)) next.delete(order); else next.add(order);
      return next;
    });
  };

  const allStepsComplete = task.userSteps?.every((s) => completedSteps.has(s.order)) ?? false;

  const runnerAbbrev = effectiveRunner ? (RUNNER_ABBREV[effectiveRunner] ?? effectiveRunner.slice(0, 2).toUpperCase()) : null;
  // Autonomy is a manifest tag on the task's own mode, not a mode name — so this
  // looks the tag up rather than string-matching a mode id (ADR-0001: no
  // hardcoded mode names).
  const modeInfo = activeModes.find((m) => m.id === task.taskMode);

  const runnerOptions = runnerOptionsFor(runners, task.assignedRunner);
  const canEditDeps = !isExecuting && !!onDependenciesChange;

  return (
    <div className={`task-card task-${task.type} ${expanded ? 'expanded' : ''}`}>
      <div className="task-card-header" onClick={() => setExpanded(!expanded)}>
        <TaskCheck status={task.status} taskId={task.id} stalled={isStalled} onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />
        <span className="task-order">{task.order}</span>
        <span className={`task-type-badge ${task.type}`}>
          {isUserTask ? 'Manual' : 'AI'}
        </span>
        <span className="task-title-text">{task.title}</span>

        {/* A stopped integration is not a hidden failure (US33) — visible on the
            collapsed card, since it is the one isolation state that needs a
            decision, not just inspection. */}
        {hasConflict && (
          <span className="task-isolation-badge conflict" title={`Integrating this task conflicted${conflictRepo ? ` in ${conflictRepo}` : ''}. Its worktree and branch are kept.`}>
            Conflict{conflictRepo ? ` in ${conflictRepo}` : ''}
          </span>
        )}

        {(isExecuting || task.status === 'failed') && (
          <>
            <span className={`task-status-dot ${status.cls}`} title={status.label} />
            <span className={`task-status-badge ${status.cls}`}>{status.label}</span>
          </>
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

        {!isExecuting && task.taskMode && (
          <span className="task-type-badge" style={{ background: 'rgba(210,153,29,0.15)', color: 'var(--orange)' }}
            title={modeInfo?.autonomous ? 'Runs without permission prompts — controlled by the "ordewell.autonomousMode" setting' : undefined}>
            {modeInfo?.label ?? task.taskMode}
            {modeInfo?.autonomous && ' ⚡'}
          </span>
        )}

        {canEditDeps ? (
          <button className="task-dep-badge dep-in task-dep-badge-btn"
            title={task.dependencies.length > 0
              ? `Depends on: ${task.dependencies.map((id) => `#${taskOrderMap?.get(id) ?? id}`).join(', ')} — click to edit`
              : 'Click to set dependencies'}
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setEditingDeps(true); }}>
            &#8593;{task.dependencies.length}
          </button>
        ) : task.dependencies.length > 0 && (
          <span className="task-dep-badge dep-in" title={`Depends on: ${task.dependencies.map((id) => `#${taskOrderMap?.get(id) ?? id}`).join(', ')}`}>
            &#8593;{task.dependencies.length}
          </span>
        )}
        {!!dependentCount && (
          <span className="task-dep-badge dep-out" title={`Required by ${dependentCount} task${dependentCount > 1 ? 's' : ''}`}>
            &#8595;{dependentCount}
          </span>
        )}
        {/* The host confirms removal with a real modal. A `confirm()` here would
            never fire — VS Code sandboxes the webview without `allow-modals`. */}
        {!isExecuting && onRemoveTask && (
          <button className="task-remove-btn" onClick={(e) => { e.stopPropagation(); onRemoveTask(task.id); }} title="Remove task">&#10005;</button>
        )}

        <span className={`task-expand-icon ${expanded ? 'open' : ''}`}>&#9654;</span>
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

          {/* Worktrees are an implementation detail unless something needs the
              user's attention (US34) — so the branch and path live in the
              details, and only a conflict earns a header badge. */}
          {isolatedWork && (
            <div className="task-isolation">
              <div className="task-isolation-row"><span className="task-isolation-label">Branch</span><code>{isolatedWork.branch}</code></div>
              <div className="task-isolation-row"><span className="task-isolation-label">Worktree</span><code>{isolatedWork.worktree}</code></div>
              {changedRepos.length > 0 && (
                <div className="task-isolation-row task-isolation-repos"><span className="task-isolation-label">Repos</span><code>{changedRepos.join(', ')}</code></div>
              )}
              {conflictRepo && (
                <div className="task-isolation-row task-isolation-conflict-repo"><span className="task-isolation-label">Conflict</span><code>{conflictRepo}</code></div>
              )}
              {hasConflict && onResolveConflict && (
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
                Depends on: {task.dependencies.length > 0
                  ? task.dependencies.map((depId) => `#${taskOrderMap?.get(depId) ?? depId}`).join(', ')
                  : 'nothing'}
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
            <div className="task-deps">Depends on: {task.dependencies.map((depId) => {
              const order = taskOrderMap?.get(depId);
              return order != null ? `#${order}` : depId;
            }).join(', ')}</div>
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
                      <span className="check-icon">{check.skipped ? '×' : check.passed ? '✓' : '✗'}</span>
                      <span className="check-name">{check.name === 'completion_marker' ? 'Completion Marker' : check.name === 'exit_code' ? 'Exit Code' : check.name === 'workspace_changes' ? 'Changes' : check.name === 'verify_command' ? 'Verify Command' : 'Model Review'}</span>
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
              {onMarkComplete && (
                <div className="step-actions">
                  <button className="step-complete-btn" disabled={!allStepsComplete && task.userSteps!.length > 0}
                    onClick={(e) => { e.stopPropagation(); onMarkComplete(task.id); }}>
                    Mark Complete
                  </button>
                  {!allStepsComplete && task.userSteps!.length > 0 && (
                    <span className="step-hint">Complete all steps above first</span>
                  )}
                </div>
              )}
            </div>
          )}

          {!isExecuting && task.type === 'ai' && task.prompt && (
            editingPrompt === null ? (
              <div className="task-prompt task-prompt-editable" onClick={(e) => { e.stopPropagation(); setEditingPrompt(task.prompt ?? ''); }} title="Click to edit prompt">
                {task.prompt}
                <span className="task-prompt-edit-icon">&#9998;</span>
              </div>
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

          {isExecuting && task.type === 'ai' && task.prompt && (
            <div className="task-prompt task-prompt-readonly">{task.prompt}</div>
          )}

          {/* Runner first: it decides which models, efforts and modes exist below it. */}
          {!isExecuting && task.type === 'ai' && runnerOptions.length > 0 && onRunnerChange && (
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

          {!isExecuting && task.type === 'ai' && models.length > 0 && onModelChange && (
            <ModelSelector models={models} currentModel={task.assignedModel}
              configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
              onChange={(assignment) => onModelChange(task.id, assignment)}
              onOpen={onModelsRefreshNeeded} />
          )}

          {!isExecuting && task.type === 'ai' && onModeChange && (
            <div className="model-selector" style={{ marginTop: '8px' }}>
              <label htmlFor={`task-mode-${task.id}`}>Mode</label>
              <select id={`task-mode-${task.id}`} value={task.taskMode ?? activeModes[0]?.id ?? 'build'}
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
                  <SubTaskCard key={sub.id} task={sub} parentTask={task} models={subModels}
                    modes={subModes} runners={runners} effectiveRunner={subRunner}
                    configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
                    isExecuting={isExecuting}
                    onRunnerChange={onRunnerChange}
                    onModelChange={onModelChange} onModelsRefreshNeeded={onModelsRefreshNeeded} onModeChange={onModeChange}
                    onRemoveTask={onRemoveTask} onPromptChange={onPromptChange}
                    onRetry={onRetry} onSkip={onSkip} onCancel={onCancel}
                    onForceStart={onForceStart} onMarkComplete={onMarkComplete}
                    onMarkIncomplete={onMarkIncomplete}
                    onRunTask={onRunTask} />
                );
              })}
            </div>
          )}

          {isExecuting && (
            <div className="task-actions">
              {task.status === 'in_progress' && onCancel && (
                <button className="task-action-btn cancel" onClick={(e) => { e.stopPropagation(); onCancel(task.id); }}>Cancel</button>
              )}
              {task.status === 'blocked' && onSkip && (
                <button className="task-action-btn skip" onClick={(e) => { e.stopPropagation(); onSkip(task.id); }}>Skip</button>
              )}
              {(task.status === 'blocked' || task.status === 'pending' || task.status === 'approved') && task.type === 'ai' && onForceStart && (
                <button className="task-action-btn start" onClick={(e) => { e.stopPropagation(); onForceStart(task.id); }}>Start</button>
              )}
              {(task.status === 'awaiting_user' || task.type === 'user') && onMarkComplete && (
                <button className="task-action-btn start" onClick={(e) => { e.stopPropagation(); onMarkComplete(task.id); }}>Mark Complete</button>
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
