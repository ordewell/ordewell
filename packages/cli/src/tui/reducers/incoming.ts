import { isAwaitingReason, type DisplayBlock, type SessionMessage, type SettingsResponse } from '@ordewell/core';
import { sanitize } from '../ansi';
import {
  isTaskRunning, plannerInFlight, type GateView, type TaskView, type TuiState,
} from '../state';
import { hear } from '../transcript';
import { dropApproval, enqueueApproval } from './approvals';

/**
 * A plan's text, safe to lay out. Every field here was written by a model, so
 * it gets the same treatment a planner turn does — see `sanitize`.
 */
const planText = (value: unknown, fallback = ''): string => sanitize(String(value ?? fallback));

/**
 * The same, for a field the pane paints on one row. A newline surviving into
 * one of these would be written into the middle of a row rather than wrapped,
 * which moves the terminal's cursor down a line and shoves the rest of the
 * frame with it — the plan pane's meta rows are `truncate`d, not wrapped, so
 * nothing downstream would split it.
 */
const planLabel = (value: unknown, fallback = ''): string => planText(value, fallback).replace(/\n+/g, ' ');

/** A wire value as a record to read fields off, or an empty one when it is not an object at all. */
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** The record test `assignedModel` needs: an absent or non-object field is no model at all. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A task's order for sorting: absent reads as 0, and a stringly order coerces numerically as it always did. */
const wireOrder = (value: unknown): number => Number(asRecord(value).order ?? 0);

/**
 * A plan reaches the TUI in two shapes. Live from the planner it is one flat
 * `tasks` array; persisted it is split in two — finished tasks in
 * `executionLog`, the rest in `pendingTasks` — so the two halves are rejoined
 * and re-ordered, otherwise completed work would vanish from the pane.
 */
export function normalizeTasks(plan: unknown): TaskView[] {
  const source = plan as { tasks?: unknown[]; pendingTasks?: unknown[]; executionLog?: unknown[] } | null;

  const byId = new Map<string, Record<string, unknown>>();
  // Pending first, then the log: the log is the record of what actually
  // happened, so it wins for a task that somehow appears in both.
  for (const list of [source?.pendingTasks, source?.executionLog]) {
    for (const task of list ?? []) {
      const record = asRecord(task);
      byId.set(String(record.id), record);
    }
  }

  const raw = byId.size > 0
    ? [...byId.values()].sort((a, b) => wireOrder(a) - wireOrder(b))
    : (source?.tasks ?? []).map(asRecord);

  return raw.map((t, i) => toTaskView(t, i));
}

/** One wire task as the pane's `TaskView`, recursing into sorted subtasks. */
function toTaskView(t: Record<string, unknown>, index: number): TaskView {
  const model = asRecord(t.assignedModel);
  const assigned = isRecord(t.assignedModel);
  return {
    id: String(t.id ?? `task-${index + 1}`),
    order: typeof t.order === 'number' ? t.order : index + 1,
    title: planLabel(t.title, 'Untitled task'),
    description: planText(t.description ?? t.title),
    prompt: typeof t.prompt === 'string' ? sanitize(t.prompt) : undefined,
    type: t.type === 'user' ? 'user' : 'ai',
    status: planLabel(t.status, 'pending'),
    awaitingReason: t.status === 'awaiting_user' && isAwaitingReason(t.awaitingReason) ? t.awaitingReason : undefined,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies.map((id: unknown) => planLabel(id)) : [],
    assignedRunner: typeof t.assignedRunner === 'string' ? planLabel(t.assignedRunner) : undefined,
    taskMode: typeof t.taskMode === 'string' ? planLabel(t.taskMode) : undefined,
    assignedModel: assigned
      ? {
          modelId: planLabel(model.modelId),
          modelLabel: planLabel(model.modelLabel ?? model.modelId),
          thinkingEffort:
            typeof model.thinkingEffort === 'string'
              ? planLabel(model.thinkingEffort)
              : typeof t.thinkingEffort === 'string'
                ? planLabel(t.thinkingEffort)
                : undefined,
          availableVariants: Array.isArray(model.availableVariants)
            ? model.availableVariants.map((variant: unknown) => planLabel(variant))
            : undefined,
        }
      : undefined,
    subtasks: Array.isArray(t.subtasks)
      ? [...t.subtasks]
          .sort((a, b) => wireOrder(a) - wireOrder(b))
          .map((s, i) => toTaskView(asRecord(s), i))
      : undefined,
    ...(t.ops === true ? { ops: true } : {}),
    ...(Array.isArray(t.skills) && t.skills.length > 0 ? { skills: t.skills.map((name: unknown) => planLabel(name)) } : {}),
    ...(Array.isArray(t.forcedPastGate) && t.forcedPastGate.length > 0 ? { forcedPastGate: t.forcedPastGate.map((title: unknown) => planLabel(title)) } : {}),
  };
}

