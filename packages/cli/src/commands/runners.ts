import { HEADLESS_CLI_SIGN_IN, SettingsService, autonomyLevelLabel, codexSandboxNotice, describeRunnerSignIn, parseAutonomyLevel } from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog } from './shared';

const USAGE = 'Usage: ordewell runners [<runner-id> on|off]';

export async function handleRunners(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [runner, toggle] = positionals(subArgs);
  const api = await connect(subArgs, injectedApi);

  if (!runner) {
    const state = await api.getRunners();
    console.log('\nRunners\n');
    for (const r of state.runners) {
      console.log(`  ${r.enabled ? '✓' : ' '} ${r.id.padEnd(14)} ${r.name}${r.enabled ? '' : '  (disabled)'}`);
      const way = describeRunnerSignIn(r.auth, HEADLESS_CLI_SIGN_IN);
      if (way) console.log(`      ${way}`);
    }
    // After the runner list, so the daemon has re-probed the host by now. A
    // catalog that cannot be read leaves the list as it is.
    const notice = codexSandboxNotice((await fetchCatalog(api).catch(() => null))?.modesByRunner);
    if (notice) console.log(`\n  ${notice.line}\n  ${notice.docs}`);
    console.log(`\n  ✓ = offered to the planner. ${USAGE}`);
    return;
  }

  const state = await api.getRunners();
  const known = state.runners.find((r) => r.id === runner);
  if (!known) {
    fail(`Unknown runner: ${runner}`, `Enabled or not, this daemon knows: ${state.runners.map((r) => r.id).join(', ')}`);
  }

  const enabled = toggle === undefined ? !known.enabled : toggle === 'on' ? true : toggle === 'off' ? false : null;
  if (enabled === null) fail(USAGE);

  await api.setRunnerEnabled(runner, enabled);
  console.log(`${runner} ${enabled ? 'enabled' : 'disabled'}.`);
}

const AUTO_USAGE = 'Usage: ordewell auto [full|guarded]';

/**
 * The approval posture new plans start in, saved in the user's settings
 * (ADR-0030), where the daemon reads it for each plan. Written here rather than
 * through the daemon, which refuses it as approval posture.
 */
export function handleAuto(subArgs: string[]): void {
  const [arg] = positionals(subArgs);
  const settings = new SettingsService();
  const current = settings.autonomousMode();

  if (!arg) {
    console.log(`Autonomy level: ${autonomyLevelLabel(current)}`);
    console.log(`  ${AUTO_USAGE}`);
    return;
  }

  const enabled = parseAutonomyLevel(arg);
  if (enabled === null) fail(AUTO_USAGE);

  settings.setAutonomousMode(enabled);
  console.log(settings.autonomousModeOverridden()
    ? `${autonomyLevelLabel(enabled)} is saved, but ORDEWELL_AUTONOMOUS_MODE in the environment decides the level until it is unset.`
    : `Autonomy level: ${autonomyLevelLabel(enabled)} for new plans.`);
}

/**
 * Re-check runners and reread the daemon's cached model catalog. The runner
 * list re-probes installs; `/api/models` returns what the daemon already holds
 * and does not rediscover provider catalogs. This prints what came back, so a
 * cold or broken catalog is visible rather than inferred from a later command
 * behaving oddly.
 */
export async function handleRefresh(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const api = await connect(subArgs, injectedApi);
  const [runners, catalog] = await Promise.all([api.getRunners(), fetchCatalog(api)]);

  const enabled = runners.runners.filter((r) => r.enabled).map((r) => r.id);
  console.log(`Runners: ${enabled.length} enabled${enabled.length ? ` (${enabled.join(', ')})` : ''} of ${runners.runners.length}.`);
  console.log(`Models: ${catalog.models.length} executor, ${catalog.orchestratorModels.length} planner.`);
  console.log(`Providers with a working key: ${catalog.providers.length ? catalog.providers.join(', ') : 'none'}.`);

  for (const [id, message] of Object.entries(catalog.providerErrors)) {
    console.error(`⚠ ${id}: ${message}`);
  }
}
