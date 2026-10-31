import type { HandoffCommit } from '../models/Handoff';

/**
 * The commits Ordewell itself writes for a task (ADR-0013): its leftover
 * `work`, the `merge` that lands it, the `repair-merge` that brings the
 * integration tip into its branch when a landing conflicted (ADR-0015), the
 * `rescue` of edits a removal would otherwise delete, and the `restore-merge`
 * that brings that kept work back into a continued task's branch. The last
 * two land with the task's branch, so they read like the rest. A commit the
 * runner made is never rewritten, so it is not one of these.
 */
export type LandingCommit = 'work' | 'merge' | 'repair-merge' | 'rescue' | 'restore-merge';

/** What a landing message is written from: the task's title, and the commit its done handoff stated, if any. */
export interface LandingSubject {
  title: string;
  commit?: HandoffCommit;
}

/** The line that says a commit was planned by Ordewell, in git's trailer form (`git interpret-trailers --parse` reads it). */
export const PLANNED_WITH_TRAILER = 'Planned-with: Ordewell';

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s+\S/;

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim();
}

/**
 * The whole message of a commit Ordewell writes for a task: the stated
 * subject, or the task title when none was stated, then the stated body
 * after a blank line. A repair or restore merge carries no body: the body
 * describes the task's work, which the landing merge after it carries. With
 * `plannedWith` the {@link PLANNED_WITH_TRAILER} closes it; the caller reads
 * the user's setting as it writes (ADR-0030). The one place a landing's
 * message text is decided.
 */
export function landingMessage(kind: LandingCommit, from: LandingSubject, plannedWith = false): string {
  const subject = firstLine(from.commit?.subject ?? '') || firstLine(from.title);
  const head = kind === 'work' ? subject
    : kind === 'merge' ? `Merge: ${subject}`
    : kind === 'rescue' ? `WIP: ${subject}`
    : kind === 'restore-merge' ? `Merge: ${subject} (resume its kept work)`
    : `Merge: ${subject} (resolve conflicts with integration)`;
  const body = kind === 'rescue' ? RESCUE_BODY
    : kind === 'repair-merge' || kind === 'restore-merge' ? ''
    : from.commit?.body?.trim() ?? '';
  return finish(body ? `${head}\n\n${body}` : head, body, plannedWith);
}

const RESCUE_BODY = 'Work left uncommitted when its worktree was removed, kept so that nothing is lost.';

/**
 * The message of the commit that reverts a task's landing `merge` (ADR-0054),
 * in place of git's `Revert "Merge: …"`. Its body is not the task's: that
 * describes the work this commit removes.
 */
export function revertMessage(from: LandingSubject, merge: string, plannedWith = false): string {
  const subject = firstLine(from.commit?.subject ?? '') || firstLine(from.title);
  const body = revertsMerge(merge);
  return finish(`Revert: ${subject}\n\n${body}`, body, plannedWith);
}

/** The sentence of a {@link revertMessage} that names its merge: all a crash leaves to tell an unsaved revert commit by. */
export function revertsMerge(merge: string): string {
  return `This reverts the merge ${merge}, which landed it.`;
}

/**
 * The message of Merge all's merge into the user's branch, from the tasks it
 * brings there in plan order: the one task's subject, or the first's with a
 * line per task below. Never git's default, which names the integration branch.
 */
export function runMergeMessage(landed: LandingSubject[], plannedWith = false): string {
  const subjects = landed.map((from) => firstLine(from.commit?.subject ?? '') || firstLine(from.title)).filter(Boolean);
  if (subjects.length === 0) return finish('Merge planned changes', '', plannedWith);
  const head = subjects.length === 1 ? `Merge: ${subjects[0]}` : `Merge: ${subjects[0]} and ${subjects.length - 1} more`;
  const body = subjects.length === 1 ? '' : subjects.map((subject) => `- ${subject}`).join('\n');
  return finish(body ? `${head}\n\n${body}` : head, body, plannedWith);
}

function finish(text: string, body: string, plannedWith: boolean): string {
  return plannedWith ? withTrailer(text, body) : text;
}

/**
 * git reads trailers from the last paragraph only, so a body that already ends
 * in a trailer block after its prose takes ours on the next line of it; any
 * other message gets a paragraph of its own. A body of one paragraph is prose
 * however it reads, as the stored handoff keeps it (ADR-0047).
 */
function withTrailer(text: string, body: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.includes(PLANNED_WITH_TRAILER)) return text;
  const paragraphs = body ? body.split(/\r?\n\s*\n/) : [];
  const lastParagraph = paragraphs.length > 1 ? paragraphs.at(-1)!.split(/\r?\n/) : [];
  const endsInTrailers = lastParagraph.length > 0 && lastParagraph.every((line) => TRAILER_LINE.test(line));
  return `${text}${endsInTrailers ? '\n' : '\n\n'}${PLANNED_WITH_TRAILER}`;
}

/**
 * A message as `git commit`/`git merge` arguments: one `-m` per paragraph,
 * which git joins with a blank line, so a multi-line message never needs a
 * shell or a temporary file.
 */
export function messageArgs(message: string): string[] {
  return message.split(/\r?\n\s*\n/).map((p) => p.trim()).filter(Boolean).flatMap((p) => ['-m', p]);
}

/**
 * {@link messageArgs} as a POSIX shell would read them, for a command a
 * runner is asked to type: each paragraph single-quoted, its own quotes closed
 * around an escaped one.
 */
export function quotedMessageArgs(message: string): string {
  const args = messageArgs(message);
  return args.map((arg, i) => (i % 2 === 0 ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}
