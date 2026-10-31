import { flattenTasks, type RunnerId, type SkillLoad, type Task } from '../models/Task';
import type { SkillInfo } from './SkillsService';
import { modelInvocablePlannerSkills, snapshotSkill } from './skillInvocation';
import { autonomyLevelLabel, readOnlyMode } from './ModeResolver';
import type { AssignmentAdjustment } from './TaskAssignment';
import {
  fitTail, readTask, taskReadDetail, verdictRead, outputSummaryRead, taskQuerySignature,
  OUTPUT_LINES_DEFAULT, OUTPUT_LINES_MAX, OUTPUT_TAIL_MAX_CHARS, TASK_QUERY_TASK_FIELDS, TASK_READ_ANSWER_OR_EDIT,
  type LiveOutputLookup, type TaskQuery, type TaskQueryCatalog, type TaskQueryField,
} from './TaskQuery';
import type { TaskOp } from './TaskOps';
import type { CheckedChange, PlanChangeError } from './PlanChangeCheck';
import type { PlanChange, ToolRead } from './PlannerConversation';
import { commandReply, type McpToolReply, type PlannerToolHandler } from './mcp/tools';
import type { TaskLogEvent } from '../models/TaskLog';
import { namedHandoff, resolveWrittenRef } from '../models/Handoff';
import { renderTaskLog } from './taskLogRead';
import { taskReadPage } from './taskReadPage';
import type { TaskDiffRead, TaskDiffResult } from './taskDiffRead';
import type { BashOptions, ToolOutcome } from '../interfaces/IFileSystem';
import type { CommandOutcome, ExecutionCommand } from './ExecutionCommands';
import { resolveTaskRef, taskRefOf } from './TaskRefs';

/**
 * The session side of the planner's catalog and submission tools (ADR-0022):
 * every answer is read from live state at the call, so what the planner plans
 * against is what its submission is checked against (L2, L3).
 */
export interface PlannerToolsHost {
  skills(): readonly SkillInfo[];
  /** The open planner turn's id: a call commits its plan or edit only in the turn it was made in. */
  turnId(): string | undefined;
  recordSkillLoad(skill: SkillLoad): boolean;
  /** Enabled runners, their modes and their allowlisted models, as of now. */
  liveCatalog(): Promise<TaskQueryCatalog>;
  /** A submitted plan held to the one check of a plan change (`PlanChangeCheck`), against the live catalog. */
  checkPlan(tasks: unknown): Promise<CheckedChange>;
  /** Commit a checked plan now, in the planner turn `turn` the call was made in (ADR-0022 P2). */
  submitPlan(tasks: Task[], turn: string): Promise<PlanEditOutcome>;
  /** Check a batch against the live catalog and commit it now, whole or not at all, in the planner turn `turn` the call was made in. */
  editPlan(ops: TaskOp[], turn: string): Promise<PlanEditOutcome>;
  /** The plan's tasks as they are now. */
  tasks(): readonly Task[];
  /** Spend one read of the open turn's budget, shared with the envelope's reads, and answer it. */
  read<T>(signature: string, answer: () => Promise<T>): Promise<ToolRead<T>>;
  /** The orchestrator's live capture for a task's latest attempt. */
  liveOutput: LiveOutputLookup;
  /** What a task's newest saved attempt did, or null when it left nothing to report. */
  lastAttempt(taskId: string): string | null;
  taskLogAttempts(taskId: string): number[];
  taskLog(taskId: string, attempt: number): TaskLogEvent[];
  taskDiff(taskId: string, options: TaskDiffRead): Promise<TaskDiffResult>;
  /** The planner's research shell: classified, confined and approved as the API planner's `bash` is (ADR-0026), or sealed (ADR-0036). */
  runCommand(command: string, signal: AbortSignal, opts?: BashOptions): Promise<ToolOutcome>;
  /** A fetch through the session's web fetcher, whose web-read policy decides it (ADR-0027). */
  fetchUrl(url: string): Promise<ToolOutcome>;
  /** A search the same way; undefined when the fetcher has no search. */
  webSearch(query: string): Promise<ToolOutcome | undefined>;
  /**
   * An execution command through the session's command seam (ADR-0029), asked
   * by this planner turn. `signal` ends a wait on the caller's behalf: the
   * call's own cancellation, or its turn ending.
   */
  execute(command: ExecutionCommand, signal?: AbortSignal): Promise<CommandOutcome>;
  /** Why the open turn may not make this change — a wake-up turn under Watch, say (ADR-0029); undefined when it may. */
  editsRefused(change: PlanChange): string | undefined;
}

