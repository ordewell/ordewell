import {
  isAwaitingReason, isSupervisorLevel, reduceRun,
  type PlanSnapshot, type RunInput, type RunTask, type RunView, type SessionMessage, type SettingsResponse, type SurfacePlan, type SurfacePlanState,
} from '@ordewell/core';
import { sanitize } from '../ansi';
import type { TaskView, TuiState } from '../state';
import { hear } from '../transcript';
import { dropApproval, enqueueApproval } from './approvals';
import { refillInbox } from './inbox';

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

/**
 * A plan the TUI read whole — a route's answer, a loaded session — as the run
 * input that folds it. Live from the planner it is one flat `tasks` array; a
 * persisted session is phase-tagged, its finished tasks in `executionLog` and
 * the rest in `pendingTasks`. Both reach `reduceRun` through here.
 */
export function planSnapshot(plan: unknown): PlanSnapshot {
  const record = asRecord(plan);
  if (Array.isArray(record.tasks)) return { type: 'plan_snapshot', plan: record as unknown as SurfacePlan };
  return {
    type: 'plan_snapshot',
    plan: {
      ...record,
      phase: record.phase ?? 'executing',
      pendingTasks: Array.isArray(record.pendingTasks) ? record.pendingTasks : [],
      executionLog: Array.isArray(record.executionLog) ? record.executionLog : [],
    } as unknown as SurfacePlanState,
  };
}

/**
 * A script task's body, as it arrived. Not through `sanitize`: that would drop
 * a control character a reader should see, and the pane spells it out instead
 * (ADR-0035).
 */
const scriptBodyFields = (t: RunTask): Pick<TaskView, 'commands' | 'script' | 'timeoutMs'> => ({
  ...(Array.isArray(t.commands) ? { commands: t.commands.map((argv) => [...argv]) } : {}),
  ...(typeof t.script === 'string' ? { script: t.script } : {}),
  ...(typeof t.timeoutMs === 'number' ? { timeoutMs: t.timeoutMs } : {}),
});

/** A loop's check (ADR-0045), with the verdict that tells it between rounds from a failure; nothing on any other task. */
const loopFields = (t: RunTask): Pick<TaskView, 'loop' | 'loopRound' | 'verdict'> => {
  if (!t.loop || !Array.isArray(t.loop.body)) return {};
  return {
    loop: { body: t.loop.body.map((id) => planLabel(id)), maxRounds: t.loop.maxRounds },
    ...(typeof t.loopRound === 'number' ? { loopRound: t.loopRound } : {}),
    ...(t.verdict ? { verdict: { outcome: t.verdict.outcome, ...(t.verdict.reported ? { reported: t.verdict.reported } : {}) } } : {}),
  };
};

/**
 * One run-view task as the pane's `TaskView`, recursing into subtasks sorted by
 * order so the dotted labels read in plan order.
 */
