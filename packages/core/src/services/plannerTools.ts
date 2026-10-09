import { flattenTasks, type RunnerId, type SkillLoad, type Task, type Verdict } from '../models/Task';
import type { SkillInfo } from './SkillsService';
import { modelInvocablePlannerSkills, snapshotSkill } from './skillInvocation';
import { autonomyLevelLabel, filteredBuildModes, resolveDefaultMode } from './ModeResolver';
import { validatePlanTasks } from './PlanValidator';
import {
  findTask, fitTail, taskQuerySignature, OUTPUT_LINES_DEFAULT, OUTPUT_LINES_MAX, OUTPUT_TAIL_MAX_CHARS, TASK_QUERY_TASK_FIELDS, TASK_READ_ANSWER_OR_EDIT,
  type LiveOutputLookup, type TaskQuery, type TaskQueryCatalog, type TaskQueryField,
} from './TaskQuery';
import type { TaskOp } from './TaskOps';
import { checkOpSkills, checkPlanSkills, type SkillLookup } from './taskSkills';
import type { ToolRead } from './PlannerConversation';
import type { McpToolReply, PlannerToolHandler } from './mcp';

/**
 * The session side of the planner's catalog and submission tools (ADR-0022):
 * every answer is read from live state at the call, so what the planner plans
 * against is what its submission is checked against (L2, L3).
 */
export interface PlannerToolsHost {
  skills(): readonly SkillInfo[];
  recordSkillLoad(skill: SkillLoad): boolean;
  /** Enabled runners, their modes and their allowlisted models, as of now. */
  liveCatalog(): Promise<TaskQueryCatalog>;
  /** The assignments a commit of these tasks would land, under the allowlist in force (ADR-0003). */
  coerce(tasks: readonly Task[], runners: RunnerId[]): Task[];
  /** Hand a validated plan to the open planner turn. False when no turn is open. */
  submitPlan(tasks: Task[], runners: RunnerId[]): boolean;
  /** Check a batch against the live catalog and hand it to the open planner turn, which commits it as it settles. */
  editPlan(ops: TaskOp[]): Promise<PlanEditOutcome>;
  /** The plan's tasks as they are now. */
  tasks(): readonly Task[];
  /** Spend one read of the open turn's budget, shared with the envelope's reads, and answer it. */
  read<T>(signature: string, answer: () => Promise<T>): Promise<ToolRead<T>>;
  /** The orchestrator's live capture for a task's latest attempt. */
  liveOutput: LiveOutputLookup;
  /** What a task's newest saved attempt did, or null when it left nothing to report. */
  lastAttempt(taskId: string): string | null;
  /** The skill catalog of the workspace root, which attached skill names are checked against. */
  taskSkills(): SkillLookup;
}

/** What an edit made through the tool came to. `queued`: the turn parks it behind the running batch, so nothing was checked. */
export type PlanEditOutcome =
  | { ok: true; summary: string[]; queued: boolean }
  | { ok: false; errors: string[] };

/** A change the commit makes to a submitted task, named so it is never silent (ADR-0001). */
interface Coercion {
  taskId: string;
  field: 'assignedRunner' | 'assignedModel' | 'thinkingEffort';
  from: string | null;
  to: string | null;
}

/** The runners a set of tasks runs on. A user task runs on none. */
export function runnersOf(tasks: readonly Task[]): RunnerId[] {
  return [...new Set(flattenTasks(tasks).filter((t) => t.type !== 'user').map((t) => t.assignedRunner))];
}

