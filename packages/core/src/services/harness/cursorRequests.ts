import type { AcpExtensionHandler } from './acpProfiles';
import { isRecord } from './repoConfig';

/**
 * Cursor's own client-bound requests, which its agent waits on before the
 * turn goes on, answered for the `cursor-agent` profile. No recorded turn sent
 * either: asked to use AskQuestion and CreatePlan, Cursor answered it had no
 * such tool, on an account with no paid plan. So each params check is only
 * what any request must be: an object.
 */
export const CURSOR_EXTENSION_REQUESTS: Readonly<Record<string, AcpExtensionHandler>> = {
  // Nobody is at a task's terminal to answer, and holding the turn for one would stall it.
  'cursor/ask_question': (params) => (isRecord(params)
    ? { outcome: { outcome: 'skipped', reason: 'No user is present; decide and continue, or use Ordewell\'s checkpoint tool.' } }
    : undefined),
  // A planner and a read-only task may change nothing, so a plan to carry out has no place in either.
  'cursor/create_plan': (params, { restricted }) => {
    if (!isRecord(params)) return undefined;
    return restricted
      ? { outcome: { outcome: 'rejected', reason: 'Plan mode is not available in this role.' } }
      : { outcome: { outcome: 'accepted' } };
  },
};
