import { flattenTasks, type RunnerId, type Task } from '../models/Task';

export interface RunnerModeInfo {
  id: string;
  label: string;
  description: string;
  autonomous?: boolean;
  safe?: boolean;
  readOnly?: boolean;
  sandboxed?: boolean;
  /** Why this mode cannot be used on this host (a failed probe); such a mode is shown, never assigned. */
  unavailable?: string;
}

/** The slice of RunnerRegistry this module needs — structural, so nothing here depends on the manifest layer. */
export interface ManifestLookup {
  getManifest(runner: RunnerId): { modes?: RunnerModeInfo[] } | undefined;
}

/**
 * A runner's modes are declared only in its manifest, never through a service,
 * so every caller that needs them fuses registry and runner list by hand. This
 * is that fusion, in one place: the planner prompt, the mode pickers on each
 * surface, and the runner-change retarget all read modes the same way.
 *
 * A runner with no modes maps to `[]` rather than being dropped — callers
 * distinguish "declares no modes" from "not asked about".
 */
export function runnerModesFrom(registry: ManifestLookup, runners: RunnerId[]): Record<RunnerId, RunnerModeInfo[]> {
  return Object.fromEntries(runners.map((r) => [r, registry.getManifest(r)?.modes ?? []] as const));
}

/**
 * Find the mode ID a runner resolves to under the given toggle state.
 * Tag-based first (autonomous/safe); falls back to positional last non-plan
 * if no tag is present on any mode (degrades gracefully on untagged manifests).
 * Returns undefined if `modes` is empty or undefined.
 */
export function resolveDefaultMode(
  modes: readonly RunnerModeInfo[] | undefined,
  autonomousDefault = false,
): string | undefined {
  if (!modes || modes.length === 0) return undefined;
  const tag: 'autonomous' | 'safe' = autonomousDefault ? 'autonomous' : 'safe';
  const tagged = modes.find((m) => m[tag]);
  if (tagged) return tagged.id;
  for (let i = modes.length - 1; i >= 0; i--) {
    if (!modes[i].readOnly && modes[i].id !== 'plan') return modes[i].id;
  }
  return undefined;
}

/**
 * Whether `id` is a mode `modes` tags for Full (`autonomous`). Only the tag
 * counts: the positional fallback {@link resolveDefaultMode} takes on an
 * untagged manifest says nothing of what the mode asks before it acts.
 */
export function offeredForFull(modes: readonly RunnerModeInfo[] | undefined, id: string | undefined): boolean {
  return id !== undefined && modes?.some((m) => m.id === id && m.autonomous === true) === true;
}

/** The user-facing name of the `autonomousMode` boolean's two states. */
export function autonomyLevelLabel(autonomous: boolean): 'Full' | 'Guarded' {
  return autonomous ? 'Full' : 'Guarded';
}

/** `full`/`guarded` name the levels; `on`/`off` and `auto` are older words for them. Null for anything else. */
export function parseAutonomyLevel(arg: string | undefined): boolean | null {
  switch (arg?.trim().toLowerCase()) {
    case 'full': case 'on': return true;
    case 'guarded': case 'auto': case 'off': return false;
    default: return null;
  }
}

/**
 * The level a flag or `ORDEWELL_AUTONOMOUS_MODE` names: the level names above,
 * plus the boolean spellings (`true`/`false`, `1`/`0`), case and surrounding
 * space aside. Undefined for anything else — a typo must never raise autonomy,
 * and the `.env` migration and the runtime override must read a value alike.
 */
export function parseAutonomyFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return parseAutonomyLevel(normalized) ?? undefined;
}

/**
 * The profile a manifest tags `readOnly` (ADR-0046) — never found by id, so a runner with no
 * tag has none. A mode this host cannot run is still the runner's read-only
 * mode: it is how a task already on it is recognized, and why a move of that
 * task is refused rather than made writable.
 */
export function taggedReadOnlyMode(modes: readonly RunnerModeInfo[] | undefined): string | undefined {
  return modes?.find((m) => m.readOnly)?.id;
}

/** The read-only profile a task can be given here; built-ins do not need the runner's native sandbox (ADR-0046). */
export function readOnlyMode(modes: readonly RunnerModeInfo[] | undefined): string | undefined {
  const mode = modes?.find((m) => m.readOnly);
  return mode && !mode.unavailable ? mode.id : undefined;
}

/** Why a mode cannot be used on this host, when it cannot. */
export function unavailableModeReason(modes: readonly RunnerModeInfo[] | undefined, id: string | undefined): string | undefined {
  return id === undefined ? undefined : modes?.find((m) => m.id === id)?.unavailable;
}