export function plannerToolHandler(host: PlannerToolsHost): PlannerToolHandler {
  return {
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

    async listRunners() {
      const catalog = await host.liveCatalog();
      return answer({
        autonomy: autonomyLevelLabel(catalog.autonomousDefault),
        runners: catalog.runners.map((id) => {
          const modes = catalog.modes[id] ?? [];
          // The modes the system prompt has always offered: those the
          // autonomy level allows, and `plan` for analysis-only work.
          const offered = [...filteredBuildModes(modes, catalog.autonomousDefault), ...modes.filter((m) => m.id === 'plan')];
          return {
            id,
            defaultMode: resolveDefaultMode(modes, catalog.autonomousDefault) ?? null,
            modes: offered.map(({ id: modeId, label, description }) => ({ id: modeId, label, description })),
          };
        }),
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
      const catalog = await host.liveCatalog();
      const result = validatePlanTasks({ tasks }, catalog.runners, catalog.modes, catalog.autonomousDefault);
      if (!result.ok) return { isError: true, text: JSON.stringify({ ok: false, errors: result.errors, enabledRunners: catalog.runners }) };
      const skills = checkPlanSkills(result.tasks, host.taskSkills());
      if (skills.errors.length > 0) {
        return { isError: true, text: JSON.stringify({ ok: false, errors: skills.errors.map((e) => ({ ...e, field: 'skills' })) }) };
      }

      const runners = runnersOf(result.tasks);
      const coerced = coercions(result.tasks, host.coerce(result.tasks, runners));
      if (!host.submitPlan(result.tasks, runners)) {
        return { isError: true, text: JSON.stringify({ ok: false, errors: [{ field: 'tasks', message: 'No planning turn is open to take the plan.' }] }) };
      }
      return answer({
        ok: true,
        tasks: result.tasks.length,
        coerced,
        ...(skills.warnings.length > 0 ? { warnings: skills.warnings } : {}),
        next: 'The plan is committed when this reply ends. Tell the user briefly what you submitted; do not repeat the plan as JSON.',
      });
    },

    async taskQuery({ tasks, fields, catalog }) {
      const query: TaskQuery = { tasks: (tasks ?? []).map(String), fields: fields ?? [...TASK_QUERY_TASK_FIELDS], catalog: catalog === true };
      return read(host, taskQuerySignature(query), async () => ({
        tasks: query.tasks.map((ref) => taskDetail(host.tasks(), ref, query.fields ?? [])),
        ...(query.catalog ? { catalog: catalogDetail(await host.liveCatalog()) } : {}),
      }));
    },

    async taskOutput({ task: ref, lines, since }) {
      const task = findTask(host.tasks(), String(ref));
      if (!task) return { isError: true, text: JSON.stringify({ ok: false, error: `No task matches "${ref}" in the current plan.` }) };
      const maxLines = Math.min(lines ?? OUTPUT_LINES_DEFAULT, OUTPUT_LINES_MAX);
      return read(host, JSON.stringify(['output', task.id, maxLines, since ?? null]), async () => {
        const head = { task: { id: task.id, order: task.order, title: task.title, status: task.status } };
        const tail = host.liveOutput(task.id, { maxLines, sinceOffset: since });
        if (tail?.running) {
          const fitted = fitTail(tail.text, OUTPUT_TAIL_MAX_CHARS);
          return { ...head, running: true, output: fitted.text, nextOffset: tail.nextOffset, ...(fitted.trimmed ? { trimmedToFit: true } : {}) };
        }
        return {
          ...head,
          running: false,
          reason: 'This task is not running, so there is no live output: its outcome is below.',
          verdict: verdictDetail(task.verdict),
          outputSummary: outputSummaryDetail(task),
          lastAttempt: host.lastAttempt(task.id),
        };
      });
    },

    async editPlan({ ops }) {
      // The applier checks each op's fields one by one, so a loose shape is its to refuse.
      const taskOps = ops as unknown as TaskOp[];
      const skills = checkOpSkills(taskOps, host.taskSkills());
      if (skills.errors.length > 0) return { isError: true, text: JSON.stringify({ ok: false, errors: skills.errors.map((e) => opError(e.message)) }) };
      const outcome = await host.editPlan(taskOps);
      if (!outcome.ok) return { isError: true, text: JSON.stringify({ ok: false, errors: outcome.errors.map(opError) }) };
      return answer({
        ok: true,
        summary: outcome.summary,
        queued: outcome.queued,
        ...(skills.warnings.length > 0 ? { warnings: skills.warnings } : {}),
        next: outcome.queued
          ? 'A task you named is running, so the edit is parked and nothing was checked: it is applied between task batches, when the user\'s message comes back to you. Tell the user it is queued.'
          : 'The edit is applied when this reply ends, and the user is shown what changed. Tell them briefly; do not repeat it as JSON.',
      });
    },
  };
}

/** The applier words an error "op 2 (update): …"; name the op so the planner can fix that one. */
function opError(message: string): { op?: number; kind?: string; message: string } {
  const match = /^op (\d+) \((\w+)\): ([\s\S]*)$/.exec(message);
  return match ? { op: Number(match[1]), kind: match[2], message: match[3] } : { message };
}

/** A read through the budget the envelope's reads share, and what the planner is told when it is spent. */
async function read(host: PlannerToolsHost, signature: string, answerRead: () => Promise<object>): Promise<McpToolReply> {
  const result = await host.read(signature, answerRead);
  if (result.status === 'refused') {
    return { isError: true, text: JSON.stringify({ ok: false, error: 'You have used every read this message allows. Nothing was read: answer the user in prose, or call edit_plan for the change you came to make.' }) };
  }
  return answer({ ...result.value, ...(result.landNow ? { note: TASK_READ_ANSWER_OR_EDIT } : {}) });
}

function verdictDetail(verdict: Verdict | undefined) {
  if (!verdict) return null;
  return {
    outcome: verdict.outcome,
    reason: verdict.reason,
    checks: verdict.checks.map((c) => ({ name: c.name, result: c.skipped ? 'skipped' : c.passed ? 'pass' : 'fail' })),
  };
}

function outputSummaryDetail({ outputSummary }: Task) {
  return outputSummary ? { reviewReason: outputSummary.reviewReason, ...(outputSummary.logTail ? { logTail: outputSummary.logTail } : {}) } : null;
}

/** A requested field with nothing in it reads `null`, so a missing answer is never mistaken for a field not asked for. */
function taskDetail(plan: readonly Task[], ref: string, fields: readonly TaskQueryField[]) {
  const task = findTask(plan, ref);
  if (!task) return { ref, error: 'no task matches this reference in the current plan.' };
  const wants = (field: TaskQueryField) => fields.includes(field);
  return {
    id: task.id,
    order: task.order,
    title: task.title,
    status: task.status,
    type: task.type === 'user' ? 'user' : 'ai',
    ...(wants('description') ? { description: task.description || null } : {}),
    ...(wants('prompt') ? { prompt: task.prompt || null } : {}),
    ...(wants('userSteps')
      ? { userSteps: task.userSteps?.length ? task.userSteps.map((s) => ({ order: s.order, instruction: s.instruction, completed: s.completed === true })) : null }
      : {}),
    ...(wants('verdict') ? { verdict: verdictDetail(task.verdict) } : {}),
    ...(wants('outputSummary') ? { outputSummary: outputSummaryDetail(task) } : {}),
    ...(wants('userStoriesCovered') ? { userStoriesCovered: task.userStoriesCovered?.length ? task.userStoriesCovered : null } : {}),
  };
}

function catalogDetail(catalog: TaskQueryCatalog) {
  return {
    runners: catalog.runners.map((id) => {
      const modes = catalog.modes[id] ?? [];
      const defaultMode = resolveDefaultMode(modes, catalog.autonomousDefault);
      return {
        id,
        models: (catalog.models[id] ?? []).map((m) => ({
          modelId: m.modelId,
          modelLabel: m.modelLabel,
          variants: (m.variants ?? []).map((v) => ({ id: v.id, label: v.label })),
        })),
        modes: modes.map((m) => ({ id: m.id, label: m.label, description: m.description, default: m.id === defaultMode })),
      };
    }),
  };
}

function answer(body: unknown): McpToolReply {
  return { text: JSON.stringify(body) };
}

function notEnabled(runner: string, enabled: RunnerId[]): McpToolReply {
  return { isError: true, text: `Runner "${runner}" is not enabled. Enabled runners: ${enabled.join(', ') || '(none)'}.` };
}

function coercions(submitted: readonly Task[], landed: readonly Task[]): Coercion[] {
  return submitted.flatMap((task, i) => {
    const after = landed[i];
    const out: Coercion[] = [];
    if (after.assignedRunner !== task.assignedRunner) {
      out.push({ taskId: task.id, field: 'assignedRunner', from: task.assignedRunner, to: after.assignedRunner });
    }
    const [fromModel, toModel] = [task.assignedModel?.modelId ?? null, after.assignedModel?.modelId ?? null];
    if (fromModel !== toModel) out.push({ taskId: task.id, field: 'assignedModel', from: fromModel, to: toModel });
    const [fromEffort, toEffort] = [task.assignedModel?.thinkingEffort ?? null, after.assignedModel?.thinkingEffort ?? null];
    if (fromEffort !== toEffort) out.push({ taskId: task.id, field: 'thinkingEffort', from: fromEffort, to: toEffort });
    return out;
  });
}
