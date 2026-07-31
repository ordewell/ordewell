import { runnerForProvider, type AiProvider } from '@ordewell/core';
import { findEnvFile, writeEnvVar } from '../utils/env';
import type { ApiClient } from '../daemonClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog } from './shared';

const USAGE = 'Usage: ordewell model [show | set <model-id>]';

/**
 * The planner's model. Unlike `ordewell models --set`, which only ever wrote
 * `.env` and told the user to restart, this pushes to the live daemon first and
 * persists second — the same seam the TUI's `/model` uses, so the change lands
 * on the next plan without a restart.
 */
export async function handleModel(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [action, modelId] = positionals(subArgs);

  if (action && action !== 'show' && action !== 'set') {
    fail(`Unknown model action: "${action}"`, USAGE);
  }

  const api = await connect(subArgs, injectedApi);

  if (action !== 'set') {
    await showModels(api);
    return;
  }

  if (!modelId) fail(USAGE);

  const settings = await api.getSettings();
  const provider = (typeof settings.aiProvider === 'string' ? settings.aiProvider : '') as AiProvider;
  // A harness planner can only run its own agent's models (ADR-0009), so the
  // typed path gets the same scoping the TUI picker does. A cold catalog says
  // nothing about the id, so it is only enforced once discovery has landed.
  const runner = runnerForProvider(provider);
  if (runner) {
    const known = (await fetchCatalog(api)).models.filter((m) => m.runners?.includes(runner));
    if (known.length > 0 && !known.some((m) => m.id === modelId)) {
      fail(
        `${modelId} was not discovered for ${runner}.`,
        `Run \`ordewell model\` to see what ${runner} offers.`,
      );
    }
  }

  await api.updateSettings({ orchestratorModel: modelId });
  writeEnvVar(findEnvFile(), 'ORCHESTRATOR_MODEL', modelId);
  process.env.ORCHESTRATOR_MODEL = modelId;
  console.log(`Planner model set to ${modelId}.`);
}

async function showModels(api: ApiClient): Promise<void> {
  const [settings, catalog] = await Promise.all([api.getSettings(), fetchCatalog(api)]);
  const provider = (typeof settings.aiProvider === 'string' ? settings.aiProvider : '') as AiProvider;
  const current = typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : '';
  const runner = runnerForProvider(provider);

  const options = runner
    ? catalog.models.filter((m) => m.runners?.includes(runner))
    : catalog.orchestratorModels;

  console.log(`\nPlanner model: ${current || '(backend default)'}`);
  console.log(`Planner backend: ${provider || '(default)'}${runner ? ` — showing ${runner} models only` : ''}\n`);

  if (options.length === 0) {
    console.log(runner
      ? `  No ${runner} models discovered yet — try \`ordewell refresh\`.`
      : '  No models discovered. Configure a provider key with `ordewell key set <provider> <key>`.');
  }

  for (const m of options) {
    const detail = [
      m.provider,
      m.pricing,
      m.variants?.length ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}` : undefined,
    ].filter(Boolean).join(' · ');
    console.log(`  ${m.id === current ? '*' : ' '} ${m.id}`);
    if (detail) console.log(`      ${m.label} — ${detail}`);
  }

  const failed = Object.entries(catalog.providerErrors);
  for (const [id, message] of failed) {
    console.error(`⚠ ${id}: ${message}`);
  }

  console.log(`\n  ${USAGE}`);
}
