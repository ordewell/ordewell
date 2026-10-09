import { createSkillsService, EnvConfig } from '@ordewell/core';
import { canSetDependencies, dependencyCandidates, taskRef, titledTaskRef } from '@ordewell/core/plan-utils';
import { assignedModelFor, effortsForTask, modelsForTask, modesForTask, runnerAccepts } from '../tui/taskAssignment';
import type { TaskView } from '../tui/state';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { flag } from '../utils/args';
import { fail, fetchCatalog, taskViews } from './shared';
import { withResolvedTask } from './task-control';

/**
 * The per-task assignment editors, in the order each choice constrains the next:
 * runner → model → effort → mode. That ordering is the reason `task-runner`
 * sends nothing but the runner (see `assignRunner`), and the reason a model is
 * validated against the task's runner rather than the global catalog.
 */

/** Resolves the task, hands over its `TaskView` plus the value the user typed. */
async function withTask(
  subArgs: string[],
  usage: string,
  injectedApi: ApiClient | undefined,
  run: (api: ApiClient, sessionId: string, task: TaskView, tasks: TaskView[], value: string | undefined) => Promise<void>,
  { joinValue = false }: { joinValue?: boolean } = {},
): Promise<void> {
  await withResolvedTask(subArgs, usage, injectedApi, async (api, sessionId, taskId, plan) => {
    const tasks = taskViews(plan);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) fail(`Task not found in the plan: ${taskId}`);
    // The first positional is the task identifier itself; the value is the second.
    const [, ...rest] = positionals(subArgs);
    const value = joinValue ? (rest.join(' ') || undefined) : rest[0];
    await run(api, sessionId, task, tasks, value);
  });
}

const RUNNER_USAGE = 'Usage: ordewell task-runner <task-id-or-order> [<runner>] [--session-id <id>]';

export async function handleTaskRunner(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, RUNNER_USAGE, injectedApi, async (api, sessionId, task, _tasks, runner) => {
    if (task.type !== 'ai') {
      fail('Manual tasks do not run on an executor, so they have no runner.');
    }

    const state = await api.getRunners();
    if (!runner) {
      console.log(`\nRunner · ${titledTaskRef(task)}\n`);
      for (const r of state.runners) {
        console.log(`  ${r.id === task.assignedRunner ? '*' : ' '} ${r.id.padEnd(14)} ${r.name}${r.enabled ? '' : '  (not enabled for planning)'}`);
      }
      console.log(`\n  ${RUNNER_USAGE}`);
      return;
    }

    if (!state.runners.some((r) => r.id === runner)) {
      fail(`Unknown runner: ${runner}`, `This daemon knows: ${state.runners.map((r) => r.id).join(', ')}`);
    }

    // Only the runner goes on the wire. The daemon owns the retarget
    // (`Session.setTaskRunner`): it re-derives model, effort and mode from the
    // new runner's catalog. Naming a model here would race that derive and
    // could persist one the runner cannot spawn.
    await api.updateTask(sessionId, task.id, { assignedRunner: runner });
    console.log(`Task ${taskRef(task)} runner set to ${runner} — its model, effort and mode were re-picked for it.`);
  });
}

const MODEL_USAGE = 'Usage: ordewell task-model <task-id-or-order> [<model-id>] [--session-id <id>]';

export async function handleTaskModel(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, MODEL_USAGE, injectedApi, async (api, sessionId, task, _tasks, modelId) => {
    const catalog = await fetchCatalog(api);
    const options = modelsForTask(catalog.models, task);

    if (!modelId) {
      console.log(`\nModel · ${titledTaskRef(task)}${task.assignedRunner ? ` (${task.assignedRunner})` : ''}\n`);
      if (options.length === 0) console.log('  No models discovered for this runner — try `ordewell refresh`.');
      for (const m of options) {
        const detail = [m.provider, m.variants?.length ? `${m.variants.length} effort levels` : 'runner default effort']
          .filter(Boolean).join(' · ');
        console.log(`  ${m.id === task.assignedModel?.modelId ? '*' : ' '} ${m.id}`);
        console.log(`      ${m.label} — ${detail}`);
      }
      console.log(`\n  ${MODEL_USAGE}`);
      return;
    }

    // An unknown id is only refused when the task's runner demonstrably does not
    // serve it; a model absent from a cold catalog is passed through unchanged.
    const model = catalog.models.find((m) => m.id === modelId)
      ?? { id: modelId, label: modelId, provider: '', variants: [] };
    if (!runnerAccepts(task, model)) {
      fail(`${model.label} was not discovered for ${task.assignedRunner}.`);
    }

    const assignedModel = assignedModelFor(model, task.assignedModel?.thinkingEffort);
    await api.updateTask(sessionId, task.id, {
      // JSON drops `undefined`; null is intentional so changing models also
      // clears a stale legacy top-level effort on the persisted task.
      assignedModel,
      thinkingEffort: assignedModel.thinkingEffort ?? null,
    });
    console.log(`Task ${taskRef(task)} model set to ${model.label}.`);
    if (task.assignedModel?.thinkingEffort && !assignedModel.thinkingEffort) {
      console.log(`  ${model.label} does not expose "${task.assignedModel.thinkingEffort}", so the effort went back to the runner default.`);
    }
  });
}

