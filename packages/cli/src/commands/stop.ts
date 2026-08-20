import { flag, readLastSession } from '../utils';
import { ensureDaemon, ApiClient, stopDaemon, resolvePort } from '../daemonClient';

export async function handleStop(subArgs: string[]): Promise<void> {
  if (subArgs.includes('--server') || subArgs[0] === 'server') {
    const stopped = await stopDaemon(resolvePort(subArgs));
    if (!stopped) process.exit(1);
    return;
  }

  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    const workspace = flag(subArgs, '--workspace') || process.cwd();
    const last = readLastSession(workspace);
    if (!last) {
      console.error('No session specified. Use --session-id <id> or --server to stop the server.');
      process.exit(1);
    }
    sessionId = last.sessionId;
    console.error(`Stopping last session: ${sessionId}`);
  }

  const port = await ensureDaemon(resolvePort(subArgs));
  const api = new ApiClient(port);
  await api.stopExecution(sessionId);
  console.log('Execution stopped.');
}
