import { isUserMessage, type ContextCheckpoint, type ConversationMessage } from '../models/Task';

/**
 * User messages a compaction keeps verbatim, with the replies that follow
 * them. Two is enough for the planner to pick up mid-thought; the summary
 * carries everything before.
 */
export const KEPT_USER_MESSAGES = 2;

const SUMMARY_OPEN = '<conversation_summary>';
const SUMMARY_CLOSE = '</conversation_summary>';

/**
 * What a summary of the conversation keeps, for an API planner's summary call
 * and a harness planner's summary turn alike: one source, so neither falls
 * behind the other.
 */
export const HISTORY_KEEPS = 'Keep: the user\'s goal; every instruction, constraint and preference still standing, with any skill loaded into the conversation by name and what it requires; the decisions made and why; open questions and what the planner was waiting on; the findings; and what the planner said it did or would do.';

/** What every summary keeps, of the history or of a turn. */
export const SUMMARY_KEEPS: readonly string[] = [
  'Keep exactly, as the conversation has them: file paths, symbols, line references, commands and their outcomes, URLs, task references and quoted requirements.',
  'Task statuses and run state are not yours to keep: the current plan is authoritative, and what the conversation says about task state may be stale.',
  // A summary is replayed into every later context and may be copied into a
  // brief, so a value in it multiplies; the rule about it is what is needed
  // (ADR-0061 P1). Ordewell redacts what it can recognise either way.
  'Never copy a secret\'s value — an API key, token or password, pasted or read — into the summary: keep the rule about it, naming the secret without its value (the key goes only into task environments, never into a brief).',
];

export const SUMMARY_TAGS = `Put the summary between ${SUMMARY_OPEN} and ${SUMMARY_CLOSE}, and nothing outside the tags.`;

export function currentPlanBlock(planLines: readonly string[] | null): string[] {
  return planLines && planLines.length > 0 ? ['<current_plan>', ...planLines, '</current_plan>'] : [];
}

/**
 * The hidden turn that asks the planner to condense its own conversation.
 * The tags are the contract, not decoration: a harness planner reports a
 * failure as an ordinary reply, so a reply without them is how a dead agent
 * is told apart from a summary before it can replace the transcript.
 */
export function summaryRequest(planLines: readonly string[] | null): string {
  return [
    'The user asked to condense this planning conversation. Write a summary that will replace everything said so far, so the conversation can carry on from it alone.',
    HISTORY_KEEPS,
    ...SUMMARY_KEEPS,
    'Reply in plain prose or short lists. Do not emit task operations, plan JSON or task reads, and do not run tools — the tasks are not changing in this turn.',
    SUMMARY_TAGS,
    ...currentPlanBlock(planLines),
  ].join('\n');
}

/** The last tagged block wins: a model may name the tag while introducing it. */
export function extractSummary(reply: string): string | null {
  const matches = [...reply.matchAll(new RegExp(`${SUMMARY_OPEN}([\\s\\S]*?)${SUMMARY_CLOSE}`, 'g'))];
  const summary = matches.at(-1)?.[1].trim();
  return summary || null;
}

/**
 * What a compaction entry — and the notice sent with it — says. It is
 * replayed to the model like any assistant message, so it tells the model
 * what the entry is as well as the user.
 */
export function condensedNotice(summary: string, trigger: ContextCheckpoint['trigger'] = 'manual'): string {
  return [
    trigger === 'manual'
      ? 'Conversation condensed: the summary below stands in for the earlier messages from here on, and the last two exchanges were kept as they were. The full conversation stays in the history. The task list is unchanged.'
      : 'Conversation condensed automatically to fit the model\'s context: the summary below stands in for the earlier messages from here on, and the most recent exchanges that fit were kept as they were. The full conversation stays in the history. Task and run state are the current plan\'s, not this summary\'s.',
    '',
    summary,
  ].join('\n');
}

/** A saved or received checkpoint as it must be to be trusted: anything else is read as a plain marker. */
export function isCheckpoint(value: unknown): value is ContextCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const { id, keptFrom, trigger } = value as Record<string, unknown>;
  return typeof id === 'string' && id !== '' && Number.isInteger(keptFrom) && (trigger === 'manual' || trigger === 'auto');
}

/**
 * The newest compaction entry that is a checkpoint, and where the context it
 * heads resumes verbatim. Read from whatever was saved, so each one is checked
 * against where it stands: its cut at or before itself and no earlier than
 * the one before it. One that fails is passed over, replaying more than it
 * would have — never hiding what it claimed to summarise.
 */
function newestCheckpoint(transcript: readonly ConversationMessage[]): { at: number; keptFrom: number } | null {
  let newest: { at: number; keptFrom: number } | null = null;
  for (const [at, entry] of transcript.entries()) {
    if (entry.kind !== 'compaction') continue;
    // A legacy compaction replaced what it condensed, so only it ever stood first.
    if (at === 0) newest = { at, keptFrom: 1 };
    else if (isCheckpoint(entry.checkpoint) && entry.checkpoint.keptFrom >= (newest?.keptFrom ?? 0) && entry.checkpoint.keptFrom <= at) {
      newest = { at, keptFrom: entry.checkpoint.keptFrom };
    }
  }
  return newest;
}

/**
 * The transcript as the planner's context holds it: the newest checkpoint's
 * summary, then every entry from its cut on, without other compaction
 * entries — the summaries it superseded and markers that were never
 * checkpoints. The whole transcript stays what surfaces draw and forks
 * copy; this alone is replayed or condensed.
 */
export function modelContext(transcript: readonly ConversationMessage[]): ConversationMessage[] {
  const checkpoint = newestCheckpoint(transcript);
  const verbatim = (checkpoint ? transcript.slice(checkpoint.keptFrom) : transcript).filter((m) => m.kind !== 'compaction');
  return checkpoint ? [transcript[checkpoint.at], ...verbatim] : verbatim;
}

/** Where the planner's context resumes verbatim: no new checkpoint may cut before it. */
export function contextFloor(transcript: readonly ConversationMessage[]): number {
  return newestCheckpoint(transcript)?.keptFrom ?? 0;
}

/**
 * Where a compaction would cut the transcript, as an index into it — the
 * second-to-last user message the planner's context holds verbatim — or null
 * when the context holds nothing before it worth condensing.
 */
export function compactionCut(transcript: readonly ConversationMessage[]): number | null {
  const floor = contextFloor(transcript);
  const userAt = transcript.flatMap((m, i) => (i >= floor && isUserMessage(m) ? [i] : []));
  if (userAt.length <= KEPT_USER_MESSAGES) return null;
  return userAt[userAt.length - KEPT_USER_MESSAGES];
}
