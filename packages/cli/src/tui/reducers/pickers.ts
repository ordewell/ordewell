import { ALL_PROVIDERS, CLI_PROVIDERS, plannerBackendEntries, runnerForProvider, titledTaskRef, type AiProvider, type PlannerUsability } from '@ordewell/core';
import { dependencyCandidates } from '@ordewell/core/plan-utils';
import { findTask, type ModelView, type PickerItem, type PickerState, type TuiState } from '../state';
import { effortsForTask, modelsForRunner, modelsForTask, modesForTask } from '../taskAssignment';

/** The picker id meaning "the runner's own default", as opposed to a model variant. */
export const DEFAULT_EFFORT = '__runner_default__';

export function picker(
  title: string,
  items: PickerItem[],
  action: PickerState['action'],
  extra: Partial<PickerState> = {},
): PickerState {
  return { title, items, filter: '', index: 0, multi: false, chosen: [], action, ...extra };
}

/**
 * A picker opened before its data arrived (`/model`, `/sessions`) shows an
 * empty list; refill it in place when the fetch lands so the user does not have
 * to close and reopen it.
 */
export function refillPicker(state: TuiState, kinds: PickerState['action']['kind'][]): TuiState {
  const overlay = state.overlay;
  if (overlay?.kind !== 'picker' || !kinds.includes(overlay.picker.action.kind)) return state;

  const items = pickerItemsFor(state, overlay.picker.action);
  // The model picker's hint carries any provider-fetch failures; recompute it
  // on refill so it appears (or clears) the moment the catalog lands.
  const hint = overlay.picker.action.kind === 'set-model' ? providerErrorHint(state) : overlay.picker.hint;
  return { ...state, overlay: { kind: 'picker', picker: { ...overlay.picker, items, hint, index: 0 } } };
}

/** Provider name + price, so the picker states which provider serves a model. */
function modelDetail(m: ModelView): string | undefined {
  return [m.provider, m.pricing].filter(Boolean).join(' · ') || undefined;
}

/**
 * A one-line warning naming any configured provider whose catalog fetch failed,
 * or undefined when every provider loaded. The picker still lists the models
 * from providers that did work — this just explains what is missing and why.
 */
export function providerErrorHint(state: TuiState): string | undefined {
  const failed = Object.keys(state.providerErrors ?? {});
  if (failed.length === 0) return undefined;
  const names = failed.map((p) => ALL_PROVIDERS[p as AiProvider]?.label ?? p);
  return `⚠ Unavailable (key or fetch failed): ${names.join(', ')} — showing working providers only.`;
}

/**
 * The planner-model catalog for the current backend (ADR-0009). A harness
 * planner runs a coding agent, so the only models it can serve are that
 * agent's own — offering it the cross-provider vendor catalog would list
 * models it cannot run. This is the third of the three places `isCliProvider`
 * guards.
 */
