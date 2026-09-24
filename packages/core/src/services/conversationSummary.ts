import type { ConversationMessage } from '../models/Task';

/**
 * User messages a compaction keeps verbatim, with the replies that follow
 * them. Two is enough for the planner to pick up mid-thought; the summary
 * carries everything before.
 */
export const KEPT_USER_MESSAGES = 2;

const SUMMARY_OPEN = '<conversation_summary>';
const SUMMARY_CLOSE = '</conversation_summary>';

/**
 * The hidden turn that asks the planner to condense its own conversation.
 * The tags are the contract, not decoration: a harness planner reports a
 * failure as an ordinary reply, so a reply without them is how a dead agent
 * is told apart from a summary before it can replace the transcript.
 */
export function summaryRequest(planLines: readonly string[] | null): string {
  return [
    'The user asked to condense this planning conversation. Write a summary that will replace everything said so far, so the conversation can carry on from it alone.',
    'Keep: the goal, the decisions made, the constraints, the open questions, the key file and code findings, and where the plan stands now.',
    'Reply in plain prose. Do not emit task operations, plan JSON or task reads, and do not run tools — the tasks are not changing in this turn.',
    `Put the summary between ${SUMMARY_OPEN} and ${SUMMARY_CLOSE}, and nothing outside the tags.`,
    ...(planLines ? ['<current_plan>', ...planLines, '</current_plan>'] : []),
  ].join('\n');
}

/** The last tagged block wins: a model may name the tag while introducing it. */
export function extractSummary(reply: string): string | null {
  const matches = [...reply.matchAll(new RegExp(`${SUMMARY_OPEN}([\\s\\S]*?)${SUMMARY_CLOSE}`, 'g'))];
  const summary = matches.at(-1)?.[1].trim();
  return summary || null;
}

/**
 * What the transcript's first entry — and the notice sent with it — says. It
 * is replayed to the model like any assistant message, so it tells the model
 * what the entry is as well as the user.
 */
export function condensedNotice(summary: string): string {
  return [
    'Conversation condensed: the earlier messages were replaced by the summary below, and the last two exchanges were kept as they were. The task list is unchanged.',
    '',
    summary,
  ].join('\n');
}

/**
 * The part of the transcript a compaction keeps as it is — from the
 * second-to-last user message on, replies included — or null when there is
 * nothing before it worth condensing.
 */
export function keptTail(transcript: readonly ConversationMessage[]): ConversationMessage[] | null {
  const userAt = transcript.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  if (userAt.length <= KEPT_USER_MESSAGES) return null;
  return transcript.slice(userAt[userAt.length - KEPT_USER_MESSAGES]);
}
