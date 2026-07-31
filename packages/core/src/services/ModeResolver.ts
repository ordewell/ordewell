import type { RunnerId } from '../models/Task';

export interface RunnerModeInfo {
  id: string;
  label: string;
  description: string;
  autonomous?: boolean;
  safe?: boolean;
}

/** The slice of RunnerRegistry this module needs — structural, so nothing here depends on the plugin layer. */
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
  modes: RunnerModeInfo[] | undefined,
  autonomousDefault = true,
): string | undefined {
  if (!modes || modes.length === 0) return undefined;
  const tag: 'autonomous' | 'safe' = autonomousDefault ? 'autonomous' : 'safe';
  const tagged = modes.find((m) => m[tag]);
  if (tagged) return tagged.id;
  for (let i = modes.length - 1; i >= 0; i--) {
    if (modes[i].id !== 'plan') return modes[i].id;
  }
  return undefined;
}

function isDefaultMode(m: RunnerModeInfo, autonomousDefault: boolean): boolean {
  return autonomousDefault ? !!m.autonomous : !!m.safe;
}

function modeConflictsWithToggle(
  mode: RunnerModeInfo,
  autonomousDefault: boolean,
): boolean {
  if (autonomousDefault) return !!mode.safe && !mode.autonomous;
  return !!mode.autonomous && !mode.safe;
}

/**
 * Build modes compatible with the current toggle. Plan is excluded from the
 * build-mode list (it is never a default for implementation tasks). Modes
 * tagged exclusively for the OPPOSITE toggle are hidden — the LLM cannot see
 * or select them. A dual-tagged mode (both autonomous + safe) is shown under
 * either toggle.
 */
export function filteredBuildModes(modes: RunnerModeInfo[], autonomousDefault: boolean): RunnerModeInfo[] {
  const buildModes = modes.filter((m) => m.id !== 'plan' && !modeConflictsWithToggle(m, autonomousDefault));
  const defaultIdx = buildModes.findIndex((m) => isDefaultMode(m, autonomousDefault));
  if (defaultIdx > 0) {
    const [def] = buildModes.splice(defaultIdx, 1);
    buildModes.unshift(def);
  }
  return buildModes;
}

export function buildModeGuide(
  runnerModes: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): string {
  const lines: string[] = [];
  for (const [runnerId, modes] of Object.entries(runnerModes)) {
    if (!modes || modes.length === 0) continue;
    const filtered = filteredBuildModes(modes, autonomousDefault);
    if (filtered.length === 0) continue;
    const modeStr = filtered
      .map((m) => {
        const tag = isDefaultMode(m, autonomousDefault) ? ' (DEFAULT)' : '';
        return `${m.id}${tag} (${m.description})`;
      })
      .join(', ');
    lines.push(`- ${runnerId}: ${modeStr}`);
  }
  if (lines.length === 0) return '';

  return [
    'AVAILABLE MODES PER RUNNER:',
    ...lines,
    '',
    'For each AI task, use the mode marked (DEFAULT) unless the task needs a different compatible mode listed above. Avoid the "plan" mode (read-only) unless the user explicitly requested analysis-only.',
  ].join('\n');
}

export function resolveTaskMode(
  emittedMode: string | undefined,
  runnerId: RunnerId,
  runnerModes: Record<RunnerId, RunnerModeInfo[]> | undefined,
  autonomousDefault = true,
): string {
  const rawMode = (emittedMode as string) || 'build';

  if (!runnerModes) return rawMode === 'plan' ? 'plan' : 'build';

  const modes = runnerModes[runnerId];

  if (!modes || modes.length === 0) return rawMode;

  const validIds = new Set(modes.map((m) => m.id));

  if (rawMode === 'build' || validIds.has(rawMode)) {
    if (rawMode === 'plan' || rawMode === 'build') return rawMode;
    const modeObj = modes.find((m) => m.id === rawMode);
    if (modeObj && modeConflictsWithToggle(modeObj, autonomousDefault)) {
      const fallback = resolveDefaultMode(modes, autonomousDefault);
      return fallback ?? 'build';
    }
    return rawMode;
  }

  const fallback = resolveDefaultMode(modes, autonomousDefault);
  return fallback ?? 'build';
}
