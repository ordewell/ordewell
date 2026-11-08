import { positionals, saveLastSession, workspaceOf } from '../utils';
import type { ApiClient } from '../apiClient';
import { connect, fail, headlessPlannerRefusal, lostReplyHint } from './shared';
import { resolveSessionId } from './run';

const REWIND_USAGE = 'Usage: ordewell rewind [<n>] [--session-id <id>] [--workspace /path]: with no <n>, lists the messages you can rewind to.';

/**
 * Both act on a session the daemon holds; adopting first is a no-op for a live
 * one and makes a session from an earlier daemon run addressable. The plan it
 * answers is the saved shape, run record included — reading the session back
 * answers a phase-shaped view without it.
 */
export async function adopted(subArgs: string[], injectedApi?: ApiClient): Promise<{ api: ApiClient; sessionId: string; workspace: string; plan: unknown }> {
  const workspace = workspaceOf(subArgs);
  const sessionId = resolveSessionId(subArgs);
  const api = await connect(subArgs, injectedApi);
  let plan: unknown;
  try {
    ({ plan } = await api.adoptSession(sessionId, workspace));
  } catch (err) {
    fail(`Failed to load session: ${(err as Error).message}`);
  }
  return { api, sessionId, workspace, plan };
}

/**
 * Copy the conversation and its task list into a new session and make that the
 * current one — the TUI's `/fork` switches the same way. The original stays as
 * it was, run and all.
 */
export async function handleFork(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const { api, sessionId, workspace } = await adopted(subArgs, injectedApi);
  let fork;
  try {
    fork = await api.forkConversation(sessionId);
  } catch (err) {
    fail(`Failed to fork: ${(err as Error).message}`);
  }
  saveLastSession(fork.sessionId, fork.goal, fork.plan.runners ?? [], workspace);
  console.log(`Forked ${sessionId} into ${fork.sessionId}: the fork is now the current session.`);
  console.log(`  \`ordewell sessions load ${sessionId}\` to go back to the original.`);
}

/**
 * Condense what the planner is sent into a summary plus the last two exchanges.
 * The session keeps the whole conversation (ADR-0002); the summary is printed
 * because the user should see what the planner will carry forward, not take it
 * on trust.
 */
export async function handleCompact(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const action = positionals(subArgs)[0];
  if (action !== undefined && action !== 'retry') fail('Usage: ordewell compact [retry] [--session-id <id>] [--workspace /path]');
  if (action === 'retry') return retryCompaction(subArgs, injectedApi);
  const { api, sessionId } = await adopted(subArgs, injectedApi);
  let result;
  try {
    result = await api.compactConversation(sessionId);
  } catch (err) {
    fail(`Failed to condense: ${headlessPlannerRefusal(err) ?? (err as Error).message}`, ...[lostReplyHint(err, sessionId)].filter((hint) => hint !== null));
  }
  console.log(`Condensed ${sessionId}. The planner now works from this summary and the last two exchanges; the full conversation stays in the session and the tasks are unchanged.\n`);
  console.log(result.summary);
}

/**
 * Retry compaction of a planner paused on its context, as the TUI's
 * `/compact retry` does: the paused turn opens again on what it kept. Exits
 * non-zero when it paused again, with why.
 */
async function retryCompaction(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const { api, sessionId } = await adopted(subArgs, injectedApi);
  let plan: unknown;
  try {
    plan = await api.retryPlannerCompaction(sessionId);
  } catch (err) {
    fail(`Failed to retry compaction: ${headlessPlannerRefusal(err) ?? (err as Error).message}`, ...[lostReplyHint(err, sessionId)].filter((hint) => hint !== null));
  }
  const pause = (plan as { plannerContextPause?: { reason?: unknown } } | null)?.plannerContextPause;
  if (pause) fail(typeof pause.reason === 'string' ? pause.reason : 'The planner paused again on its context.');
  console.log(`The planner carried the paused turn on in ${sessionId}.`);
}

/**
 * Fork the conversation from just before message <n> and make the fork the
 * current session, as `fork` does; the original keeps its whole history. With
 * no <n>, print the messages the TUI's picker would offer — the same numbers
 * `rewind <n>` takes. The rewound message is printed in full so it can be
 * resent, or edited and sent, in the fork.
 */
export async function handleRewind(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const arg = positionals(subArgs)[0];
  if (arg !== undefined && !/^\d+$/.test(arg)) fail(REWIND_USAGE);

  const { api, sessionId, workspace } = await adopted(subArgs, injectedApi);

  if (arg === undefined) {
    let targets;
    try {
      targets = await api.rewindTargets(sessionId);
    } catch (err) {
      fail(`Failed to list messages: ${(err as Error).message}`);
    }
    if (targets.length === 0) {
      console.log('Nothing to rewind to yet: the only message so far is the goal.');
      return;
    }
    console.log('Your messages, most recent first:\n');
    for (const t of [...targets].reverse()) console.log(`  ${String(t.index).padStart(4)}  ${t.preview}`);
    console.log('\n  `ordewell rewind <n>` forks the conversation from just before message <n>. The original is kept, and the tasks ride along.');
    return;
  }

  let fork;
  try {
    fork = await api.rewindConversation(sessionId, Number(arg));
  } catch (err) {
    fail(`Failed to rewind: ${(err as Error).message}`);
  }
  saveLastSession(fork.sessionId, fork.goal, fork.plan.runners ?? [], workspace);
  console.log(`Forked ${sessionId} into ${fork.sessionId} from just before message ${arg}. The fork is now the current session.`);
  console.log(`  \`ordewell sessions load ${sessionId}\` to go back to the original.`);
  console.log('\nThe message you rewound to, to resend or edit:\n');
  console.log(fork.rewoundMessage);
}

/**
 * Keep what waits on the planner's usage limit from being sent at the reset,
 * as the TUI's `/resend cancel` does: it goes with the next message instead.
 */
export async function handleResend(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  if (positionals(subArgs)[0] !== 'cancel') fail('Usage: ordewell resend cancel [--session-id <id>] [--workspace /path]');
  const { api, sessionId } = await adopted(subArgs, injectedApi);
  let cancelled: boolean;
  try {
    ({ cancelled } = await api.cancelPlannerResend(sessionId));
  } catch (err) {
    fail(`Failed to cancel the resend: ${(err as Error).message}`);
  }
  console.log(cancelled ? 'Resend cancelled: what waits goes with your next message.' : 'Nothing waits on the planner\'s usage limit to be sent at a reset.');
}