const EFFORT_USAGE = 'Usage: ordewell task-effort <task-id-or-order> [<level>|default] [--session-id <id>]';

export async function handleTaskEffort(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, EFFORT_USAGE, injectedApi, async (api, sessionId, task, _tasks, level) => {
    const catalog = await fetchCatalog(api);
    const variants = effortsForTask(catalog.models, task);
    const current = task.assignedModel?.thinkingEffort;

    if (!level) {
      console.log(`\nThinking effort · ${titledTaskRef(task)}\n`);
      console.log(`  ${current ? ' ' : '*'} default        Let the executor choose`);
      for (const v of variants) {
        console.log(`  ${v.id === current ? '*' : ' '} ${v.id.padEnd(14)} ${v.label}`);
      }
      if (variants.length === 0) {
        console.log(`\n  ${task.assignedModel?.modelLabel ?? 'This model'} exposes no effort levels.`);
      }
      console.log(`\n  ${EFFORT_USAGE}`);
      return;
    }

    const wanted = level.toLowerCase();
    const thinkingEffort = wanted === 'default' ? undefined : wanted;
    if (thinkingEffort && !variants.some((v) => v.id === thinkingEffort)) {
      fail(
        variants.length > 0
          ? `Unknown effort: ${level}. Available: ${variants.map((v) => v.id).join(', ')}, default.`
          : `${task.assignedModel?.modelLabel ?? 'This task model'} exposes no effort levels.`,
      );
    }

    await api.updateTask(sessionId, task.id, {
      assignedModel: task.assignedModel ? { ...task.assignedModel, thinkingEffort } : undefined,
      thinkingEffort: thinkingEffort ?? null,
    });
    console.log(`Task ${taskRef(task)} thinking effort set to ${thinkingEffort ?? 'runner default'}.`);
  });
}

const MODE_USAGE = 'Usage: ordewell task-mode <task-id-or-order> [<mode>] [--session-id <id>]';

export async function handleTaskMode(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, MODE_USAGE, injectedApi, async (api, sessionId, task, _tasks, mode) => {
    const catalog = await fetchCatalog(api);
    const modes = modesForTask(catalog.modesByRunner, task);

    if (!mode) {
      console.log(`\nMode · ${titledTaskRef(task)}${task.assignedRunner ? ` (${task.assignedRunner})` : ''}\n`);
      if (modes.length === 0) {
        console.log('  This task has no runner, or its runner declares no modes.');
      }
      for (const m of modes) {
        console.log(`  ${m.id === task.taskMode ? '*' : ' '} ${m.id.padEnd(14)} ${m.label}${m.description ? ` — ${m.description}` : ''}`);
      }
      console.log(`\n  ${MODE_USAGE}`);
      return;
    }

    // A mode id means nothing outside the runner that declares it, so this is
    // checked against that runner's manifest rather than a global list.
    const chosen = modes.find((m) => m.id === mode);
    if (!chosen) {
      fail(
        modes.length > 0
          ? `Unknown mode "${mode}" for ${task.assignedRunner}. Available: ${modes.map((m) => m.id).join(', ')}.`
          : `${task.assignedRunner ?? 'This task'} declares no modes.`,
      );
    }

    await api.updateTask(sessionId, task.id, { taskMode: chosen.id });
    console.log(`Task ${taskRef(task)} mode set to ${chosen.label}.`);
  });
}

const DEPS_USAGE = 'Usage: ordewell task-deps <task-id-or-order> [<id,id,…>|none] [--session-id <id>]';

