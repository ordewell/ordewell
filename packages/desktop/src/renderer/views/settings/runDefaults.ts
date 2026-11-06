import type { GlobalRunSettings, SettingsResponse } from '@ordewell/core';
import { DEFAULT_AUTONOMOUS_MODE, DEFAULT_MAX_PARALLEL, RUN_SETTINGS_DEFAULTS } from '@ordewell/core/plan-utils';

/**
 * The run settings the Run section shows. "Planned-with line in commits",
 * "Wake-up reads" and Subplanners live in Advanced and are not restored from
 * Run: restoring would turn a tree off the user turned on. Each default is
 * core's own: nothing here repeats a value.
 */
const SHOWN_IN_RUN = ['supervisorLevel', 'supervisorRetryLimit', 'mergeAtGatesAutomatically', 'autorun'] as const satisfies ReadonlyArray<keyof GlobalRunSettings>;

/** The one write that puts every setting Run shows back to its default. */
export function runDefaultsChange(): { autonomousMode: boolean; env: { ORDEWELL_MAX_PARALLEL: string }; run: Partial<GlobalRunSettings> } {
  const run: Partial<GlobalRunSettings> = {};
  for (const key of SHOWN_IN_RUN) Object.assign(run, { [key]: RUN_SETTINGS_DEFAULTS[key] });
  return { autonomousMode: DEFAULT_AUTONOMOUS_MODE, env: { ORDEWELL_MAX_PARALLEL: String(DEFAULT_MAX_PARALLEL) }, run };
}

/** Whether every setting Run shows already equals its default, so there is nothing to restore. */
export function atRunDefaults(settings: SettingsResponse): boolean {
  return settings.autonomousMode === DEFAULT_AUTONOMOUS_MODE
    && settings.maxParallel === DEFAULT_MAX_PARALLEL
    && SHOWN_IN_RUN.every((key) => settings.run[key] === RUN_SETTINGS_DEFAULTS[key]);
}
