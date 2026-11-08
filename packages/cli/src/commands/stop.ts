import { flag, readLastSession, workspaceOf } from '../utils';
import { stopDaemon, resolvePort } from '../daemon';
import type { ApiClient } from '../apiClient';
import { connect } from './shared';

export async function handleStop(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  if (subArgs.includes('--server') || subArgs[0] === 'server') {
    const stopped = await stopDaemon(resolvePort(subArgs));
    if (!stopped) process.exit(1);
    return;
  }

  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    const workspace = workspaceOf(subArgs);
    const last = readLastSession(workspace);
    if (!last) {
      console.error('No session specified. Use --session-id <id> or --server to stop the server.');
      process.exit(1);
    }
    sessionId = last.sessionId;
    console.error(`Stopping last session: ${sessionId}`);
  }

  const api = await connect(subArgs, injectedApi);
  const { message } = await api.stopExecution(sessionId);
  console.log(message ?? 'Execution stopped.');
}
