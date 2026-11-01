import type { SupervisorLevel } from '../models/Execution';
import type { GlobalRunSettings } from './SettingsService';

/** How every surface words the run settings (ADR-0030), so they all say the same thing. */

export const SUPERVISOR_LEVEL_LABEL: Record<SupervisorLevel, string> = { off: 'Off', watch: 'Watch', act: 'Act' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const onOff = (value: boolean): string => (value ? 'on' : 'off');

export const supervisorSummary = (run: GlobalRunSettings): string =>
  `Supervisor: ${SUPERVISOR_LEVEL_LABEL[run.supervisorLevel]}, ${plural(run.supervisorRetryLimit, 'retry', 'retries')} per task, ${plural(run.wakeUpReadBudget, 'read', 'reads')} per wake-up`;
export const automergeSummary = (run: GlobalRunSettings): string => `Merge automatically (gates, end of run): ${onOff(run.mergeAtGatesAutomatically)}`;
export const PLANNED_WITH_LABEL = 'Planned-with line in commits Ordewell writes';
export const trailerSummary = (run: GlobalRunSettings): string => `${PLANNED_WITH_LABEL}: ${onOff(run.plannedWithTrailer)}`;
export const autorunSummary = (run: GlobalRunSettings): string => `Autorun: ${onOff(run.autorun)}`;
export const delegationSummary = (run: GlobalRunSettings): string => `Delegation: ${run.delegationTokens > 0 ? `on, ${run.delegationTokens} tokens for a tree` : 'off'}`;

/** What turns delegation on where it may be turned on at all (ADR-0055 D21). */
export const DELEGATION_ENV = 'ORDEWELL_DELEGATION';

/** What {@link delegationSwitchedOn} reads of the place it runs in, so a test can put it anywhere. */
export interface DelegationPlace {
  /** The variable's value, as this process has it. */
  env: string | undefined;
  /** Where this module runs from; null where nothing can say, as in a webview. */
  moduleDir: string | null;
  exists(path: string): boolean;
}

/**
 * Whether delegation is offered here. It stays off in anything published
 * (ADR-0055 D21): the rest of the feature is unbuilt, a subplanner approves a
 * plan nobody reads, and a variable a user can set in a shell must not reach
 * that from a package. So the variable counts only in a build run from a git
 * checkout of this repository: an installed package sits under `node_modules`,
 * however that project is kept, and a packaged extension has no checkout above
 * it. The stored setting stays inert everywhere else.
 */
export function delegationSwitchedOn({ env, moduleDir, exists }: DelegationPlace): boolean {
  if (env !== '1' || moduleDir === null) return false;
  const parts = moduleDir.split(/[\\/]/);
  if (parts.includes('node_modules')) return false;
  const packages = parts.lastIndexOf('packages');
  if (packages < 1) return false;
  const root = parts.slice(0, packages).join('/');
  return exists(`${root}/.git`) && exists(`${root}/packages/core/package.json`);
}

/** This module's directory, by the build's own means; `fs` comes from the process so a webview, which bundles this file, imports none. */
function placeHere(): DelegationPlace {
  const fs = typeof process === 'undefined' ? undefined : process.getBuiltinModule?.('fs');
  if (!fs) return { env: undefined, moduleDir: null, exists: () => false };
  const file = typeof __filename !== 'undefined' ? __filename : new URL(
    // @ts-expect-error - import.meta is only valid under an ESM module setting; see builtinSkills.ts
    (import.meta as { url: string }).url,
  ).pathname;
  return { env: process.env[DELEGATION_ENV], moduleDir: file.replace(/[\\/][^\\/]*$/, ''), exists: (path) => fs.existsSync(path) };
}

/** Whether any surface offers the delegation setting, and whether a planner may write a delegated task. */
export const DELEGATION_OFFERED = delegationSwitchedOn(placeHere());

export const ACT_RISK = 'Tasks it adds run too, ops tasks included, which can act on real systems unattended.';
export const AUTORUN_RISK = 'Plans start without review, ops tasks included, which can act on real systems unattended. In Full nobody is asked at all: the planner may start anything, script tasks included, from a plan no person read.';
/** What turning delegation on accepts below the root, as Act and autorun accept it at the root (ADR-0056 M9). A container is not named as a remedy: none is run for delegation (ADR-0059). */
export const DELEGATION_RISK = 'A subplanner approves and runs its own plan, and no person reads it. Its change tasks keep the network they have in a flat run, so an instruction injected into something a subplanner read can become a plan nobody read, and run with that network. Delegation does not run them in a container: a container is opt-in, for a task on its own.';

/** `on`/`off` as a switch's value; null for anything else. */
export function parseSwitch(arg: string): boolean | null {
  return arg === 'on' ? true : arg === 'off' ? false : null;
}

/** A delegation setting as typed: `off`, which is 0, or the tree's budget in tokens; null for anything else. */
export function parseDelegation(arg: string): number | null {
  return arg === 'off' ? 0 : parseCount(arg, 1);
}

/** A whole number at least `min`, as typed; null for anything else. */
export function parseCount(arg: string | undefined, min: number): number | null {
  if (arg === undefined || !/^\d+$/.test(arg)) return null;
  const n = Number(arg);
  return n >= min ? n : null;
}