/**
 * Refused when the turn a call was made in ends while the call waits on a
 * catalog or skill check: a plan or edit committed then would land in a turn
 * that never asked for it.
 */
export const PLANNER_TURN_ENDED = 'The planning turn this call was made in has ended, so nothing was changed.';

/** A task as a planner tool's answer names it, by the id and the reference a later call can read or start it by. */
export interface TaskHead {
  id: string;
  ref: string;
  title: string;
}

/** What a plan or an edit made through the tool came to: committed, or refused with nothing changed. */
export type PlanEditOutcome =
  | {
    ok: true;
    /** What an edit changed; empty for a plan. */
    summary: string[];
    coerced?: AssignmentAdjustment[];
    warnings?: string[];
    /** A plan's tasks, or the tasks an edit added. */
    tasks: TaskHead[];
    /** The task each handle the edit gave names. */
    handles?: Record<string, TaskHead>;
  }
  | { ok: false; errors: PlanChangeError[]; runners?: RunnerId[] };

/** The runners a set of tasks runs on. A user task runs on none, and a script task on no runner (ADR-0035). */
export function runnersOf(tasks: readonly Task[]): RunnerId[] {
  return [...new Set(flattenTasks(tasks).filter((t) => t.type === 'ai').map((t) => t.assignedRunner))];
}

