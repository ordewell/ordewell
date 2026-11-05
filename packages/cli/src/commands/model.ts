import { HEADLESS_CLI_COMMANDS, runnerForProvider } from '@ordewell/core';
import { findEnvFile, writeEnvVar } from '../utils/env';
import { vendorModelRefusal } from '../plannerModelSwitch';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog } from './shared';

const USAGE = 'Usage: ordewell model [show | set <model-id>]';

/**
 * The planner's model. Unlike `ordewell models --set`, which only ever wrote
 * `.env` and told the user to restart, this pushes to the live daemon first and
 * persists second, the same seam the TUI's `/planner` model step uses, so the
 * change lands on the next plan without a restart.
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
  const provider = typeof settings.aiProvider === 'string' ? settings.aiProvider : '';
  // A harness planner can only run its own agent's models (ADR-0009), so the
  // typed path gets the same scoping the TUI picker does. A cold catalog says
  // nothing about most ids, so the catalog is only enforced once discovery
  // has landed; a vendor's id is plainly not the agent's either way.
  const runner = runnerForProvider(provider);
  if (runner) {
    const known = (await fetchCatalog(api)).models.filter((m) => m.runners?.includes(runner));
    if (known.length > 0 && !known.some((m) => m.id === modelId)) {
      fail(
        `${modelId} was not discovered for ${runner}.`,
        `Run \`ordewell model\` to see what ${runner} offers.`,
      );
    }
    const refusal = known.length === 0 ? vendorModelRefusal(provider, modelId, HEADLESS_CLI_COMMANDS.pickPlanner) : null;
    if (refusal) fail(refusal);
  }

  // The daemon keeps the effort only where the new model offers it, so `.env`
  // takes whichever it settled on rather than the previous model's level.
  const settled = await api.updateSettings({ orchestratorModel: modelId });
  // A daemon that reports none has none: written as '' it clears the level, as
  // `ordewell planner-effort default` does.
  const effort = typeof settled.plannerThinkingEffort === 'string' ? settled.plannerThinkingEffort : '';
  const envFile = findEnvFile();
  writeEnvVar(envFile, 'ORCHESTRATOR_MODEL', modelId);
  writeEnvVar(envFile, 'ORDEWELL_PLANNER_EFFORT', effort);
  process.env.ORCHESTRATOR_MODEL = modelId;
  process.env.ORDEWELL_PLANNER_EFFORT = effort;
  console.log(`Planner model set to ${modelId}.`);
}

async function showModels(api: ApiClient): Promise<void> {
  const [settings, catalog] = await Promise.all([api.getSettings(), fetchCatalog(api)]);
  const provider = typeof settings.aiProvider === 'string' ? settings.aiProvider : '';
  const current = typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : '';
  const runner = runnerForProvider(provider);

  const options = runner
    ? catalog.models.filter((m) => m.runners?.includes(runner))
    : catalog.orchestratorModels;

  console.log(`\nPlanner model: ${current || '(backend default)'}`);
  console.log(`Planner backend: ${provider || '(default)'}${runner ? `: showing ${runner} models only` : ''}\n`);

  if (options.length === 0) {
    // A signed-out agent's list stays empty after any refresh, so its reason
    // replaces the refresh hint.
    const reason = runner ? catalog.runnerErrors[runner] : undefined;
    console.log(reason
      ? `  No ${runner} models discovered: ${reason}`
      : runner
        ? `  No ${runner} models discovered yet: try \`ordewell refresh\`.`
        : '  No models discovered. Configure a provider key with `ordewell key set <provider> <key>`.');
  }

  for (const m of options) {
    const detail = [
      m.provider,
      m.pricing,
      m.variants?.length ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}` : undefined,
    ].filter(Boolean).join(' · ');
    console.log(`  ${m.id === current ? '*' : ' '} ${m.id}`);
    if (detail) console.log(`      ${m.label}: ${detail}`);
  }

  const failed = Object.entries(catalog.providerErrors);
  for (const [id, message] of failed) {
    console.error(`⚠ ${id}: ${message}`);
  }

  console.log(`\n  ${USAGE}`);
}