function plannerModelItems(state: TuiState): PickerItem[] {
  const runner = runnerForProvider(state.plannerProvider as AiProvider);
  if (!runner) return state.orchestratorModels.map((m) => ({ id: m.id, label: m.label, detail: modelDetail(m) }));

  const items = state.models
    .filter((m) => m.runners?.includes(runner))
    .map((m) => ({
      id: m.id,
      label: m.label,
      detail: [
        m.provider,
        m.variants?.length ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}` : 'runner default effort',
      ].filter(Boolean).join(' · '),
      selected: m.id === state.orchestratorModel,
    }));
  // An empty catalog means discovery hasn't landed (or failed); a blank picker
  // with no explanation reads as a broken command.
  return items.length > 0
    ? items
    : [{ id: '', label: `No ${runner} models discovered yet`, detail: 'run /refresh', disabled: true }];
}

/** The variants of the model the harness planner is set to, plus the agent's own default. */
export function plannerEffortItems(state: TuiState): PickerItem[] {
  const runner = runnerForProvider(state.plannerProvider as AiProvider);
  if (!runner) {
    return [{ id: '', label: 'Thinking effort applies to a coding-agent planner', detail: 'switch with /planner', disabled: true }];
  }
  const model = state.models.find((m) => m.id === state.orchestratorModel && m.runners?.includes(runner));
  if (!model) {
    return [{ id: '', label: 'No planner model selected', detail: 'pick one with /model', disabled: true }];
  }
  const variants = model.variants ?? [];
  if (variants.length === 0) {
    return [{ id: '', label: `${model.label} exposes no effort levels`, detail: "it always runs at the agent's default", disabled: true }];
  }
  return [
    { id: DEFAULT_EFFORT, label: 'Runner default', detail: 'Let the agent choose', selected: !state.plannerEffort },
    ...variants.map((v) => ({ id: v.id, label: v.label, selected: v.id === state.plannerEffort })),
  ];
}

export function pickerItemsFor(state: TuiState, action: PickerState['action']): PickerItem[] {
  if (action.kind === 'set-model') {
    return plannerModelItems(state);
  }
  if (action.kind === 'set-planner') {
    return plannerItems(state);
  }
  if (action.kind === 'set-planner-effort') {
    return plannerEffortItems(state);
  }
  if (action.kind === 'rewind') {
    if (state.rewindTargets === null) return [];
    if (state.rewindTargets.length === 0) {
      return [{ id: '', label: 'Nothing to rewind to yet', detail: 'the only message so far is the goal', disabled: true }];
    }
    return [...state.rewindTargets].reverse().map((t) => ({ id: String(t.index), label: t.preview, detail: `message ${t.index}` }));
  }
  if (action.kind === 'load-session' || action.kind === 'delete-session') {
    return state.sessions.map((s) => ({
      id: s.id,
      label: s.goal || s.id,
      detail: `${s.taskCount} tasks · ${s.status}`,
    }));
  }
  if (action.kind === 'set-allowlist') {
    return modelsForRunner(state.models, action.runner).map((m) => ({
      id: m.id,
      label: m.label,
      detail: [m.provider, m.pricing].filter(Boolean).join(' · ') || undefined,
    }));
  }
  if (action.kind === 'set-runners') {
    return state.runners.map((runner) => ({ id: runner.id, label: runner.name }));
  }
  if (action.kind === 'set-task-runner') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    return state.runners.map((runner) => ({
      id: runner.id,
      label: runner.name,
      detail: runner.enabled ? undefined : 'not enabled for planning',
      selected: runner.id === task.assignedRunner,
    }));
  }
  if (action.kind === 'set-task-deps') {
    return dependencyCandidates(state.tasks, action.taskId).map((candidate) => ({
      id: candidate.id,
      label: titledTaskRef(candidate),
      detail: candidate.status === 'completed' ? 'already completed' : undefined,
    }));
  }
  if (action.kind === 'set-task-skills') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    const known = new Set(state.taskSkills.map((s) => s.name));
    return [
      ...state.taskSkills.map((s) => ({ id: s.name, label: s.name, detail: s.description || undefined })),
      // Attached but not in the catalog (created by an earlier task's worktree): keep it
      // selectable so confirming the picker does not silently detach it.
      ...(task.skills ?? []).filter((name) => !known.has(name)).map((name) => ({ id: name, label: `${name} (not found)`, detail: 'not found in the catalog' })),
    ];
  }
  if (action.kind === 'set-task-mode') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    return modesForTask(state.modesByRunner, task).map((mode) => ({
      id: mode.id,
      label: mode.label,
      detail: mode.description,
      selected: mode.id === task.taskMode,
    }));
  }
  if (action.kind === 'set-task-model') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    const items = modelsForTask(state.models, task).map((model) => ({
      id: model.id,
      label: model.label,
      detail: [
        model.provider,
        model.variants?.length ? `${model.variants.length} effort level${model.variants.length === 1 ? '' : 's'}` : 'runner default effort',
      ].filter(Boolean).join(' · '),
      selected: model.id === task.assignedModel?.modelId,
    }));
    // An empty catalog means discovery hasn't landed for this runner (or
    // failed) — a blank picker with no explanation reads as a broken command.
    return items.length > 0
      ? items
      : [{ id: '', label: `No ${task.assignedRunner ?? 'runner'} models discovered yet`, detail: 'run /refresh', disabled: true }];
  }
  if (action.kind === 'set-task-effort') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    const current = task.assignedModel?.thinkingEffort;
    return [
      { id: DEFAULT_EFFORT, label: 'Runner default', detail: 'Let the executor choose', selected: !current },
      ...effortsForTask(state.models, task).map((variant) => ({
        id: variant.id,
        label: variant.label,
        selected: variant.id === current,
      })),
    ];
  }
  return [];
}

/**
 * Everything that can plan, in one list (ADR-0009).
 *
 * Coding agents come first: they need no API key, which makes them the answer
 * for the user who has just installed Ordewell and has no vendor account. An
 * agent whose CLI isn't on PATH is listed disabled with the reason rather than
 * hidden — discovering a missing CLI after typing a real goal is the failure
 * the preflight exists to prevent.
 */
export function plannerItems(state: TuiState): PickerItem[] {
  // The daemon's runner list is the TUI's only preflight: an installed runner
  // is usable, an absent one gets the same not-on-PATH reason VS Code probes for.
  const installed = new Set(state.runners.map((r) => r.id));
  const usability: Record<string, PlannerUsability> = {};
  for (const id of CLI_PROVIDERS) {
    const runner = runnerForProvider(id)!;
    usability[runner] = installed.has(runner)
      ? { usable: true }
      : { usable: false, reason: 'CLI not installed or not on PATH' };
  }

  const entries = plannerBackendEntries(usability, state.configuredProviders);
  const items: PickerItem[] = entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    detail: entry.reason,
    selected: state.plannerProvider === entry.id,
    disabled: !entry.usable,
  }));

  return entries.some((entry) => entry.kind === 'vendor')
    ? items
    : [...items, { id: '', label: 'No API providers configured', detail: 'add a key with /key', disabled: true }];
}
