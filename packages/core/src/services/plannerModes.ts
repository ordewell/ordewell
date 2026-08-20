import type { UserSettings } from './SettingsService';

/**
 * The mode toggles, as data, and which planner entry points honour each one.
 *
 * A toggle used to be a boolean threaded by hand down every path, which made an
 * intentional omission indistinguishable from a dropped one: a toggle could be
 * silently ignored on one path while every surface still displayed it as ON.
 * Declaring the scope is what makes the difference visible — `modesFor`
 * applies it, so a path cannot quietly diverge from what this table says.
 */

/** The id a surface shows and a user types. Deliberately not the settings key. */
export type ModeToggleId = 'tdd' | 'verify';

/**
 * Where a toggle can take effect. `chat` is the conversation loop (ADR-0002),
 * `one-shot` the non-conversational planners (`ordewell plan --goal`, web REST),
 * `task` a runner task's prompt rather than the planner's.
 */
export type ModeScope = 'chat' | 'one-shot' | 'task';

/** The settings-file keys that hold a toggle, as opposed to `modelAllowlist` and friends. */
type ToggleSettingsKey = {
  // `-?` because an optional member (`modelAllowlist`) otherwise widens the
  // lookup to include `undefined`, which cannot index anything.
  [K in keyof UserSettings]-?: UserSettings[K] extends { enabled: boolean } ? K : never;
}[keyof UserSettings];

/** How the same toggle is named once a host has read it off disk. */
export interface PlannerRuntimeToggles {
  tddEnabled: boolean;
  verificationEnabled: boolean;
}

export interface ModeToggle {
  id: ModeToggleId;
  /** Key in the persisted settings file. `verify` maps to `verification`. */
  settingsKey: ToggleSettingsKey;
  /** Key a host passes to the Session. `verify` on disk is `verificationEnabled` here. */
  runtimeKey: keyof PlannerRuntimeToggles;
  scopes: readonly ModeScope[];
}

export const MODE_TOGGLES: readonly ModeToggle[] = [
  { id: 'verify', settingsKey: 'verification', runtimeKey: 'verificationEnabled', scopes: ['chat', 'one-shot'] },
  { id: 'tdd', settingsKey: 'tdd', runtimeKey: 'tddEnabled', scopes: ['task'] },
];

/**
 * Read every toggle off the settings file under the name a Session expects.
 *
 * Both hosts used to hand-map `getVerification()` to `verificationEnabled` and
 * its siblings, in two identical blocks that nothing kept in step — which is
 * how a toggle came to have three unrelated names and how one of them got
 * dropped.
 * Callers add whatever else `SessionRuntimeSettings` carries (`modelAllowlist`).
 */
export function plannerRuntimeToggles(settings: UserSettings): PlannerRuntimeToggles {
  const toggles = {} as PlannerRuntimeToggles;
  for (const toggle of MODE_TOGGLES) toggles[toggle.runtimeKey] = settings[toggle.settingsKey].enabled;
  return toggles;
}

/**
 * The planner-facing mode set for one operation. Replaces the boolean tail that
 * every planner signature used to carry positionally — where a thirteenth
 * parameter was the only place left to put a new toggle.
 */
export interface PlannerModes {
  autonomousDefault: boolean;
  verification: boolean;
}

export const DEFAULT_PLANNER_MODES: PlannerModes = {
  autonomousDefault: true,
  verification: false,
};

/** Read the toggles a planner cares about off whatever the settings callback returned. */
export function plannerModesFrom(
  settings: {
    verificationEnabled?: boolean;
  },
  autonomousDefault: boolean,
): PlannerModes {
  return {
    autonomousDefault,
    verification: settings.verificationEnabled ?? false,
  };
}

const MODE_FIELD: Record<ModeToggleId, keyof PlannerModes | null> = {
  verify: 'verification',
  tdd: null,
};

/**
 * Clear the toggles this scope does not honour, so a prompt builder reads a
 * mode set that already tells the truth about the path it is on.
 */
export function modesFor(scope: ModeScope, modes: PlannerModes): PlannerModes {
  const scoped = { ...modes };
  for (const toggle of MODE_TOGGLES) {
    const field = MODE_FIELD[toggle.id];
    if (field && !toggle.scopes.includes(scope)) scoped[field] = false;
  }
  return scoped;
}
