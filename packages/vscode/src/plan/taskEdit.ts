import { dependentsOf, flattenTasks } from '@ordewell/core';
import type { Task, TaskModelAssignment } from '@ordewell/core';

/**
 * A per-task edit the webview sent, as the host should act on it.
 *
 * The webview overloads one `execute` action-context for every per-task edit,
 * discriminated only by which keys its JSON payload carries. Reading that off
 * the payload inline made the branches order-sensitive and truthiness-based:
 * an emptied mode fell through to the destructive `remove` branch. Naming the
 * edit here keeps that classification in one testable place.
 */
export type TaskEdit =
  | { kind: 'runner'; runner: string }
  | { kind: 'model'; assignment: TaskModelAssignment }
  | { kind: 'mode'; mode: string }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'dependencies'; dependencies: string[] }
  | { kind: 'remove' };

export function classifyTaskEdit(text: string): TaskEdit {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON — an empty payload means remove */ }
  if (!parsed) return { kind: 'remove' };

  // Runner wins over a model in the same payload: retargeting derives its own
  // model for the new runner, so applying the old one too would undo the switch.
  if (typeof parsed.runner === 'string') return { kind: 'runner', runner: parsed.runner };

  if (typeof parsed.modelId === 'string') {
    return {
      kind: 'model',
      assignment: {
        modelId: parsed.modelId,
        modelLabel: parsed.modelLabel as string,
        thinkingEffort: parsed.thinkingEffort as string | undefined,
        availableVariants: parsed.availableVariants as string[] | undefined,
      },
    };
  }

  if (typeof parsed.mode === 'string') return { kind: 'mode', mode: parsed.mode };
  if (typeof parsed.prompt === 'string') return { kind: 'prompt', prompt: parsed.prompt };
  // Checked by shape, not truthiness: clearing every dependency is a legitimate
  // edit, and an empty array must not fall through to `remove`.
  if (Array.isArray(parsed.dependencies)) return { kind: 'dependencies', dependencies: parsed.dependencies.map(String) };
  return { kind: 'remove' };
}

/**
 * What to ask before removing a task.
 *
 * Dependents are named, not just counted, because the removal rewrites them:
 * `removeTaskFromPlan` strips the dead id from every dependency list, so a user
 * who is not told loses edges they never edited.
 */
export function removalPrompt(tasks: Task[], taskId: string): string {
  const all = flattenTasks(tasks);
  const title = all.find((t) => t.id === taskId)?.title;
  const question = title ? `Remove "${title}"?` : 'Remove this task?';
  const dependents = dependentsOf(all, taskId);
  if (dependents.length === 0) return question;

  const named = dependents.map((t) => `#${t.order} ${t.title}`).join(', ');
  const subject = dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`;
  return `${question}\n\n${subject} on it and will lose that dependency: ${named}.`;
}

/**
 * A hand-written task as the webview's add form sends it. Only what a user can
 * actually fill in is read across — everything else (id, status, completion
 * marker, and any assignment the form left blank) is the session's to derive.
 */
export function parseTaskDraft(text: string): Partial<Task> | null {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* nothing usable */ }
  const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  if (!title) return null;

  const prompt = typeof parsed!.prompt === 'string' && parsed!.prompt.trim() ? (parsed!.prompt as string) : title;
  return {
    title,
    description: title,
    prompt,
    type: 'ai',
    dependencies: Array.isArray(parsed!.dependencies) ? parsed!.dependencies.map(String) : [],
    assignedRunner: typeof parsed!.assignedRunner === 'string' ? parsed!.assignedRunner : undefined,
    assignedModel: (parsed!.assignedModel as TaskModelAssignment | undefined) ?? undefined,
    taskMode: typeof parsed!.taskMode === 'string' ? parsed!.taskMode : undefined,
  };
}