export function applySettings(state: TuiState, settings: Partial<SettingsResponse>): TuiState {
  return {
    ...state,
    orchestratorModel:
      typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : state.orchestratorModel,
    plannerProvider:
      typeof settings.aiProvider === 'string' ? settings.aiProvider : state.plannerProvider,
    plannerEffort:
      typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : state.plannerEffort,
    maxParallel: typeof settings.maxParallel === 'number' ? settings.maxParallel : state.maxParallel,
    allowlist:
      settings.modelAllowlist && typeof settings.modelAllowlist === 'object'
        ? (settings.modelAllowlist as Record<string, string[]>)
        : state.allowlist,
  };
}

/**
 * What a run is doing right now, from the tasks themselves. It used to be the
 * last `task_started` title, which went on naming a task long after it had
 * finished — and said nothing once the run was only waiting on the user.
 */
export function runLabel(tasks: TaskView[], gate: GateView | null = null): string {
  const running = tasks.filter(isTaskRunning);
  if (running.length > 0) {
    const [first] = running;
    const name = first.assignedRunner ? `${first.title} · ${first.assignedRunner}` : first.title;
    return running.length > 1 ? `${name} (+${running.length - 1} more)` : name;
  }
  const waiting = tasks.filter((t) => t.status === 'awaiting_user').length;
  if (waiting > 0) return waiting === 1 ? '1 task waits for you' : `${waiting} tasks wait for you`;
  // As plain as a task that waits on the user: the run waits on a merge (ADR-0020).
  return gate?.paused ? 'paused for Merge all — /handoff merge' : '';
}

/** A label for the status row, which is one row: text from a model flattened onto it. */
const statusText = (text: string): string => sanitize(text).replace(/\s+/g, ' ').trim();

/** What the conversation has in flight: calls awaiting their result, and subagents still at work, oldest first. */
function inFlight(blocks: readonly DisplayBlock[]): string[] {
  return blocks.flatMap((block): string[] => {
    if (block.type === 'tool') return block.status === 'pending' ? [statusText(`${block.headline.name}(${block.headline.keyArg})`)] : [];
    if (block.type !== 'subagent' || block.status !== 'running') return [];
    return [statusText(`Agent(${block.brief})`), ...inFlight(block.children)];
  });
}

/**
 * The status row during a planner turn, read off the conversation: it says
 * researching while a call is out, and names the newest one. A parallel round
 * opens several calls at once, so it counts the rest rather than flickering
 * between filenames and leaving whichever landed last.
 */
function turnActivity(state: TuiState): TuiState {
  if (!plannerInFlight(state)) return state;
  const open = inFlight(state.conversation.blocks);
  const status = open.length > 0 ? 'researching' : 'planning';
  const newest = open.at(-1) ?? '';
  const busyLabel = open.length > 1 ? `${newest} (+${open.length - 1} more)` : newest;
  return status === state.status && busyLabel === state.busyLabel ? state : { ...state, status, busyLabel };
}

/**
 * One planner message into the TUI. The conversation view takes all of it; an
 * approval request also queues its modal, since the planner waits on the answer.
 */
export function followSession(state: TuiState, message: SessionMessage): TuiState {
  const heard = turnActivity(hear(state, message));
  if (message.type === 'approval_request') {
    const { id, kind, subject, scope, detail } = message;
    // A task runner's request is answered in its task view, never in the planner's modal.
    if (kind === 'runner_tool') return heard;
    return enqueueApproval(heard, { id, kind, subject, scope, ...(detail ? { detail } : {}) });
  }
  return message.type === 'approval_settled' ? dropApproval(heard, message.id) : heard;
}
