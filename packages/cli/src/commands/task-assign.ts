import { canSetDependencies, dependencyCandidates } from '@ordewell/core/plan-utils';
import { assignedModelFor, effortsForTask, modelsForTask, modesForTask, runnerAccepts } from '../tui/taskAssignment';
import type { TaskView } from '../tui/state';
import type { ApiClient } from '../daemonClient';
import { positionals } from '../utils';
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
): Promise<void> {
  await withResolvedTask(subArgs, usage, injectedApi, async (api, sessionId, taskId, plan) => {
    const tasks = taskViews(plan);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) fail(`Task not found in the plan: ${taskId}`);
    // The first positional is the task identifier itself; the value is the second.
    const value = positionals(subArgs)[1];
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
      console.log(`\nRunner · #${task.order} ${task.title}\n`);
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
    console.log(`Task #${task.order} runner set to ${runner} — its model, effort and mode were re-picked for it.`);
  });
}

const MODEL_USAGE = 'Usage: ordewell task-model <task-id-or-order> [<model-id>] [--session-id <id>]';

export async function handleTaskModel(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, MODEL_USAGE, injectedApi, async (api, sessionId, task, _tasks, modelId) => {
    const catalog = await fetchCatalog(api);
    const options = modelsForTask(catalog.models, task);

    if (!modelId) {
      console.log(`\nModel · #${task.order} ${task.title}${task.assignedRunner ? ` (${task.assignedRunner})` : ''}\n`);
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
    console.log(`Task #${task.order} model set to ${model.label}.`);
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
      console.log(`\nThinking effort · #${task.order} ${task.title}\n`);
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
    console.log(`Task #${task.order} thinking effort set to ${thinkingEffort ?? 'runner default'}.`);
  });
}

const MODE_USAGE = 'Usage: ordewell task-mode <task-id-or-order> [<mode>] [--session-id <id>]';

export async function handleTaskMode(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, MODE_USAGE, injectedApi, async (api, sessionId, task, _tasks, mode) => {
    const catalog = await fetchCatalog(api);
    const modes = modesForTask(catalog.modesByRunner, task);

    if (!mode) {
      console.log(`\nMode · #${task.order} ${task.title}${task.assignedRunner ? ` (${task.assignedRunner})` : ''}\n`);
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
    console.log(`Task #${task.order} mode set to ${chosen.label}.`);
  });
}

const DEPS_USAGE = 'Usage: ordewell task-deps <task-id-or-order> [<id,id,…>|none] [--session-id <id>]';

export async function handleTaskDeps(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withTask(subArgs, DEPS_USAGE, injectedApi, async (api, sessionId, task, tasks, value) => {
    const candidates = dependencyCandidates(tasks, task.id);

    if (!value) {
      console.log(`\nDependencies · #${task.order} ${task.title}\n`);
      if (candidates.length === 0) {
        console.log(`  Nothing runs before #${task.order}, so it has no possible dependencies.`);
      }
      for (const c of candidates) {
        const chosen = task.dependencies.includes(c.id);
        console.log(`  ${chosen ? '*' : ' '} ${c.id}  #${c.order} ${c.title}${c.status === 'completed' ? '  (already completed)' : ''}`);
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
      ? `Task #${task.order} now depends on ${dependencies.length} task${dependencies.length === 1 ? '' : 's'}.`
      : `Task #${task.order} no longer depends on anything.`);
  });
}
