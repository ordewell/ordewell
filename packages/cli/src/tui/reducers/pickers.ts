import { CLI_PROVIDERS, getProviderMeta, plannerBackendEntries, runnerForProvider, type PlannerUsability } from '@ordewell/core';
import { plannerNamesOr } from '../../runnerNames';
import { dependencyCandidates } from '@ordewell/core/plan-utils';
import { findTask, runnerSignInLine, signedOutWithWayIn, titledRefFor, type ModelView, type PickerItem, type PickerState, type TuiState } from '../state';
import { effortsForTask, modelsForRunner, modelsForTask, modesForTask } from '../taskAssignment';

/** The picker id meaning "the runner's own default", as opposed to a model variant. */
export const DEFAULT_EFFORT = '__runner_default__';

/** A fixed, numbered list unless `extra` says it is `filterable`. */
export function picker(
  title: string,
  items: PickerItem[],
  action: PickerState['action'],
  extra: Partial<PickerState> = {},
): PickerState {
  return { title, items, filter: '', index: 0, multi: false, chosen: [], filterable: false, action, ...extra };
}

/**
 * A picker opened before its data arrived (`/sessions`, a task's model) shows
 * an empty list; refill it in place when the fetch lands so the user does not
 * have to close and reopen it.
 */
export function refillPicker(state: TuiState, kinds: PickerState['action']['kind'][]): TuiState {
  const overlay = state.overlay;
  if (overlay?.kind !== 'picker' || !kinds.includes(overlay.picker.action.kind)) return state;

  const items = pickerItemsFor(state, overlay.picker.action);
  return { ...state, overlay: { kind: 'picker', picker: { ...overlay.picker, items, index: 0 } } };
}

/**
 * The runners picker opens on what was loaded earlier; when the daemon's saved
 * choice lands it replaces the rows, and the ticks unless the user has already
 * changed them. The highlight stays where the user put it.
 */
export function reseedRunnerChoice(before: TuiState, after: TuiState): TuiState {
  const overlay = after.overlay;
  if (overlay?.kind !== 'picker' || overlay.picker.action.kind !== 'set-runners') return after;
  const enabledIds = (state: TuiState) => state.runners.filter((r) => r.enabled).map((r) => r.id);
  const shown = enabledIds(before);
  const untouched = overlay.picker.chosen.length === shown.length && shown.every((id) => overlay.picker.chosen.includes(id));
  const picker = { ...overlay.picker, items: pickerItemsFor(after, overlay.picker.action) };
  return { ...after, overlay: { kind: 'picker', picker: untouched ? { ...picker, chosen: enabledIds(after) } : picker } };
}

/** Provider name + price, so the picker states which provider serves a model. */
function modelDetail(m: ModelView): string | undefined {
  return [m.provider, m.pricing].filter(Boolean).join(' · ') || undefined;
}

/**
 * The planner-model catalog for `provider` (ADR-0009), with `selectedId`
 * marked. A harness planner runs a coding agent, so the only models it can
 * serve are that agent's own — offering it the cross-provider vendor catalog
 * would list models it cannot run. This is the third of the three places
 * `isCliProvider` guards.
 */
