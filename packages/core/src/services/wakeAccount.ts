import type { ExecutionRecord } from '../models/Execution';
import type { ConversationMessage } from '../models/Task';
import { cut } from './WakePolicy';

/** What an edit landed in a turn says first, which is how its entry is told from the turn's prose. */
export const TASKS_UPDATED = 'Tasks updated:';

/** How many acts of each outcome the account names before it counts the rest: it is one line, however busy the turn. */
const NAMED_ACTS = 4;

/** The most the account takes, which a wake keeps free within its cap (ADR-0057 R5). */
export const WAKE_ACCOUNT_CHARS = 400;

const LEAD = 'Ordewell\'s record of your last wake-up turn:';

/**
 * Ordewell's own account of what the last wake-up turn executed, for the next
 * one (ADR-0057 R5), read from the transcript so a reload keeps it: the calls
 * the command seam recorded for a planner, and the edits that landed. A model
 * that wrote its call as text, or never made it, otherwise takes its own
 * words for the act: a recorded supervisor told the user it had sent two
 * timeboxes it never sent, then explained their silence as the runner's.
 * Undefined before any wake-up turn.
 */
export function lastWakeAccount(history: readonly ConversationMessage[]): string | undefined {
  let at = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === 'wake_up') {
      at = i;
      break;
    }
  }
  if (at < 0) return undefined;
  const done: string[] = [];
  const refused: string[] = [];
  for (const entry of history.slice(at + 1)) {
    // A person's message ends that turn: what follows is the user's turn, not the wake-up's.
    if (entry.role === 'user') break;
    const record = entry.execution;
    if (entry.kind === 'execution' && record && record.actor !== 'user' && record.actor !== 'autorun') {
      (record.outcome === 'done' ? done : refused).push(act(record));
    } else if (entry.role === 'assistant' && entry.content.startsWith(TASKS_UPDATED)) {
      done.push('edit_plan');
    } else if (entry.kind === 'plan_generated') {
      done.push('a new plan');
    }
  }
  if (done.length === 0 && refused.length === 0) return `${LEAD} it executed no call on the run. A call you only wrote out or described was not made.`;
  const executed = done.length > 0 ? `it executed ${named(done)}` : 'it executed no call on the run';
  const notDone = refused.length > 0 ? `; refused or declined: ${named(refused)}` : '';
  return cut(`${LEAD} ${executed}${notDone}. A call not listed was not made.`, WAKE_ACCOUNT_CHARS);
}

function act(record: ExecutionRecord): string {
  return record.task ? `${record.command} ${record.task.ref}` : record.command;
}

function named(acts: readonly string[]): string {
  const shown = acts.slice(0, NAMED_ACTS);
  const more = acts.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}
