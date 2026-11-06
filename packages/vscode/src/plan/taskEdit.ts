import { newTaskFields } from '@ordewell/core';
import type { Task } from '@ordewell/core';
import type { TaskDraft } from '@ordewell/ui/protocol';

/**
 * What to ask before removing a task. Worded with the other confirmations in
 * `@ordewell/ui/host`, so every host asks it the same way.
 *
 * Dependents are named, not just counted, because the removal rewrites them:
 * `removeTaskFromPlan` strips the dead id from every dependency list, so a user
 * who is not told loses edges they never edited.
 */
export { removalPrompt } from '@ordewell/ui/host';

/**
 * A hand-written task from the webview's add form. Only what a user can
 * actually fill in is read across — everything else (id, status, and any
 * assignment the form left blank) is the session's to derive.
 */
export function taskFromDraft(draft: TaskDraft): Partial<Task> | null {
  const fields = newTaskFields(draft.title, draft.prompt);
  if (!fields) return null;
  return {
    ...fields,
    dependencies: draft.dependencies.map(String),
    assignedRunner: draft.assignedRunner,
    assignedModel: draft.assignedModel,
    taskMode: draft.taskMode,
  };
}
