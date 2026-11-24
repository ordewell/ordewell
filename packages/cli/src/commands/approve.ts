import type { ApiClient } from '../apiClient';
import { handleRun } from './run';

/**
 * `ordewell approve`, kept so scripts that call it still work, and listed in
 * no help: starting a plan has one verb, run, since running a plan is what
 * approves it, one waiting for review included (ADR-0035).
 */
export async function handleApprove(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  console.error('`ordewell approve` is now `ordewell run`.');
  await handleRun(subArgs, injectedApi);
}
