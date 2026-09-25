import { flag, positionals, saveLastSession } from '../utils';
import type { ApiClient } from '../daemonClient';
import { connect, fail } from './shared';
import { resolveSessionId } from './run';

const REWIND_USAGE = 'Usage: ordewell rewind [<n>] [--session-id <id>] [--workspace /path] — with no <n>, lists the messages you can rewind to.';

/**
 * Both act on a session the daemon holds; adopting first is a no-op for a live
 * one and makes a session from an earlier daemon run addressable. The plan it
 * answers is the saved shape, run record included — reading the session back
 * answers a phase-shaped view without it.
 */
export async function adopted(subArgs: string[], injectedApi?: ApiClient): Promise<{ api: ApiClient; sessionId: string; workspace: string; plan: unknown }> {
  const workspace = flag(subArgs, '--workspace') || process.cwd();
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
  console.log(`Forked ${sessionId} into ${fork.sessionId} — the fork is now the current session.`);
  console.log(`  \`ordewell sessions load ${sessionId}\` to go back to the original.`);
}

/**
 * Condense the conversation into a summary, keeping the last two exchanges. The
 * summary is printed because the user should see what the planner will carry
 * forward, not take it on trust.
 */
export async function handleCompact(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const { api, sessionId } = await adopted(subArgs, injectedApi);
  let result;
  try {
    result = await api.compactConversation(sessionId);
  } catch (err) {
    fail(`Failed to condense: ${(err as Error).message}`);
  }
  console.log(`Condensed ${sessionId}. The last two exchanges were kept as they were; the tasks are unchanged.\n`);
  console.log(result.summary);
}

/**
 * Cut the conversation back to just before message <n>. With no <n>, print the
 * messages the TUI's picker would offer — the same numbers `rewind <n>` takes.
 */
export async function handleRewind(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const arg = positionals(subArgs)[0];
  if (arg !== undefined && !/^\d+$/.test(arg)) fail(REWIND_USAGE);

  const { api, sessionId } = await adopted(subArgs, injectedApi);

  if (arg === undefined) {
    let targets;
    try {
      targets = await api.rewindTargets(sessionId);
    } catch (err) {
      fail(`Failed to list messages: ${(err as Error).message}`);
    }
    if (targets.length === 0) {
      console.log('Nothing to rewind to yet — the only message so far is the goal.');
      return;
    }
    console.log('Your messages, most recent first:\n');
    for (const t of [...targets].reverse()) console.log(`  ${String(t.index).padStart(4)}  ${t.preview}`);
    console.log('\n  `ordewell rewind <n>` discards message <n> and everything after it. The tasks stay as they are.');
    return;
  }

  try {
    await api.rewindConversation(sessionId, Number(arg));
  } catch (err) {
    fail(`Failed to rewind: ${(err as Error).message}`);
  }
  console.log(`Rewound ${sessionId} to just before message ${arg}. The tasks are unchanged; the next message continues from there.`);
}
