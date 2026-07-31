import { findEnvFile, writeEnvVar } from '../utils/env';
import type { ApiClient } from '../daemonClient';
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
    }
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

const AUTO_USAGE = 'Usage: ordewell auto [on|off]';

/**
 * The approval posture new sessions start in. It lives only in `.env` and is
 * read by the client at launch (the daemon has no say in it), so unlike every
 * other setting here there is nothing to push — which also means a running TUI
 * keeps its current badge until it restarts.
 */
export function handleAuto(subArgs: string[]): void {
  const [arg] = positionals(subArgs);
  const currentRaw = process.env.ORDEWELL_AUTONOMOUS_MODE;
  const current = currentRaw !== 'false' && currentRaw !== '0';

  if (!arg) {
    console.log(`Autonomous mode: ${current ? 'ON' : 'OFF'}`);
    console.log(`  ${AUTO_USAGE}`);
    return;
  }

  const enabled = arg === 'on' ? true : arg === 'off' ? false : null;
  if (enabled === null) fail(AUTO_USAGE);

  writeEnvVar(findEnvFile(), 'ORDEWELL_AUTONOMOUS_MODE', String(enabled));
  process.env.ORDEWELL_AUTONOMOUS_MODE = String(enabled);
  console.log(`Autonomous mode ${enabled ? 'on' : 'off'} for new sessions.`);
}

/**
 * Re-probe runners, settings and model catalogs. The daemon does the actual
 * re-discovery inside `/api/models`; this asks for all three and prints what
 * came back, so a cold or broken catalog is visible rather than inferred from a
 * later command behaving oddly.
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
