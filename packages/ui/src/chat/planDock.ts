import type { SurfaceTask } from '@ordewell/core';

/**
 * The plan dock: the plan is a live, editable artifact, not a chat message, so
 * it is mounted once in its own scroll region and the chat carries only a chip
 * per revision. This module owns the rules that decision needs — what counts as
 * a revision, what the collapsed bar says, and when the dock opens.
 *
 * All of it is pure. The webview's own `planUpdated` handler is the only caller.
 */

/**
 * The fields a user can edit. Deliberately excludes `status` (and anything else
 * execution writes): the host sends `planUpdated` on every status tick, so a
 * fingerprint that included status would call each tick a revision.
 */
function fingerprint(tasks: SurfaceTask[]): string {
  return [...tasks]
    .sort((x, y) => x.order - y.order)
    .map((t) => [
      t.id,
      t.order,
      t.title,
      t.prompt ?? t.description,
      t.dependencies.join(','),
      t.assignedRunner,
      t.assignedModel?.modelId ?? '',
      t.assignedModel?.thinkingEffort ?? '',
      t.taskMode ?? '',
    ].join('\u0000'))
    .join('\u0001');
}

/** Whether the plan's shape or assignment changed, as opposed to its progress. */
export function isPlanRevision(before: SurfaceTask[], after: SurfaceTask[]): boolean {
  return fingerprint(before) !== fingerprint(after);
}

export type DockEvent =
  /** The plan's shape or assignment changed — the event the dock exists to surface. */
  | 'plan-revised'
  /** A task's status ticked. Arrives constantly during a run. */
  | 'plan-progressed'
  | 'user-collapsed'
  | 'user-expanded'
  | 'session-reset';

/**
 * Whether the dock is open after `event`. A revision always opens it; a status
 * tick never moves it. That asymmetry is the whole design: opening on progress
 * would mean a running plan reopened itself every few seconds against a user who
 * had deliberately collapsed it, and a collapse is always honoured.
 */
export function nextDock(expanded: boolean, event: DockEvent): boolean {
  switch (event) {
    case 'plan-revised':
    case 'user-expanded':
      return true;
    case 'user-collapsed':
    case 'session-reset':
      return false;
    case 'plan-progressed':
      return expanded;
  }
}

/**
 * The one-line view of the plan the collapsed dock shows. Progress is part of
 * it, not just the task count — collapsed is the dock's normal state while the
 * user is chatting, and during a run it is the only thing on screen that says
 * how far along the plan is.
 */
export function planSummaryLabel(tasks: SurfaceTask[]): string {
  if (tasks.length === 0) return '';
  const done = tasks.filter((t) => t.status === 'completed').length;
  const running = tasks.filter((t) => t.status === 'in_progress').length;
  const segments = [`${tasks.length} task${tasks.length === 1 ? '' : 's'}`];
  if (done > 0) segments.push(`${done} done`);
  if (running > 0) segments.push(`${running} running`);
  return segments.join(' · ');
}

/** The shortest a dragged dock gets: the bar and about one task row. */
export const DOCK_MIN_HEIGHT = 80;

/**
 * Where a drag of the dock's top edge lands. The height is a cap, not a fixed
 * size, so it never goes past the plan's own content — a dock dragged beyond
 * where the plan ends would leave a dead zone the handle cannot follow back.
 * `available` is what the conversation can give up above its floor.
 */
export function dragDockHeight(requested: number, limits: { content: number; available: number }): number {
  return Math.round(Math.max(DOCK_MIN_HEIGHT, Math.min(requested, limits.content, limits.available)));
}