export function plannerToolHandler(host: PlannerToolsHost): PlannerToolHandler {
  // Bound to the turn it was made in: a late call from a turn that ended has nobody's consent behind it.
  const execute = async (command: ExecutionCommand, signal?: AbortSignal): Promise<McpToolReply> => {
    if (host.turnId() === undefined) return { isError: true, text: JSON.stringify({ ok: false, outcome: 'refused', reason: 'No planning turn is open, so nothing was done.' }) };
    const outcome = await host.execute(command, signal);
    return outcome.ok
      ? answer({ ok: true, result: outcome.message })
      : { isError: true, text: JSON.stringify({ ok: false, outcome: outcome.outcome, reason: outcome.message }) };
  };

  return {
    runPlan: () => execute({ command: 'run_plan' }),
    runTask: ({ task }) => execute({ command: 'run_task', task: String(task) }),
    stopTask: ({ task }) => execute({ command: 'stop_task', task: String(task) }),
    stopRun: () => execute({ command: 'stop_run' }),
    retryTask: ({ task, from, message }) => execute({ command: 'retry_task', task: String(task), from, ...(message !== undefined ? { message } : {}) }),
    skipTask: ({ task, reason }) => execute({ command: 'skip_task', task: String(task), reason }),
    messageTask: ({ task, text }) => execute({ command: 'message_task', task: String(task), text }),
    answerApproval: ({ task, approval, answer: reply, note }) => execute({
      command: 'answer_approval', task: String(task), answer: reply,
      ...(approval !== undefined ? { approval } : {}),
      ...(note !== undefined ? { note } : {}),
    }),
    answerCheckpoint: ({ task, answer: reply, reason }) => execute({
      command: 'answer_checkpoint', task: String(task), answer: reply,
      ...(reason !== undefined ? { reason } : {}),
    }),
    mergeAll: () => execute({ command: 'merge_all' }),
    runScript: ({ title, commands, script, timeoutMs, dependencies }, { signal }) => execute({
      command: 'run_script', title,
      ...(commands !== undefined ? { commands } : {}),
      ...(script !== undefined ? { script } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(dependencies !== undefined ? { dependencies: dependencies.map(String) } : {}),
    }, signal),

    async loadSkill({ name }) {
      const skills = modelInvocablePlannerSkills(host.skills());
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return { isError: true, text: `Skill "${name}" cannot be loaded by the planner. Loadable skills: ${skills.map((s) => s.name).join(', ') || '(none)'}.` };
      }
      if (!host.recordSkillLoad(snapshotSkill(skill, 'planner'))) {
        return { isError: true, text: 'No planning turn is open to load a skill.' };
      }
      return { text: skill.content };
    },

    async runCommand({ command, sealed }, { signal }) {
      return commandReply(await (sealed ? host.runCommand(command, signal, { sealed }) : host.runCommand(command, signal)));
    },

    async fetch({ url }) {
      return outcomeReply(await host.fetchUrl(url));
    },

    async webSearch({ query }) {
      const outcome = await host.webSearch(query);
      if (!outcome) return { isError: true, text: 'Web search is not available in this session. If you already know a documentation URL, fetch it instead.' };
      return outcomeReply(outcome);
    },

    async listRunners() {
      const catalog = await host.liveCatalog();
      return answer({
        autonomy: autonomyLevelLabel(catalog.autonomousDefault),
        // No mode names: the planner says only whether a task is read-only (ADR-0031).
        runners: catalog.runners.map((id) => ({ id, readOnly: readOnlyMode(catalog.modes[id]) !== undefined })),
      });
    },

    async listModels({ runner }) {
      const catalog = await host.liveCatalog();
      if (!catalog.runners.includes(runner)) return notEnabled(runner, catalog.runners);
      return answer({
        runner,
        models: (catalog.models[runner] ?? []).map((m) => ({
          modelId: m.modelId,
          modelLabel: m.modelLabel,
          variants: (m.variants ?? []).map((v) => ({ id: v.id, label: v.label })),
        })),
      });
    },

    async submitPlan({ tasks }) {
      const refused = host.editsRefused('plan');
      if (refused) return { isError: true, text: JSON.stringify({ ok: false, errors: [{ field: 'tasks', message: refused }] }) };
      const turn = host.turnId();
      if (turn === undefined) return { isError: true, text: JSON.stringify({ ok: false, errors: [{ field: 'tasks', message: 'No planning turn is open to take the plan.' }] }) };
      const checked = await host.checkPlan(tasks);
      if (host.turnId() !== turn) return { isError: true, text: JSON.stringify({ ok: false, errors: [{ field: 'tasks', message: PLANNER_TURN_ENDED }] }) };
      const outcome = checked.ok ? await host.submitPlan(checked.tasks, turn) : checked;
      if (!outcome.ok) {
        // A rule a task breaks names what would be accepted; a skill is the skill catalog's, which is not the runners'.
        const skills = outcome.errors.every((e) => e.field === 'skills');
        const runners = skills ? undefined : outcome.runners;
        return { isError: true, text: JSON.stringify({ ok: false, errors: outcome.errors.map(planErrorReply), ...(runners ? { enabledRunners: runners } : {}) }) };
      }
      // What reading its JSON warned of, and what committing it did: a skill checked at both says so once.
      const warnings = [...new Set([...(checked.ok ? checked.warnings : []), ...outcome.warnings ?? []])];
      return answer({
        ok: true,
        tasks: outcome.tasks,
        coerced: outcome.coerced ?? [],
        ...(warnings.length > 0 ? { warnings } : {}),
        next: 'The plan is committed: it is the current plan now, and the user is shown it. Tell them briefly what you submitted; do not repeat the plan as JSON.',
      });
    },

    async taskQuery({ tasks, fields, catalog }) {
      const query: TaskQuery = { tasks: (tasks ?? []).map(String), fields: fields ?? [...TASK_QUERY_TASK_FIELDS], catalog: catalog === true };
      return read(host, taskQuerySignature(query), async () => ({
        tasks: query.tasks.map((ref) => taskDetail(host.tasks(), ref, query.fields ?? [])),
        ...(query.catalog ? { catalog: catalogDetail(await host.liveCatalog()) } : {}),
      }));
    },

    async taskOutput({ task: ref, lines, since, attempt: asked, kinds }) {
      // A reference a run update shows, `#4@2/F3`, reads the attempt it names (ADR-0057 R1).
      const written = resolveWrittenRef(host.tasks(), String(ref));
      if (!written) return { isError: true, text: JSON.stringify({ ok: false, error: `No task matches "${ref}" in the current plan.` }) };
      const { task } = written;
      const attempt = asked ?? written.attempt;
      const maxLines = Math.min(lines ?? OUTPUT_LINES_DEFAULT, OUTPUT_LINES_MAX);
      return read(host, JSON.stringify(['output', task.id, maxLines, since ?? null, attempt ?? null, kinds ? [...kinds].sort() : null]), async () => {
        const head = { task: taskHead(host.tasks(), task) };
        if (attempt !== undefined || kinds !== undefined) {
          const attempts = host.taskLogAttempts(task.id);
          const selected = attempt ?? attempts.at(-1);
          if (selected === undefined || !attempts.includes(selected)) {
            return { ok: false, error: selected === undefined ? 'No saved task log is available for this task.' : `No saved log for attempt ${selected}.`, attempts };
          }
          const output = renderTaskLog(host.taskLog(task.id, selected), kinds);
          return { ...head, attempt: selected, attempts, ...taskReadPage(output, { lines: maxLines, since }) };
        }
        const tail = host.liveOutput(task.id, { maxLines, sinceOffset: since });
        if (tail?.running) {
          const fitted = fitTail(tail.text, OUTPUT_TAIL_MAX_CHARS);
          return { ...head, running: true, output: fitted.text, nextOffset: tail.nextOffset, ...(fitted.trimmed ? { trimmedToFit: true } : {}) };
        }
        return {
          ...head,
          running: false,
          reason: 'This task is not running, so there is no live output: its outcome is below.',
          verdict: verdictRead(task.verdict),
          outputSummary: outputSummaryRead(task),
          handoff: endedHandoffDetail(host, task),
          lastAttempt: host.lastAttempt(task.id),
        };
      });
    },

    async taskDiff({ task: ref, ...options }) {
      const task = resolveTaskRef(host.tasks(), ref);
      if (!task) return { isError: true, text: JSON.stringify({ ok: false, error: `No task matches "${ref}" in the current plan.` }) };
      return read(host, JSON.stringify(['diff', task.id, options]), async () => {
        const result = await host.taskDiff(task.id, options);
        if (!result.available) return { ok: false, error: result.reason };
        return { task: taskHead(host.tasks(), task), ...taskReadPage(result.text, options) };
      });
    },

    async editPlan({ ops }) {
      // The applier checks each op's fields one by one, so a loose shape is its to refuse.
      const taskOps = ops as unknown as TaskOp[];
      const refused = host.editsRefused('edit');
      if (refused) return { isError: true, text: JSON.stringify({ ok: false, errors: [{ message: refused }] }) };
      const turn = host.turnId();
      if (turn === undefined) return { isError: true, text: JSON.stringify({ ok: false, errors: [{ message: 'No planning turn is open to take the edit.' }] }) };
      const outcome = await host.editPlan(taskOps, turn);
      if (!outcome.ok) return { isError: true, text: JSON.stringify({ ok: false, errors: outcome.errors.map(opErrorReply) }) };
      return answer({
        ok: true,
        summary: outcome.summary,
        ...(outcome.tasks.length > 0 ? { added: outcome.tasks } : {}),
        ...(outcome.handles ? { handles: outcome.handles } : {}),
        ...(outcome.coerced?.length ? { coerced: outcome.coerced } : {}),
        ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}),
        next: 'The edit is applied: the plan holds it now, and the user is shown what changed. A further edit_plan call is a batch of its own, against the plan as it is now. Tell the user briefly; do not repeat it as JSON.',
      });
    },
  };
}

