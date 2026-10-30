import { revertEffect, revertListLine } from '@ordewell/core';
import { ApiClient } from '../apiClient';
import { hasFlag } from '../utils';
import { askYesNo, fail } from './shared';
import { withTaskRef } from './task-control';

/**
 * Revert one task's landed work on the integration branch (ADR-0054). The
 * daemon's preview says what goes with it, or why nothing does; the user is
 * shown that list and asked, and the daemon gets the yes with the ids they
 * saw. `--yes` skips the question but not the preview, so a refusal is read
 * the same way, and the list is still printed. With no terminal to ask on, the
 * answer is no.
 */
export async function handleRevert(subArgs: string[], api?: ApiClient, confirm: (question: string) => Promise<boolean> = askYesNo): Promise<void> {
  await withTaskRef(
    subArgs,
    'Usage: ordewell revert <task-id-or-order> [--session-id <id>] [--workspace /path] [--yes]',
    api,
    async (client, sessionId, ref) => {
      try {
        const preview = await client.revertPreview(sessionId, ref);
        if (!preview.revertible) fail(preview.message);
        console.log(`${revertEffect}\n${preview.tasks.map((t) => `  ${revertListLine(t)}`).join('\n')}`);
        if (!hasFlag(subArgs, '--yes') && !(await confirm('Revert these?'))) {
          fail('Nothing was changed. Pass --yes to confirm without a prompt.');
        }
        const done = await client.execute(sessionId, { command: 'revert_task', task: ref, confirmed: true, seen: preview.tasks.map((t) => t.taskId) });
        console.log(done.message);
      } catch (err) {
        console.error(`Failed to revert task: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}
