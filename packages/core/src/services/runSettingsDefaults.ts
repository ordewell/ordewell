import type { SupervisorLevel } from '../models/Execution';

/*
 * Pure on purpose: no file system, no process. The desktop's renderer reads
 * these through `plan-utils` to restore defaults, so the values it restores
 * are the very ones the service falls back to and no surface keeps a copy.
 */

/** Retries an Act supervisor may make of one task in a run when the plan sets none. */
export const DEFAULT_SUPERVISOR_RETRY_LIMIT = 2;

/**
 * Reads a wake-up turn may make when the plan sets none. A supervisor reads
 * to explain a failure — the task, its log, its diff, a neighbour's — and a
 * wake-up has no user message to keep it short (ADR-0029).
 */
export const DEFAULT_WAKE_UP_READ_BUDGET = 12;

/** A fresh install starts Guarded: its first plan runs each runner's safe mode and asks before risky effects. */
export const DEFAULT_AUTONOMOUS_MODE = false;

/**
 * The shape of a tree, by ADR-0055 D19: each a run setting's default and the
 * cap no node passes, refused past it rather than dropped. A setting is at
 * least 1, so a tree turned on can always delegate one level.
 */
export const SHAPE_LIMITS = {
  depth: { default: 2, hard: 4 },
  delegatedTasks: { default: 8, hard: 30 },
  tasksPerPlan: { default: 30, hard: 100 },
} as const;

/** What a root's shape limits are read from: depth below the root, delegated tasks in any one plan, tasks in a child plan. */
export interface TreeShape {
  depth: number;
  delegatedTasks: number;
  tasksPerPlan: number;
}

/** How a run is started, watched and merged: the user's, not a plan's (ADR-0030). */
export interface GlobalRunSettings {
  supervisorLevel: SupervisorLevel;
  mergeAtGatesAutomatically: boolean;
  /** End the commits Ordewell writes with a `Planned-with: Ordewell` trailer (ADR-0013). */
  plannedWithTrailer: boolean;
  /** Start a plan when the planner submits it, approved as if the user had pressed Execute. */
  autorun: boolean;
  /** Retries an Act supervisor may make of one task in a run (a loop guard). */
  supervisorRetryLimit: number;
  /** Reads a wake-up turn may make, in place of a user message's caps. */
  wakeUpReadBudget: number;
  /**
   * The token budget of a delegation tree (ADR-0055 D21, ADR-0056 M5); 0 is
   * delegation off. One value, so delegation is never on with no budget.
   */
  delegationTokens: number;
  /**
   * The last budget the user entered, kept while delegation is off so turning
   * it on again asks for nothing. 0 is none yet: the first enable takes a
   * number from the user, never a default. It never turns delegation on.
   */
  delegationBudget: number;
  /** How many levels a tree may open below the root plan (ADR-0055 D19). Kept, like the budget, while delegation is off. */
  delegationDepth: number;
  /** How many delegated tasks any one plan in a tree may hold (D19). */
  delegatedTasksPerPlan: number;
  /** How many tasks a child plan may hold; a root plan has no such limit (D19). */
  tasksPerChildPlan: number;
}

export const RUN_SETTINGS_DEFAULTS: Readonly<GlobalRunSettings> = {
  supervisorLevel: 'watch',
  mergeAtGatesAutomatically: false,
  plannedWithTrailer: true,
  autorun: false,
  supervisorRetryLimit: DEFAULT_SUPERVISOR_RETRY_LIMIT,
  wakeUpReadBudget: DEFAULT_WAKE_UP_READ_BUDGET,
  delegationTokens: 0,
  delegationBudget: 0,
  delegationDepth: SHAPE_LIMITS.depth.default,
  delegatedTasksPerPlan: SHAPE_LIMITS.delegatedTasks.default,
  tasksPerChildPlan: SHAPE_LIMITS.tasksPerPlan.default,
};
