import type { Escalation } from '@ordewell/core';

/**
 * The task tab section a wait belongs in: an answer or a question is in Chat,
 * where its own card is; a verdict, a failure or a merge gate is in Details.
 */
export function taskViewFor(kind: Escalation['kind']): 'chat' | 'details' {
  switch (kind) {
    case 'approval':
    case 'checkpoint':
    case 'input':
      return 'chat';
    default:
      return 'details';
  }
}
