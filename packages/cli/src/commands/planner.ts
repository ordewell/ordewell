import {
  CLI_PROVIDERS,
  HEADLESS_CLI_COMMANDS,
  PROVIDER_PRIORITY,
  getProviderMeta,
  isApiProvider,
  isCliProvider,
  runnerForProvider,
  type PlannerModelRecall,
} from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog, persistEnv, writeEnv } from './shared';
import { plannerSwitchOverrideNotice, plannerSwitchRecall, taskOnlyRunnerRefusal, uninstalledPlannerRefusal } from '../plannerModelSwitch';
import { plannerIdChoice } from '../runnerNames';
import { shellEnvValue } from '../utils/env';

/**
 * Everything that can plan, in one list (ADR-0009) — the `/planner` picker's
 * contents, printed. Coding agents come first for the same reason they lead
 * there: they need no API key, which makes them the answer for a user who has
 * just installed Ordewell and holds no vendor account.
 */
export async function handlePlanner(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const api = await connect(subArgs, injectedApi);
  const [wanted] = positionals(subArgs);

  if (!wanted || wanted === 'show') {
    await showPlanners(api);
    return;
  }

  const provider = wanted.toLowerCase();
  const meta = getProviderMeta(provider);
  if (!meta) {
    const taskOnly = taskOnlyRunnerRefusal(provider, (await api.getRunners()).runners, HEADLESS_CLI_COMMANDS.pickPlanner);
    if (taskOnly) fail(taskOnly);
    fail(`Unknown planner: ${provider}`, 'Run `ordewell planner` with no arguments to see the list.');
  }
  if (isCliProvider(provider)) {
    const installed = (await api.getRunners()).runners.map((r) => r.id);
    const refusal = uninstalledPlannerRefusal(provider, installed, HEADLESS_CLI_COMMANDS.pickPlanner);
    if (refusal) fail(refusal);
  }

  // The daemon owns the model decision now: remember what this provider was
  // last using, its catalog default, or nothing. Only the provider is ours to
  // send — see PlannerModelMemory. Read the shell's AI_PROVIDER before the
  // write: persistEnv replaces it in this process, and it is what every later
  // `ordewell plan` forwards to the daemon.
  const inherited = shellEnvValue('AI_PROVIDER');
  const settings = await persistEnv(api, { AI_PROVIDER: provider });
  const recall = plannerSwitchRecall(settings);
  writeEnv({ ORCHESTRATOR_MODEL: recall.model, ORDEWELL_PLANNER_EFFORT: recall.effort });

  const catalog = await fetchCatalog(api);
  const override = plannerSwitchOverrideNotice(provider, inherited);
  console.log(
    override ?? (isCliProvider(provider)
      ? `Planning with ${meta.label}: no API key needed, it uses that agent's own subscription.`
      : `Planner set to ${meta.label}.`),
  );
  console.log(plannerModelLine(recall));
  if (isApiProvider(provider) && !catalog.providers.includes(provider)) {
    console.log(`  No ${meta.apiKeyEnvVar} configured yet: set one with \`ordewell key set ${provider} <key>\`.`);
  }
}

/** Names which of the three model outcomes a switch landed on. */
function plannerModelLine(recall: PlannerModelRecall): string {
  switch (recall.source) {
    case 'remembered':
      return `  Restored its planner model: ${recall.model}.`;
    case 'catalog-default':
      return `  Using ${recall.model}, its default model: pick another with \`ordewell model set <id>\`.`;
    case 'none':
      return '  Pick a model with `ordewell model set <id>`, or leave it on the default.';
  }
}

async function showPlanners(api: ApiClient): Promise<void> {
  const [settings, catalog] = await Promise.all([api.getSettings(), fetchCatalog(api)]);
  const current = typeof settings.aiProvider === 'string' ? settings.aiProvider : '';

  console.log('\nCoding agents (no API key; they use their own subscription)');
  for (const id of CLI_PROVIDERS) {
    const runner = runnerForProvider(id);
    const discovered = runner ? catalog.models.some((m) => m.runners?.includes(runner)) : false;
    console.log(`  ${marker(id === current)} ${id.padEnd(14)} ${getProviderMeta(id)?.label ?? id}${discovered ? '' : '  (not detected)'}`);
  }

  console.log('\nAPI providers');
  for (const id of PROVIDER_PRIORITY) {
    const configured = catalog.providers.includes(id);
    const meta = getProviderMeta(id);
    console.log(`  ${marker(id === current)} ${id.padEnd(14)} ${meta.label}${configured ? '' : `  (no ${meta.apiKeyEnvVar})`}`);
  }

  console.log(`\n  * = current. Set with: ordewell planner <id>`);
}

function marker(selected: boolean): string {
  return selected ? '*' : ' ';
}

const EFFORT_USAGE = 'Usage: ordewell planner-effort [<level>|default]';

/**
 * The thinking effort of a *harness* planner (ADR-0009). Levels are variants of
 * the selected model, so the valid set comes from the catalog rather than a
 * fixed list — and it is empty for a vendor planner, which has no such knob.
 */
export async function handlePlannerEffort(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const api = await connect(subArgs, injectedApi);
  const [wanted] = positionals(subArgs);

  const [settings, catalog] = await Promise.all([api.getSettings(), fetchCatalog(api)]);
  const provider = typeof settings.aiProvider === 'string' ? settings.aiProvider : '';
  const modelId = typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : '';
  const currentEffort = typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : '';

  const runner = runnerForProvider(provider);
  if (!runner) {
    fail(
      'Thinking effort applies to a coding-agent planner.',
      `Switch with: ordewell planner ${plannerIdChoice()}`,
    );
  }

  const model = catalog.models.find((m) => m.id === modelId && m.runners?.includes(runner));
  const variants = model?.variants ?? [];

  if (!wanted || wanted === 'show') {
    console.log(`Planner effort: ${currentEffort || 'runner default'}`);
    if (!model) {
      console.log(`  No planner model selected for ${runner}: pick one with \`ordewell model set <id>\`.`);
    } else if (variants.length === 0) {
      console.log(`  ${model.label} exposes no effort levels; it always runs at the agent's default.`);
    } else {
      console.log(`  Available for ${model.label}: ${variants.map((v) => v.id).join(', ')}, default`);
    }
    console.log(`  ${EFFORT_USAGE}`);
    return;
  }

  const level = wanted.toLowerCase();
  if (level === 'default') {
    await persistEnv(api, { ORDEWELL_PLANNER_EFFORT: '' });
    console.log('Planner effort set to the runner default.');
    return;
  }

  if (!model) {
    fail(`No planner model selected for ${runner}.`, 'Pick one with: ordewell model set <id>');
  }
  if (!variants.some((v) => v.id === level)) {
    fail(
      variants.length > 0
        ? `Unknown effort: ${wanted}. Available for ${model.label}: ${variants.map((v) => v.id).join(', ')}, default.`
        : `${model.label} exposes no effort levels; it always runs at the agent's default.`,
    );
  }

  await persistEnv(api, { ORDEWELL_PLANNER_EFFORT: level });
  console.log(`Planner effort set to ${level}.`);
}