export function plannerModelItems(state: TuiState, provider: string, selectedId: string): PickerItem[] {
  const runner = runnerForProvider(provider);
  if (!runner) {
    const failed = Object.entries(state.providerErrors ?? {});
    const unavailable: PickerItem[] = failed.length === 0
      ? []
      : [{
        id: '',
        label: 'Some providers are unavailable',
        detail: `⚠ ${failed.map(([id]) => getProviderMeta(id)?.label ?? id).join(', ')}: key or fetch failed`,
        disabled: true,
      }];
    return [
      ...unavailable,
      ...state.orchestratorModels.map((m) => ({ id: m.id, label: m.label, detail: modelDetail(m), selected: m.id === selectedId })),
    ];
  }

  const items = state.models
    .filter((m) => m.runners?.includes(runner))
    .map((m) => ({
      id: m.id,
      label: m.label,
      detail: [
        m.provider,
        m.variants?.length ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}` : 'runner default effort',
      ].filter(Boolean).join(' · '),
      selected: m.id === selectedId,
    }));
  // An empty catalog means discovery hasn't landed (or failed); a blank picker
  // with no explanation reads as a broken command.
  return items.length > 0
    ? items
    : [{ id: '', label: `No ${runner} models discovered yet`, detail: 'run /refresh', disabled: true }];
}

/** `provider`'s harness model `modelId`, when that agent lists it; a vendor planner has none. */
export function plannerHarnessModel(state: TuiState, provider: string, modelId: string): ModelView | undefined {
  const runner = runnerForProvider(provider);
  return runner ? state.models.find((m) => m.id === modelId && m.runners?.includes(runner)) : undefined;
}

/** The variants of a harness planner's model, plus the agent's own default, with `selectedEffort` marked. */
export function plannerEffortItems(state: TuiState, provider: string, modelId: string, selectedEffort: string): PickerItem[] {
  if (!runnerForProvider(provider)) {
    return [{ id: '', label: 'Thinking effort applies to a coding-agent planner', detail: 'switch with /planner', disabled: true }];
  }
  const model = plannerHarnessModel(state, provider, modelId);
  if (!model) {
    return [{ id: '', label: 'No planner model selected', detail: 'pick one with /planner', disabled: true }];
  }
  const variants = model.variants ?? [];
  if (variants.length === 0) {
    return [{ id: '', label: `${model.label} exposes no effort levels`, detail: "it always runs at the agent's default", disabled: true }];
  }
  return [
    { id: DEFAULT_EFFORT, label: 'Runner default', detail: 'Let the agent choose', selected: !selectedEffort },
    ...variants.map((v) => ({ id: v.id, label: v.label, selected: v.id === selectedEffort })),
  ];
}

export function pickerItemsFor(state: TuiState, action: PickerState['action']): PickerItem[] {
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
      detail: `${s.taskCount} ${s.taskCount === 1 ? 'task' : 'tasks'} · ${s.status}`,
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
    // Each row carries its own way in, so a signed-out agent can be fixed from
    // the list that shows it (ADR-0052).
    return state.runners.map((runner) => {
      const way = runnerSignInLine(runner);
      return {
        id: runner.id,
        label: runner.name,
        ...(way ? { detail: way } : {}),
        ...(way && signedOutWithWayIn(runner) ? { warn: true } : {}),
      };
    });
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
      label: titledRefFor(state, candidate),
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
      detail: mode.unavailable ?? mode.description,
      selected: mode.id === task.taskMode,
      ...(mode.unavailable ? { disabled: true } : {}),
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
 * agent whose CLI isn't on PATH is left out rather than listed disabled — the
 * list holds only what the user can pick, and a hint stands in its place when
 * nothing can plan (ADR-0009).
 */
export function plannerItems(state: TuiState): PickerItem[] {
  // The daemon's runner list is the TUI's only preflight: it holds the
  // installed and usable runners, and an absent one is dropped from the
  // offered set (ADR-0009).
  const installed = new Map(state.runners.map((runner) => [runner.id, runner]));
  const usability: Record<string, PlannerUsability> = {};
  for (const id of CLI_PROVIDERS) {
    const runner = runnerForProvider(id)!;
    const known = installed.get(runner);
    usability[runner] = known
      ? { usable: true, ...(known.auth ? { auth: known.auth } : {}) }
      : { usable: false, reason: 'CLI not installed or not on PATH' };
  }

  const offered = plannerBackendEntries(usability, state.configuredProviders).filter((entry) => entry.usable);
  if (offered.length === 0) {
    return [{ id: '', label: 'No planner available', detail: `install a coding agent (${plannerNamesOr()}) or add a key with /key`, disabled: true }];
  }
  const items: PickerItem[] = offered.map((entry) => {
    // A signed-out agent stays offered — auth never gates usability — but the
    // row flags it and names its own way in so it can be fixed without switching.
    const signedOut = entry.kind === 'harness' && entry.auth?.state === 'signed-out';
    const row = installed.get(entry.runner ?? entry.id);
    return {
      id: entry.id,
      label: entry.label,
      detail: signedOut ? (row && runnerSignInLine(row)) ?? `${entry.label} is not signed in.` : entry.reason,
      selected: state.plannerProvider === entry.id,
      ...(signedOut ? { warn: true } : {}),
    };
  });

  return offered.some((entry) => entry.kind === 'vendor')
    ? items
    : [...items, { id: '', label: 'No API providers configured', detail: 'add a key with /key', disabled: true }];
}
