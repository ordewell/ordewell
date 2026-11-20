/**
 * One piece of a task's first message, as Ordewell composed it. The runner is
 * sent the pieces joined, one string; the log keeps where each sits in it, so
 * a surface can show the brief first and fold the rest.
 *
 * - `unattended`: what a task nobody watches is told of `checkpoint`.
 * - `sinceLastRound`: a loop's check, from its second round on.
 * - `priorOutputs`: its dependencies' handoffs.
 * - `previousAttempt`: an ops task's last attempt.
 * - `carriedOver`: work a usage-limit pause moved from another runner.
 * - `skills`: the task's skills.
 * - `readOnly`: the notes a read-only task is given.
 * - `landingBeside`: where work landing beside a change is taken in from.
 * - `retryNote`: the planner's or supervisor's note for this attempt.
 * - `checkpoint`: how an attended task asks a person.
 * - `loopCheck`: what a loop's check's status means.
 * - `brief`: the task's own prompt, or what its repair is asked to do.
 * - `boardPins`: the pins of the board the task posts to.
 */
export type PromptPartKind =
  | 'unattended' | 'sinceLastRound' | 'priorOutputs' | 'previousAttempt' | 'carriedOver' | 'skills' | 'readOnly'
  | 'landingBeside' | 'retryNote' | 'checkpoint' | 'loopCheck' | 'brief' | 'boardPins';

export interface PromptPart {
  kind: PromptPartKind;
  /** The part's heading without its `##`, or a fixed name for a part that has none. */
  title: string;
  text: string;
}

/**
 * Where a part sits in the message it was sent in: `message.slice(start, end)`
 * is its text. The blank line joining two parts is in neither span.
 */
export interface PromptPartSpan {
  kind: PromptPartKind;
  title: string;
  start: number;
  end: number;
}

const JOIN = '\n\n';

export function joinPromptParts(parts: readonly PromptPart[]): string {
  return parts.map((p) => p.text).join(JOIN);
}

/**
 * The spans of `parts` in `message`, or none when the parts do not join to
 * it: a runner that sent something else than it was given is not told apart
 * by a guess.
 */
export function promptPartSpans(message: string, parts: readonly PromptPart[]): PromptPartSpan[] | undefined {
  if (parts.length === 0 || joinPromptParts(parts) !== message) return undefined;
  const spans: PromptPartSpan[] = [];
  let start = 0;
  for (const { kind, title, text } of parts) {
    spans.push({ kind, title, start, end: start + text.length });
    start += text.length + JOIN.length;
  }
  return spans;
}
