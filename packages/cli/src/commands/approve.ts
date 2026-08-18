import type { ApiClient } from '../daemonClient';
import { connect } from './shared';
import { followExecution, resolveSessionId } from './run';

/**
 * Sign off a plan paused on `review_needed` (the pre-execution approval gate) and
 * follow it the rest of the way. `ordewell run` starts a plan from the top;
 * this releases one that is already mid-flight, which is why it goes through
 * the review endpoint rather than re-executing.
 */
export async function handleApprove(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const sessionId = resolveSessionId(subArgs);
  const api = await connect(subArgs, injectedApi);

  try {
    await api.approveReview(sessionId);
  } catch (err) {
    console.error(`Failed to approve: ${(err as Error).message}`);
    process.exit(1);
  }

  console.error('Plan approved — continuing execution.');
  await followExecution(api, sessionId);
}
