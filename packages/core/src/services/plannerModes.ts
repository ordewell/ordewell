import type { RepoGroupLayout } from '../interfaces/IWorktreeIsolation';

/**
 * Where the run's tasks will work: `false` in the shared workspace root;
 * otherwise each in its own worktree of every repo of the group (ADR-0013,
 * ADR-0014), which is what decides if tasks on the same file must be ordered.
 */
export type IsolatedExecution = false | RepoGroupLayout;

export interface PlannerModes {
  autonomousDefault: boolean;
  /** Not a toggle: a fact about the run. */
  isolatedExecution: IsolatedExecution;
}

export const DEFAULT_PLANNER_MODES: PlannerModes = {
  autonomousDefault: true,
  isolatedExecution: false,
};

/** The planner mode set before the run's isolation is known. */
export function plannerModesFrom(autonomousDefault: boolean): PlannerModes {
  return {
    autonomousDefault,
    isolatedExecution: false,
  };
}
