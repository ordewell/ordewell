import React, { useMemo, useState } from 'react';
import ModelSelector from './ModelSelector';
import DependencyPicker from './DependencyPicker';
import { runnerOptionsFor } from './TaskCard';
import type { RunnerMode, RunnerOption } from './TaskCard';
import { dependencyCandidates } from '@ordewell/core/plan-utils';
import type { DiscoveredModel, Task, TaskModelAssignment } from '@ordewell/core';

/** What the user filled in. Anything left unset is derived host-side by `Session.addTask`. */
export interface TaskDraft {
  title: string;
  prompt?: string;
  assignedRunner?: string;
  assignedModel?: TaskModelAssignment;
  taskMode?: string;
  dependencies: string[];
}

interface NewTaskCardProps {
  tasks: Task[];
  runners?: RunnerOption[];
  models: DiscoveredModel[];
  modelsByRunner?: Partial<Record<string, DiscoveredModel[]>>;
  modesByRunner?: Record<string, RunnerMode[]>;
  configuredProviders?: ('openrouter' | 'google' | 'openai_compatible')[];
  modelApiMapping?: Record<string, ('openrouter' | 'google' | 'openai_compatible')[]>;
  onAdd: (draft: TaskDraft) => void;
}

function assignmentFor(model: DiscoveredModel): TaskModelAssignment {
  return {
    modelId: model.modelId,
    modelLabel: model.modelLabel,
    thinkingEffort: undefined,
    availableVariants: model.variants?.map((v) => v.id),
  };
}

export default function NewTaskCard({
  tasks, runners, models, modelsByRunner, modesByRunner, configuredProviders, modelApiMapping, onAdd,
}: NewTaskCardProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [runner, setRunner] = useState<string>('');
  const [model, setModel] = useState<TaskModelAssignment | undefined>();
  const [mode, setMode] = useState<string>('');
  const [dependencies, setDependencies] = useState<string[]>([]);

  // Before the user picks, there is no assigned runner to keep in the list.
  const runnerOptions = runner ? runnerOptionsFor(runners, runner) : (runners ?? []);
  // The first runner is the default, per the plan's own runner ordering.
  const effectiveRunner = runner || runnerOptions[0]?.id || '';

  const runnerModels = useMemo(() => {
    const scoped = effectiveRunner ? modelsByRunner?.[effectiveRunner] : undefined;
    return scoped && scoped.length > 0 ? scoped : models;
  }, [effectiveRunner, modelsByRunner, models]);

  const modes = effectiveRunner ? (modesByRunner?.[effectiveRunner] ?? []) : [];

  // A model or mode picked for one runner may not exist on another, so the
  // shown value falls back to that runner's first entry — the same choice the
  // host would derive if we sent nothing.
  const effectiveModel = useMemo(() => {
    if (model && runnerModels.some((m) => m.modelId === model.modelId)) return model;
    return runnerModels[0] ? assignmentFor(runnerModels[0]) : undefined;
  }, [model, runnerModels]);
  const effectiveMode = modes.some((m) => m.id === mode) ? mode : (modes[0]?.id ?? '');

  const candidates = useMemo(() => dependencyCandidates(tasks), [tasks]);

  const reset = () => {
    setOpen(false);
    setTitle('');
    setPrompt('');
    setRunner('');
    setModel(undefined);
    setMode('');
    setDependencies([]);
  };

  const submit = () => {
    if (!title.trim()) return;
    onAdd({
      title: title.trim(),
      prompt: prompt.trim() || title.trim(),
      assignedRunner: effectiveRunner || undefined,
      assignedModel: effectiveModel,
      taskMode: effectiveMode || undefined,
      dependencies,
    });
    reset();
  };

  if (!open) {
    return (
      <button className="task-add-btn" onClick={() => setOpen(true)} title="Add a task to this plan">
        + Add task
      </button>
    );
  }

  return (
    <div className="task-add-form">
      <input className="task-add-title" placeholder="Task title" value={title} autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') reset(); }} />

      <textarea className="task-prompt-textarea" placeholder="Prompt for the runner (defaults to the title)"
        rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      {/* Runner first: it decides which models and modes exist below it. */}
      {runnerOptions.length > 0 && (
        <div className="model-selector">
          <label htmlFor="new-task-runner">Runner</label>
          <select id="new-task-runner" value={effectiveRunner} onChange={(e) => setRunner(e.target.value)}>
            {runnerOptions.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
          </select>
        </div>
      )}

      {runnerModels.length > 0 && (
        <ModelSelector models={runnerModels} currentModel={effectiveModel}
          configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
          onChange={setModel} />
      )}

      {modes.length > 0 && (
        <div className="model-selector">
          <label htmlFor="new-task-mode">Mode</label>
          <select id="new-task-mode" value={effectiveMode} onChange={(e) => setMode(e.target.value)}>
            {modes.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.description}</option>)}
          </select>
        </div>
      )}

      <div className="task-add-deps">
        <label>Depends on</label>
        <DependencyPicker candidates={candidates} selected={dependencies} onChange={setDependencies} />
      </div>

      <div className="task-add-actions">
        <button className="btn-accept" onClick={submit} disabled={!title.trim()}>Add task</button>
        <button className="btn-reject" onClick={reset}>Cancel</button>
      </div>
    </div>
  );
}
