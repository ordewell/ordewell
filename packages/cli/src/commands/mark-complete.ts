import { ApiClient } from '../daemonClient';
import { withResolvedTask } from './task-control';

export async function handleMarkComplete(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell mark-complete <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.markTaskComplete(sessionId, taskId);
        console.log('Task marked complete.');
      } catch (err) {
        console.error(`Failed to mark task complete: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}

export async function handleUncomplete(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell uncomplete <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.markTaskIncomplete(sessionId, taskId);
        console.log('Task marked not done.');
      } catch (err) {
        console.error(`Failed to mark task not done: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}

/**
 * The daemon has no skip endpoint. The VS Code extension and the TUI both
 * implement skip as "mark it done and move on", so this does the same thing
 * rather than inventing a third meaning for the word.
 */
export async function handleSkip(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell skip <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.markTaskComplete(sessionId, taskId);
        console.log('Task skipped (marked complete so dependents can run).');
      } catch (err) {
        console.error(`Failed to skip task: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}
