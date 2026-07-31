import { resolvePort, type ApiClient } from '../daemonClient';
import { openTaskTerminal } from '../tui/terminalLauncher';
import { withResolvedTask } from './task-control';

/**
 * Opens a real OS terminal attached to a task's runner, the same way the TUI's
 * `/terminal` does. The target is computed locally from port + task id — the
 * daemon a CLI talks to is always on 127.0.0.1, so there is nothing to ask it.
 */
export async function handleTerminal(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell terminal <task-id-or-order> [--session-id <id>]',
    injectedApi,
    async (_api, sessionId, taskId) => {
      const result = await openTaskTerminal(resolvePort(subArgs), sessionId, taskId);
      if (!result.ok) {
        console.error(result.message);
        process.exit(1);
      }
      console.log(result.message);
    },
  );
}
