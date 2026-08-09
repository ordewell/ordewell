import {
  ALL_PROVIDERS,
  CLI_PROVIDERS,
  PROVIDER_PRIORITY,
  isCliProvider,
  runnerForProvider,
  type AiProvider,
  type PlannerModelRecall,
} from '@ordewell/core';
import type { ApiClient } from '../daemonClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog, persistEnv, writeEnv } from './shared';
import { describePlannerSwitch } from '../plannerModelSwitch';

const KNOWN_PROVIDERS = Object.keys(ALL_PROVIDERS);

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
  if (!KNOWN_PROVIDERS.includes(provider)) {
    fail(`Unknown planner: ${provider}`, 'Run `ordewell planner` with no arguments to see the list.');
  }

  // The daemon owns the model decision now: remember what this provider was
  // last using, its catalog default, or nothing. Only the provider is ours to
  // send — see PlannerModelMemory.
  const settings = await persistEnv(api, { AI_PROVIDER: provider });
  const recall = describePlannerSwitch(settings, provider as AiProvider);
  writeEnv({ ORCHESTRATOR_MODEL: recall.model, ORDEWELL_PLANNER_EFFORT: recall.effort });

  const meta = ALL_PROVIDERS[provider as AiProvider];
  const catalog = await fetchCatalog(api);
  console.log(
    isCliProvider(provider as AiProvider)
      ? `Planning with ${meta.label} — no API key needed, it uses that agent's own subscription.`
      : `Planner set to ${meta.label}.`,
  );
  console.log(plannerModelLine(recall));
  if (!isCliProvider(provider as AiProvider) && !catalog.providers.includes(provider)) {
    console.log(`  No ${meta.apiKeyEnvVar} configured yet — set one with \`ordewell key set ${provider} <key>\`.`);
  }
}

/** Names which of the three model outcomes a switch landed on. */
function plannerModelLine(recall: PlannerModelRecall): string {
  switch (recall.source) {
    case 'remembered':
      return `  Restored its planner model: ${recall.model}.`;
    case 'catalog-default':
      return `  Using ${recall.model}, its default model — pick another with \`ordewell model set <id>\`.`;
    case 'none':
      return '  Pick a model with `ordewell model set <id>`, or leave it on the default.';
  }
}

async function showPlanners(api: ApiClient): Promise<void> {
  const [settings, catalog] = await Promise.all([api.getSettings(), fetchCatalog(api)]);
  const current = typeof settings.aiProvider === 'string' ? settings.aiProvider : '';

  console.log('\nCoding agents (no API key — they use their own subscription)');
  for (const id of CLI_PROVIDERS) {
    const runner = runnerForProvider(id);
    const discovered = runner ? catalog.models.some((m) => m.runners?.includes(runner)) : false;
    console.log(`  ${marker(id === current)} ${id.padEnd(14)} ${ALL_PROVIDERS[id].label}${discovered ? '' : '  (not detected)'}`);
  }

  console.log('\nAPI providers');
  for (const id of PROVIDER_PRIORITY) {
    const configured = catalog.providers.includes(id);
    const meta = ALL_PROVIDERS[id];
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
  const provider = (typeof settings.aiProvider === 'string' ? settings.aiProvider : '') as AiProvider;
  const modelId = typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : '';
  const currentEffort = typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : '';

  const runner = runnerForProvider(provider);
  if (!runner) {
    fail(
      'Thinking effort applies to a coding-agent planner.',
      'Switch with: ordewell planner claude-code|codex|opencode',
    );
  }

  const model = catalog.models.find((m) => m.id === modelId && m.runners?.includes(runner));
  const variants = model?.variants ?? [];

  if (!wanted || wanted === 'show') {
    console.log(`Planner effort: ${currentEffort || 'runner default'}`);
    if (!model) {
      console.log(`  No planner model selected for ${runner} — pick one with \`ordewell model set <id>\`.`);
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
