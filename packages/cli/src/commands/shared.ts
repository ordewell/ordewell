import { createInterface } from 'readline';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient } from '../apiClient';
import { normalizeCatalog, type Catalog } from '../catalog';
import { findEnvFile, writeEnvVar } from '../utils/env';
import { allTasksOf } from '../utils/tasks';
import type { TaskView } from '../tui/state';
import type { SerializedPlan, SerializedTask, SettingsUpdateResponse } from '@ordewell/core';
import type { PlanBody } from '../apiClient';

export async function connect(subArgs: string[], injected?: ApiClient): Promise<ApiClient> {
  return injected ?? new ApiClient(await ensureDaemon(resolvePort(subArgs)));
}

export async function fetchCatalog(api: ApiClient): Promise<Catalog> {
  return normalizeCatalog(await api.getModels());
}

/** Prints to stderr and exits non-zero. Typed `never` so callers need no `return` after it. */
export function fail(...lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/** A yes/no question on the terminal; no terminal to ask on is a no. */
export async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Writes each key straight to `.env` and `process.env` — no daemon round-trip. */
export function writeEnv(env: Record<string, string>): void {
  const envFile = findEnvFile();
  for (const [key, value] of Object.entries(env)) {
    writeEnvVar(envFile, key, value);
    process.env[key] = value;
  }
}

/**
 * Push env-backed settings to the daemon, and only then to `.env`. Returns the
 * daemon's response so a caller can read back values it resolved rather than
 * chose — a planner switch's remembered/default model, in particular.
 *
 * The reverse order looks harmless and is not — the TUI's `persistAfterDaemon`
 * documents why, and the CLI has the same exposure: `.env` is the disk, and a
 * refused connection would leave it holding a choice neither the daemon nor the
 * user's next command ever saw. The next daemon then starts from that file.
 */
export async function persistEnv(api: ApiClient, env: Record<string, string>): Promise<SettingsUpdateResponse> {
  const settings = await api.updateSettings({ env });
  writeEnv(env);
  return settings;
}

/**
 * A wire task as the pure assignment rules want it.
 *
 * The rules in `tui/taskAssignment.ts` and core's `plan-utils` are typed against
 * `TaskView` precisely so more than one surface can satisfy them; what the wire
 * shape does not line up on is nullability (`assignedModel: … | null`) and the
 * open `type`/missing `status` fields. Normalizing once here is a translation,
 * not a second copy of a rule — the rules themselves stay in their one home.
 */
export function toTaskView(task: SerializedTask & { status?: string }): TaskView {
  return {
    id: task.id,
    order: task.order,
    title: task.title,
    description: task.description,
    prompt: task.prompt ?? undefined,
    type: task.type === 'user' ? 'user' : 'ai',
    status: task.status ?? 'pending',
    dependencies: task.dependencies ?? [],
    assignedRunner: task.assignedRunner || undefined,
    taskMode: task.taskMode || undefined,
    assignedModel: task.assignedModel ?? undefined,
    subtasks: [...(task.subtasks ?? [])].sort((a, b) => a.order - b.order).map(toTaskView),
    ...(task.ops ? { ops: true } : {}),
    ...(task.skills?.length ? { skills: [...task.skills] } : {}),
  };
}

/**
 * Every task in display order, as `TaskView`s — what the TUI's plan pane holds.
 *
 * Sourced through `allTasksOf` rather than `plan.tasks` because a session's plan
 * arrives in more than one shape (`pendingTasks` + `executionLog` on one path,
 * `tasks` on another), and the dependency rules need the *whole* plan: a
 * completed predecessor missing from the list reads as "cannot depend on it".
 */
export function taskViews(plan: PlanBody | SerializedPlan): TaskView[] {
  const tasks = allTasksOf(plan as unknown as Record<string, unknown>) as unknown as (SerializedTask & { status?: string })[];
  return [...tasks].sort((a, b) => a.order - b.order).map(toTaskView);
}
