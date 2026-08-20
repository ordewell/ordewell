import { ApiClient } from '../daemonClient';
import { withResolvedTask } from './task-control';

export async function handleRemoveTask(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell remove-task <task-id-or-order> [--session-id <id>] [--workspace /path]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.removeTask(sessionId, taskId);
        console.log('Task removed.');
      } catch (err) {
        console.error(`Failed to remove task: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}
