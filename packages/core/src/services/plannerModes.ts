import type { UserSettings } from './SettingsService';

/**
 * The mode toggles, as data, and which planner entry points honour each one.
 *
 * A toggle used to be a boolean threaded by hand down every path, which made an
 * intentional omission indistinguishable from a dropped one: the one-shot
 * planner honoured `verification` and silently ignored `review`, while every
 * surface still displayed review as ON. Declaring the scope is what makes the
 * difference visible — `modesFor` applies it, so a path cannot quietly diverge
 * from what this table says.
 */

/** The id a surface shows and a user types. Deliberately not the settings key. */
export type ModeToggleId = 'grill-me' | 'tdd' | 'prd' | 'review' | 'verify' | 'research-subagents';

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
  grillMeEnabled: boolean;
  tddEnabled: boolean;
  prdEnabled: boolean;
  reviewEnabled: boolean;
  verificationEnabled: boolean;
  researchSubagentsEnabled: boolean;
}

export interface ModeToggle {
  id: ModeToggleId;
  /** Key in the persisted settings file. `verify` maps to `verification`. */
  settingsKey: ToggleSettingsKey;
  /** Key a host passes to the Session. `review` on disk is `reviewEnabled` here. */
  runtimeKey: keyof PlannerRuntimeToggles;
  scopes: readonly ModeScope[];
}

export const MODE_TOGGLES: readonly ModeToggle[] = [
  // Both of these interview the user, and a one-shot run has nobody to ask —
  // its prompt says so outright. Their absence there is a decision, not a gap.
  { id: 'grill-me', settingsKey: 'grillMe', runtimeKey: 'grillMeEnabled', scopes: ['chat'] },
  { id: 'prd', settingsKey: 'prd', runtimeKey: 'prdEnabled', scopes: ['chat'] },
  // Structural: append a final review task. Nothing about it needs a dialogue.
  { id: 'review', settingsKey: 'review', runtimeKey: 'reviewEnabled', scopes: ['chat', 'one-shot'] },
  { id: 'verify', settingsKey: 'verification', runtimeKey: 'verificationEnabled', scopes: ['chat', 'one-shot'] },
  { id: 'research-subagents', settingsKey: 'researchSubagents', runtimeKey: 'researchSubagentsEnabled', scopes: ['chat', 'one-shot'] },
  { id: 'tdd', settingsKey: 'tdd', runtimeKey: 'tddEnabled', scopes: ['task'] },
];

/**
 * Read every toggle off the settings file under the name a Session expects.
 *
 * Both hosts used to hand-map `getReview()` to `reviewEnabled` and its five
 * siblings, in two identical blocks that nothing kept in step — which is how a
 * toggle came to have three unrelated names and how one of them got dropped.
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
  grillMe: boolean;
  prd: boolean;
  review: boolean;
  verification: boolean;
  researchSubagents: boolean;
}

export const DEFAULT_PLANNER_MODES: PlannerModes = {
  autonomousDefault: true,
  grillMe: false,
  prd: false,
  review: false,
  verification: false,
  researchSubagents: false,
};

/** Read the toggles a planner cares about off whatever the settings callback returned. */
export function plannerModesFrom(
  settings: {
    grillMeEnabled?: boolean;
    prdEnabled?: boolean;
    reviewEnabled?: boolean;
    verificationEnabled?: boolean;
    researchSubagentsEnabled?: boolean;
  },
  autonomousDefault: boolean,
): PlannerModes {
  return {
    autonomousDefault,
    grillMe: settings.grillMeEnabled ?? false,
    prd: settings.prdEnabled ?? false,
    review: settings.reviewEnabled ?? false,
    verification: settings.verificationEnabled ?? false,
    researchSubagents: settings.researchSubagentsEnabled ?? false,
  };
}

const MODE_FIELD: Record<ModeToggleId, keyof PlannerModes | null> = {
  'grill-me': 'grillMe',
  prd: 'prd',
  review: 'review',
  verify: 'verification',
  'research-subagents': 'researchSubagents',
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