function unavailableModeError(runner: RunnerId, id: string, reason: string): string {
  return `Mode "${id}" of runner "${runner}" is unavailable on this host: ${reason}`;
}

/** What a task fails with at spawn when its planned mode is one this host cannot run; undefined when it can. */
export function unavailableTaskModeMessage(
  manifest: { displayName: string; modes?: readonly RunnerModeInfo[] },
  mode: string | undefined,
): string | undefined {
  const reason = unavailableModeReason(manifest.modes, mode);
  return reason ? `Mode "${mode}" of ${manifest.displayName} is unavailable on this host: ${reason}` : undefined;
}

/** What the planner says about a task's mode (ADR-0031): read-only or not, and the mode the task has now, if any. */
export interface ModeRequest {
  readOnly?: boolean;
  current?: string;
}

export type PlannedMode = { ok: true; mode: string | undefined } | { ok: false; error: string };

/**
 * The mode a task the planner writes lands on (ADR-0031). The planner names no
 * mode: a read-only task gets its runner's read-only mode; any other keeps the
 * mode it has when the runner offers it — a mode the user picked survives an
 * edit that does not ask for a change — and otherwise gets the runner's mode
 * for the level. `readOnly: false` is the one request that moves a task off
 * its read-only mode. Undefined mode when the runner's modes are unknown.
 */
export function plannedMode(
  runner: RunnerId,
  runnerModes: Partial<Record<RunnerId, readonly RunnerModeInfo[]>> | undefined,
  { readOnly, current }: ModeRequest,
  autonomousDefault = false,
): PlannedMode {
  if (!runnerModes) return { ok: true, mode: undefined };
  const modes = runnerModes[runner] ?? [];
  const readOnlyId = readOnlyMode(modes);
  if (readOnly === true) {
    if (readOnlyId) return { ok: true, mode: readOnlyId };
    const able = readOnlyRunners(runnerModes);
    const reason = unavailableModeReason(modes, taggedReadOnlyMode(modes));
    return {
      ok: false,
      error: `Runner "${runner}" has no read-only mode${reason ? ' available on this host' : ''}: assign a read-only task to ${able.length > 0 ? `one of: ${able.join(', ')}` : 'no runner: none of the enabled runners has one'}, or drop "readOnly"${reason ? `. ${reason}` : ''}`,
    };
  }
  const keep = current !== undefined && modes.some((m) => m.id === current) && !(readOnly === false && current === taggedReadOnlyMode(modes));
  const mode = keep ? current : resolveDefaultMode(modes, autonomousDefault);
  // Refused, never swapped for another mode: that would hand a task the
  // planner or user meant to be sandboxed a level of access nobody chose (ADR-0001).
  const reason = unavailableModeReason(modes, mode);
  if (mode !== undefined && reason) return { ok: false, error: unavailableModeError(runner, mode, reason) };
  return { ok: true, mode };
}

/**
 * A plan the planner restates over an existing one comes back with every mode
 * decided afresh. A restatement says read-only or not for each task, so that
 * answer stands; what it cannot say is a mode the user picked. So where a
 * task it names was planned before and is not read-only now, the earlier mode
 * is kept when its runner offers it — the rule an edit follows.
 */
export function carryPlannedModes(
  before: readonly Task[],
  rewrite: Task[],
  catalog: { runnerModes: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>; autonomousDefault?: boolean },
): Task[] {
  const prior = new Map(flattenTasks(before).map((t) => [t.id, t]));
  const carry = (t: Task): Task => {
    const subtasks = (t.subtasks ?? []).map(carry);
    const was = prior.get(t.id);
    if (t.type !== 'ai' || !was || was.type !== 'ai' || t.taskMode === taggedReadOnlyMode(catalog.runnerModes[t.assignedRunner])) return { ...t, subtasks };
    const mode = plannedMode(t.assignedRunner, catalog.runnerModes, { readOnly: false, current: was.taskMode }, catalog.autonomousDefault ?? false);
    return { ...t, subtasks, ...(mode.ok && mode.mode !== undefined ? { taskMode: mode.mode } : {}) };
  };
  return rewrite.map(carry);
}

/** The runners a read-only task may go to, as the planner's prompt names them. */
export function readOnlyRunners(runnerModes: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>): RunnerId[] {
  return Object.entries(runnerModes).filter(([, ms]) => readOnlyMode(ms)).map(([id]) => id);
}