/** A plan's refusal pinned to the task and field it is about. */
function planErrorReply({ taskId, field, message }: PlanChangeError): { taskId?: string; field: string; message: string } {
  return { ...(taskId !== undefined ? { taskId } : {}), field: field ?? 'tasks', message };
}

/** An edit's refusal pinned to the op of this call it is about, so the planner can fix that one. */
function opErrorReply({ op, message }: PlanChangeError): { op?: number; kind?: string; message: string } {
  return op ? { op: op.number, kind: op.kind, message } : { message };
}

/** A read through the budget the envelope's reads share, and what the planner is told when it is spent. */
async function read(host: PlannerToolsHost, signature: string, answerRead: () => Promise<object>): Promise<McpToolReply> {
  const result = await host.read(signature, answerRead);
  if (result.status === 'refused') {
    return { isError: true, text: JSON.stringify({ ok: false, error: 'You have used every read this message allows. Nothing was read: answer the user in prose, or call edit_plan for the change you came to make.' }) };
  }
  return { ...answer({ ...result.value, ...(result.landNow ? { note: TASK_READ_ANSWER_OR_EDIT } : {}) }), ...('ok' in result.value && result.value.ok === false ? { isError: true } : {}) };
}

/** A task's whole handoff from its latest attempt's log, findings and report, else the plan's digest. */
function endedHandoffDetail(host: PlannerToolsHost, task: Task) {
  if (!task.handoff) return null;
  const attempt = host.taskLogAttempts(task.id).at(-1);
  const events = attempt === undefined ? [] : host.taskLog(task.id, attempt);
  const logged = events.filter((e): e is Extract<TaskLogEvent, { type: 'handoff' }> => e.type === 'handoff').at(-1);
  return namedHandoff(host.tasks(), logged?.handoff ?? task.handoff);
}

