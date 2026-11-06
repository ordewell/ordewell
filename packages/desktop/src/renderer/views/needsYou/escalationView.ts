import type { Escalation } from '@ordewell/core';
import type { DaemonHost } from '../../session/DaemonHost';

/**
 * Where a wait is answered: an answer or a question in the task's chat, where
 * its own card is; a verdict, a failure or a merge gate on the task's card in
 * the plan list.
 */
export function showEscalatedTask(host: DaemonHost, taskId: string, kind: Escalation['kind'] | undefined): void {
  switch (kind) {
    case 'approval':
    case 'checkpoint':
    case 'input':
      host.openTask(taskId, 'chat');
      return;
    default:
      host.revealTask(taskId);
  }
}
