import type { PromptPartKind, PromptPartSpan } from '../models/PromptPart';
import type { MessageSection, MessageSectionGroup } from './blocks';

/**
 * How a task's first message is shown: the brief, and around it what Ordewell
 * added, in two groups. Fixed here so that every surface folds the same way;
 * within a group a section's place is its kind's, not where the runner read it.
 */
const GROUPS: ReadonlyArray<{ title: string; kinds: readonly PromptPartKind[] }> = [
  { title: 'Handoffs from earlier tasks', kinds: ['priorOutputs', 'sinceLastRound', 'previousAttempt', 'carriedOver'] },
  // The unattended note and the checkpoint instruction exclusive: either opens the group.
  { title: 'Ordewell\'s instructions to the runner', kinds: ['unattended', 'checkpoint', 'skills', 'readOnly', 'landingBeside', 'loopCheck', 'boardPins'] },
];

const INSTRUCTIONS = GROUPS.length - 1;

function groupOf(kind: PromptPartKind): number {
  const i = GROUPS.findIndex((g) => g.kinds.includes(kind));
  // A kind a newer Ordewell added is still something it told the runner.
  return i === -1 ? INSTRUCTIONS : i;
}

function rankOf(kind: PromptPartKind): number {
  const rank = GROUPS[groupOf(kind)].kinds.indexOf(kind);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * The brief's span, when the spans fit the message: each within it, in order,
 * one of them the brief. A log may hold spans from a file this build did not write.
 */
function briefOf(message: string, spans: readonly PromptPartSpan[]): PromptPartSpan | null {
  let at = 0;
  for (const { start, end } of spans) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < at || end < start || end > message.length) return null;
    at = end;
  }
  const briefs = spans.filter((s) => s.kind === 'brief');
  return briefs.length === 1 ? briefs[0] : null;
}

/** A section's own heading repeats its title, which a surface draws already. */
function body(text: string, title: string): string {
  const heading = `## ${title}\n`;
  return text.startsWith(heading) ? text.slice(heading.length).replace(/^\n+/, '') : text;
}

/**
 * The text and sections of a first message whose parts were logged: the
 * brief, after the retry note that says what this attempt does differently,
 * and the rest folded. Null when the spans do not fit the message, which is
 * then shown whole, as a log without parts is.
 */
export function firstMessageView(message: string, spans: readonly PromptPartSpan[]): { text: string; sections?: MessageSectionGroup[] } | null {
  const brief = briefOf(message, spans);
  if (!brief) return null;
  const slice = ({ start, end }: PromptPartSpan) => message.slice(start, end);
  const note = spans.find((s) => s.kind === 'retryNote');
  const text = note ? `${slice(note)}\n\n${slice(brief)}` : slice(brief);
  const folded = spans
    .filter((s) => s.kind !== 'brief' && s.kind !== 'retryNote')
    .map((s, at) => ({ span: s, at }))
    .sort((a, b) => rankOf(a.span.kind) - rankOf(b.span.kind) || a.at - b.at);
  const sections = GROUPS.map((group, i): MessageSectionGroup => ({
    title: group.title,
    sections: folded.filter(({ span }) => groupOf(span.kind) === i)
      .map(({ span }): MessageSection => ({ kind: span.kind, title: span.title, text: body(slice(span), span.title) })),
  })).filter((g) => g.sections.length > 0);
  return sections.length > 0 ? { text, sections } : { text };
}
