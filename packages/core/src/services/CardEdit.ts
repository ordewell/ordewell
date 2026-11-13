import type { RunnerId, Task, TaskModelAssignment } from '../models/Task';

/**
 * One field edit from a task card, as every surface sends it. Named by kind
 * rather than read off which keys a payload happens to carry: that guess let
 * an emptied mode fall through to removing the task.
 */
export type CardEdit =
  | { kind: 'runner'; runner: RunnerId }
  | { kind: 'model'; assignment: TaskModelAssignment }
  | { kind: 'mode'; mode: string }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'dependencies'; dependencies: string[] }
  | { kind: 'skills'; skills: string[] }
  /** Change versus ops (ADR-0020); the session refuses it once the task has started. */
  | { kind: 'ops'; ops: boolean };

const CARD_EDIT_KINDS: ReadonlySet<string> = new Set<CardEdit['kind']>(['runner', 'model', 'mode', 'prompt', 'dependencies', 'skills', 'ops']);

/** Narrows a request body to a {@link CardEdit}, for the daemon route that takes one. */
export function isCardEdit(value: unknown): value is CardEdit {
  return typeof value === 'object' && value !== null && CARD_EDIT_KINDS.has((value as { kind?: unknown }).kind as string);
}

/**
 * The task patch a card's edit asks for. A runner change is the same patch:
 * `updateTask` lands it with what the runner scopes (model, effort, mode).
 */
export function cardEditPatch(edit: CardEdit): Partial<Task> {
  switch (edit.kind) {
    case 'runner': return { assignedRunner: edit.runner };
    case 'model': return { assignedModel: edit.assignment };
    case 'mode': return { taskMode: edit.mode };
    case 'prompt': return { prompt: edit.prompt, description: edit.prompt || undefined };
    case 'dependencies': return { dependencies: edit.dependencies };
    case 'skills': return { skills: edit.skills };
    case 'ops': return { ops: edit.ops };
  }
}