/** A subtask's order restarts under its parent, so a read names it by its dotted reference, never a bare order. */
function refOf(plan: readonly Task[], task: Task): string {
  return taskRefOf(plan, task.id) ?? `#${task.order}`;
}

function taskHead(plan: readonly Task[], task: Task) {
  return { id: task.id, ref: refOf(plan, task), title: task.title, status: task.status };
}

/** A task read as the tool answers it: the rules are {@link readTask}'s, so both channels state them once. */
function taskDetail(plan: readonly Task[], ref: string, fields: readonly TaskQueryField[]) {
  const task = resolveTaskRef(plan, ref);
  return task ? taskReadDetail(readTask(plan, task, fields)) : { ref, error: 'no task matches this reference in the current plan.' };
}

function catalogDetail(catalog: TaskQueryCatalog) {
  return {
    runners: catalog.runners.map((id) => {
      return {
        id,
        models: (catalog.models[id] ?? []).map((m) => ({
          modelId: m.modelId,
          modelLabel: m.modelLabel,
          variants: (m.variants ?? []).map((v) => ({ id: v.id, label: v.label })),
        })),
        readOnly: readOnlyMode(catalog.modes[id]) !== undefined,
      };
    }),
  };
}

function outcomeReply(outcome: ToolOutcome): McpToolReply {
  return { text: outcome.output || (outcome.success ? '(nothing returned)' : 'The read failed with no message.'), ...(outcome.success ? {} : { isError: true }) };
}

function answer(body: unknown): McpToolReply {
  return { text: JSON.stringify(body) };
}

function notEnabled(runner: string, enabled: RunnerId[]): McpToolReply {
  return { isError: true, text: `Runner "${runner}" is not enabled. Enabled runners: ${enabled.join(', ') || '(none)'}.` };
}

