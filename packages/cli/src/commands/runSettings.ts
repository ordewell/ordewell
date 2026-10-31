import type { GlobalRunSettings } from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import {
  ACT_RISK, AUTORUN_RISK, DELEGATION_RISK, SUPERVISOR_LEVEL_LABEL, PLANNED_WITH_LABEL, automergeSummary, autorunSummary, delegationSummary, parseCount, parseDelegation, parseSwitch, supervisorSummary, trailerSummary,
} from '@ordewell/core';
import { connect, fail } from './shared';

/**
 * The run settings (ADR-0030), saved as the default for new sessions. A
 * session already open keeps its own copy; only a change made in that session,
 * in the TUI, moves the run under way.
 */

const SUPERVISOR_USAGE = 'Usage: ordewell supervisor [off|watch|act] · ordewell supervisor retries <n> · ordewell supervisor reads <n>';
const AUTOMERGE_USAGE = 'Usage: ordewell automerge [on|off]';
const TRAILER_USAGE = 'Usage: ordewell trailer [on|off]';
const AUTORUN_USAGE = 'Usage: ordewell autorun [on|off]';
const DELEGATION_USAGE = 'Usage: ordewell delegation [off|<tokens>]';

async function save(api: ApiClient, changes: Partial<GlobalRunSettings>): Promise<void> {
  await api.updateRunSettings(changes);
}

export async function handleSupervisor(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [arg, value] = positionals(subArgs);
  let changes: Partial<GlobalRunSettings> | null = null;
  if (arg === 'off' || arg === 'watch' || arg === 'act') changes = { supervisorLevel: arg };
  else if (arg === 'retries') changes = maybe(parseCount(value, 0), (n) => ({ supervisorRetryLimit: n }));
  else if (arg === 'reads') changes = maybe(parseCount(value, 1), (n) => ({ wakeUpReadBudget: n }));
  if (arg !== undefined && changes === null) fail(SUPERVISOR_USAGE);

  const api = await connect(subArgs, injectedApi);
  if (!changes) {
    console.log(supervisorSummary((await api.getSettings()).run));
    console.log(`  ${SUPERVISOR_USAGE}`);
    return;
  }
  await save(api, changes);
  if (changes.supervisorLevel) console.log(`Supervisor: ${SUPERVISOR_LEVEL_LABEL[changes.supervisorLevel]}, for new sessions.`);
  if (changes.supervisorLevel === 'act') console.log(ACT_RISK);
  if (changes.supervisorRetryLimit !== undefined) console.log(`Supervisor retry limit: ${changes.supervisorRetryLimit} per task.`);
  if (changes.wakeUpReadBudget !== undefined) console.log(`Wake-up read budget: ${changes.wakeUpReadBudget} reads.`);
}

export async function handleAutomerge(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [arg] = positionals(subArgs);
  const enabled = arg === undefined ? null : parseSwitch(arg);
  if (arg !== undefined && enabled === null) fail(AUTOMERGE_USAGE);

  const api = await connect(subArgs, injectedApi);
  if (enabled === null) {
    console.log(automergeSummary((await api.getSettings()).run));
    console.log(`  ${AUTOMERGE_USAGE}`);
    return;
  }
  await save(api, { mergeAtGatesAutomatically: enabled });
  console.log(`Merge automatically (gates, end of run): ${enabled ? 'on' : 'off'}, for new sessions.`);
}

export async function handleTrailer(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [arg] = positionals(subArgs);
  const enabled = arg === undefined ? null : parseSwitch(arg);
  if (arg !== undefined && enabled === null) fail(TRAILER_USAGE);

  const api = await connect(subArgs, injectedApi);
  if (enabled === null) {
    console.log(trailerSummary((await api.getSettings()).run));
    console.log(`  ${TRAILER_USAGE}`);
    return;
  }
  await save(api, { plannedWithTrailer: enabled });
  console.log(`${PLANNED_WITH_LABEL}: ${enabled ? 'on' : 'off'}, from each session's next commit.`);
}

export async function handleAutorun(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [arg] = positionals(subArgs);
  const enabled = arg === undefined ? null : parseSwitch(arg);
  if (arg !== undefined && enabled === null) fail(AUTORUN_USAGE);

  const api = await connect(subArgs, injectedApi);
  if (enabled === null) {
    console.log(autorunSummary((await api.getSettings()).run));
    console.log(`  ${AUTORUN_USAGE}`);
    return;
  }
  await save(api, { autorun: enabled });
  console.log(`Autorun: ${enabled ? 'on: each plan the planner submits starts at once' : 'off: plans wait for your review'}.`);
  if (enabled) console.log(AUTORUN_RISK);
}

export async function handleDelegation(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [arg] = positionals(subArgs);
  const tokens = arg === undefined ? null : parseDelegation(arg);
  if (arg !== undefined && tokens === null) fail(DELEGATION_USAGE);

  const api = await connect(subArgs, injectedApi);
  if (tokens === null) {
    console.log(delegationSummary((await api.getSettings()).run));
    console.log(`  ${DELEGATION_USAGE}`);
    return;
  }
  await save(api, { delegationTokens: tokens });
  console.log(`${delegationSummary({ ...(await api.getSettings()).run, delegationTokens: tokens })}, for new sessions.`);
  if (tokens > 0) console.log(DELEGATION_RISK);
}

function maybe<T>(n: number | null, wrap: (n: number) => T): T | null {
  return n === null ? null : wrap(n);
}