export async function handleTaskDeps(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, DEPS_USAGE, injectedApi, async (api, sessionId, task, tasks, value) => {
    const candidates = dependencyCandidates(tasks, task.id);

    if (!value) {
      console.log(`\nDependencies · ${titledTaskRef(task)}\n`);
      if (candidates.length === 0) {
        console.log(`  Nothing runs before ${taskRef(task)}, so it has no possible dependencies.`);
      }
      for (const c of candidates) {
        const chosen = task.dependencies.includes(c.id);
        console.log(`  ${chosen ? '*' : ' '} ${c.id}  ${titledTaskRef(c)}${c.status === 'completed' ? '  (already completed)' : ''}`);
      }
      console.log(`\n  * = current. ${DEPS_USAGE}`);
      return;
    }

    const dependencies = value.toLowerCase() === 'none'
      ? []
      : value.split(',').map((s) => s.trim()).filter(Boolean)
          // Accept order numbers as well as ids, matching how every other
          // task-scoped command resolves its argument.
          .map((token) => tasks.find((t) => t.id === token || String(t.order) === token)?.id ?? token);

    // The same pre-flight the API applies, run here so the refusal names the
    // task rather than arriving as a bare HTTP error.
    const check = canSetDependencies(tasks, task.id, dependencies);
    if (!check.ok) fail(check.error ?? 'Invalid dependencies.');

    await api.updateTask(sessionId, task.id, { dependencies });
    console.log(dependencies.length > 0
      ? `Task ${taskRef(task)} now depends on ${dependencies.length} task${dependencies.length === 1 ? '' : 's'}.`
      : `Task ${taskRef(task)} no longer depends on anything.`);
  });
}

const SKILLS_USAGE = 'Usage: ordewell task-skills <task-id-or-order> [<name> [<name> …]|<name,name,…>|none] [--session-id <id>] [--workspace <path>]';

export async function handleTaskSkills(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, SKILLS_USAGE, injectedApi, async (api, sessionId, task, _tasks, value) => {
    if (task.type !== 'ai') fail('Manual tasks do not run an executor, so they take no skills.');
    // User-only skills are included: attaching by hand is a user invocation.
    const catalog = createSkillsService(flag(subArgs, '--workspace') || process.cwd(), new EnvConfig().workspaceRepos)
      .listSkills()
      .filter((s) => s.appliesTo === 'task');

    if (!value) {
      console.log(`\nSkills · ${titledTaskRef(task)}\n`);
      if (catalog.length === 0) console.log('  No task skills found (applies-to: task in .ordewell/skills/ or ~/.ordewell/skills/).');
      for (const s of catalog) {
        console.log(`  ${task.skills?.includes(s.name) ? '*' : ' '} ${s.name}${s.description ? `  ${s.description}` : ''}`);
      }
      for (const name of task.skills ?? []) {
        if (!catalog.some((s) => s.name === name)) console.log(`  * ${name} (not found)`);
      }
      console.log(`\n  * = attached. ${SKILLS_USAGE}`);
      return;
    }

    const skills = value.toLowerCase() === 'none' ? [] : [...new Set(value.toLowerCase().split(/[,\s]+/).filter(Boolean))];
    const unknown = skills.filter((name) => !catalog.some((s) => s.name === name));
    if (unknown.length > 0) {
      fail(`No task skill named ${unknown.map((n) => `"${n}"`).join(', ')}.`, `Task skills: ${catalog.map((s) => s.name).join(', ') || 'none'}`);
    }

    await api.updateTask(sessionId, task.id, { skills });
    console.log(skills.length > 0
      ? `Task ${taskRef(task)} skills set to ${skills.join(', ')}.`
      : `Task ${taskRef(task)} has no skills attached.`);
  }, { joinValue: true });
}

const OPS_USAGE = 'Usage: ordewell task-ops <task-id-or-order> [on|off] [--session-id <id>]';

/**
 * Change versus ops (ADR-0020). The daemon refuses a task that has started,
 * so only what is known here — a manual task, a subtask — is refused first.
 */
export async function handleTaskOps(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, OPS_USAGE, injectedApi, async (api, sessionId, task, tasks, value) => {
    if (!value) {
      console.log(`\n${titledTaskRef(task)} is ${task.ops ? 'an ops task: it runs in your checkout once the work it depends on is merged' : 'a change task: it runs in its own worktree'}.`);
      console.log(`\n  ${OPS_USAGE}`);
      return;
    }
    const to = value.toLowerCase();
    if (to !== 'on' && to !== 'off') fail(OPS_USAGE);
    if (task.type !== 'ai') fail('Only an AI task can be an ops task — a manual task already runs outside any worktree.');
    if (!tasks.some((t) => t.id === task.id)) fail('A subtask runs with its parent; make the parent an ops task instead.');

    await api.updateTask(sessionId, task.id, { ops: to === 'on' });
    console.log(to === 'on'
      ? `Task ${taskRef(task)} is an ops task: it runs in your checkout once the work it depends on is merged.`
      : `Task ${taskRef(task)} is a change task: it runs in its own worktree.`);
  });
}