function runTaskToView(t: RunTask): TaskView {
  const model = t.assignedModel;
  return {
    id: String(t.id),
    order: typeof t.order === 'number' ? t.order : 0,
    title: planLabel(t.title, 'Untitled task'),
    description: planText(t.description ?? t.title),
    prompt: typeof t.prompt === 'string' ? sanitize(t.prompt) : undefined,
    type: t.type === 'user' || t.type === 'script' ? t.type : 'ai',
    ...(t.attempted === true ? { attempted: true } : {}),
    attemptUsage: Array.isArray(t.attemptUsage) ? t.attemptUsage : undefined,
    status: planLabel(t.status, 'pending'),
    idleSince: t.idleSince ?? null,
    ...(t.completionReceived === 'done' || t.completionReceived === 'failed' || t.completionReceived === 'blocked' ? { completionReceived: t.completionReceived } : {}),
    ...(t.attaching === 1 || t.attaching === 2 ? { attaching: t.attaching } : {}),
    dependencies: Array.isArray(t.dependencies) ? t.dependencies.map((id) => planLabel(id)) : [],
    assignedRunner: typeof t.assignedRunner === 'string' ? planLabel(t.assignedRunner) : undefined,
    taskMode: typeof t.taskMode === 'string' ? planLabel(t.taskMode) : undefined,
    assignedModel: model
      ? {
          modelId: planLabel(model.modelId),
          modelLabel: planLabel(model.modelLabel ?? model.modelId),
          ...(typeof model.thinkingEffort === 'string' ? { thinkingEffort: planLabel(model.thinkingEffort) } : {}),
          ...(Array.isArray(model.availableVariants) ? { availableVariants: model.availableVariants.map((variant) => planLabel(variant)) } : {}),
        }
      : undefined,
    isolation: t.isolation,
    awaitingReason: t.status === 'awaiting_user' && isAwaitingReason(t.awaitingReason) ? t.awaitingReason : undefined,
    ...(t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit' && typeof t.resumeAt === 'string' ? { resumeAt: t.resumeAt } : {}),
    ...(t.status === 'skipped' && typeof t.skipReason === 'string' ? { skipReason: sanitize(t.skipReason) } : {}),
    checkpoint: typeof t.checkpoint === 'string' ? sanitize(t.checkpoint) : undefined,
    continuable: t.continuable === true,
    awaitingApproval: t.awaitingApproval,
    ...(t.waitsForApproval === true ? { waitsForApproval: true } : {}),
    ...(typeof t.holdReason === 'string' && t.holdReason.trim() ? { holdReason: sanitize(t.holdReason) } : {}),
    ...(t.ops === true ? { ops: true } : {}),
    ...(t.research === true ? { research: true } : {}),
    // Drawn through the same sanitize/wrap as any other plan text; keeping the
    // digest whole means a task view can show its findings without a log read.
    ...(t.handoff ? { handoff: t.handoff } : {}),
    ...scriptBodyFields(t),
    ...loopFields(t),
    ...(Array.isArray(t.skills) && t.skills.length > 0 ? { skills: t.skills.map((name) => planLabel(name)) } : {}),
    ...(t.addedBy ? { addedBy: t.addedBy } : {}),
    ...(Array.isArray(t.mergeGate) && t.mergeGate.length > 0 ? { mergeGate: t.mergeGate.map((title) => planLabel(title)) } : {}),
    ...(Array.isArray(t.forcedPastGate) && t.forcedPastGate.length > 0 ? { forcedPastGate: t.forcedPastGate.map((title) => planLabel(title)) } : {}),
    subtasks: t.subtasks.length > 0
      ? [...t.subtasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(runTaskToView)
      : undefined,
  };
}

/** The run's own supervisor level, read off the run settings a run carries. */
function supervisorOfRun(runSettings: RunView['runSettings']): Pick<TuiState, 'runSupervisor'> {
  if (!runSettings) return { runSupervisor: null };
  const unsupervised = typeof runSettings.unsupervised === 'string' ? runSettings.unsupervised : undefined;
  return {
    runSupervisor: {
      level: isSupervisorLevel(runSettings.supervisorLevel) ? runSettings.supervisorLevel : 'off',
      ...(unsupervised ? { unsupervised } : {}),
    },
  };
}

/** The pane's fields, all derived from the run view the surface folds. */
export function withRun(state: TuiState, run: RunView): TuiState {
  // An open inbox follows the list as core sends it, with no polling (ADR-0053).
  return refillInbox({
    ...state,
    run,
    tasks: run.tasks.map(runTaskToView),
    handoff: run.handoff ?? null,
    runMerge: run.runMerge
      ? { waitingAtGate: run.runMerge.waitingAtGate, paused: run.runMerge.paused, handoff: { repos: run.runMerge.repos, landed: run.runMerge.landed } }
      : null,
    runAutoMerge: run.runSettings?.mergeAtGatesAutomatically ?? null,
    ...supervisorOfRun(run.runSettings),
  });
}

/** One run input into the surface's view; a fold that changes nothing returns the state unchanged. */
export function foldRun(state: TuiState, input: RunInput): TuiState {
  const run = reduceRun(state.run, input);
  return run === state.run ? state : withRun(state, run);
}

export function applySettings(state: TuiState, settings: Partial<SettingsResponse>, applyRun = true): TuiState {
  return {
    ...state,
    orchestratorModel:
      typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : state.orchestratorModel,
    plannerProvider:
      typeof settings.aiProvider === 'string' ? settings.aiProvider : state.plannerProvider,
    plannerKnown: state.plannerKnown || typeof settings.aiProvider === 'string',
    plannerEffort:
      typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : state.plannerEffort,
    plannerModels:
      settings.plannerModels && typeof settings.plannerModels === 'object' ? settings.plannerModels : state.plannerModels,
    maxParallel: typeof settings.maxParallel === 'number' ? settings.maxParallel : state.maxParallel,
    allowlist:
      settings.modelAllowlist && typeof settings.modelAllowlist === 'object'
        ? (settings.modelAllowlist as Record<string, string[]>)
        : state.allowlist,
    runSettings: applyRun && settings.run ? settings.run : state.runSettings,
    runSettingsKnown: state.runSettingsKnown || (applyRun && settings.run !== undefined),
  };
}

/**
 * One planner message into the TUI. The conversation view takes all of it; an
 * approval request also queues its modal, since the planner waits on the answer.
 */
export function followSession(state: TuiState, message: SessionMessage): TuiState {
  const heard = hear(state, message);
  if (message.type === 'approval_request') {
    const { id, kind, subject, scope, detail, body } = message;
    // A task runner's request is answered in its task view, never in the planner's modal.
    if (kind === 'runner_tool') return heard;
    return enqueueApproval(heard, { id, kind, subject, scope, ...(detail ? { detail } : {}), ...(body ? { body } : {}) });
  }
  return message.type === 'approval_settled' ? dropApproval(heard, message.id) : heard;
}
