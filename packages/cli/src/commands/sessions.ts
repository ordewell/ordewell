import { expandSessionId, hasFlag, positionals, saveLastSession, readLastSession, workspaceOf } from '../utils';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient } from '../apiClient';

const USAGE = 'Usage: ordewell sessions list|load <id>|delete <id> [--workspace /path] [--json]';

/**
 * Named sessions come straight from core's sessionStore (via `/api/sessions`);
 * `load` just repoints the CLI's "last session" marker so `run`/`status`/task
 * commands target a past session.
 */
export async function handleSessions(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [action, identifier] = positionals(subArgs);
  const workspace = workspaceOf(subArgs);
  // `status` prints the tail of an id; load/delete must accept what it printed.
  const target = identifier ? expandSessionId(identifier, workspace) : undefined;
  const asJson = hasFlag(subArgs, '--json');

  const api = injectedApi || new ApiClient(await ensureDaemon(resolvePort(subArgs)), workspaceOf(subArgs));

  if (!action || action === 'list') {
    const sessions = await api.getSessions(workspace);
    if (asJson) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log(`No sessions found in ${workspace}.`);
      return;
    }
    const last = readLastSession(workspace);
    console.log(`${sessions.length} session(s) in ${workspace}:\n`);
    for (const s of sessions) {
      const marker = last?.sessionId === s.id ? '*' : ' ';
      console.log(`${marker} ${s.id}  ${s.status.padEnd(10)}  ${String(s.taskCount).padStart(3)} tasks  ${s.createdAt.slice(0, 16)}  ${s.goal.slice(0, 50)}`);
    }
    console.log('\n  * = current session. `ordewell sessions load <id>` to switch.');
    return;
  }

  if (action === 'load') {
    if (!target) {
      console.error(USAGE);
      process.exit(1);
    }
    let session;
    try {
      session = await api.getSession(target, workspace);
      // Adopt it on the server too — the marker alone only tells the CLI which
      // id to send; the daemon can execute a session only once it holds one.
      await api.adoptSession(target, workspace);
    } catch (err) {
      console.error(`Failed to load session: ${(err as Error).message}`);
      process.exit(1);
      return;
    }
    const { meta } = session;
    saveLastSession(meta.id, meta.goal, meta.runners || [], workspace);
    console.log(`Loaded session ${meta.id} ("${meta.goal}"): ${meta.taskCount} tasks, status ${meta.status}.`);
    console.log("  `ordewell status` for detail, `ordewell run` to execute.");
    return;
  }

  if (action === 'delete') {
    if (!target) {
      console.error(USAGE);
      process.exit(1);
    }
    try {
      const result = await api.deleteSession(target, workspace);
      if (!result.ok) {
        console.error(result.message ?? `No session "${target}" was found in ${workspace}.`);
        process.exit(1);
        return;
      }
      console.log(result.message ?? `Deleted session ${target}.`);
    } catch (err) {
      console.error(`Failed to delete session: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown sessions action: "${action}"`);
  console.error(USAGE);
  process.exit(1);
}
