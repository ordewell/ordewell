import type { DecisionRecordEntry, DecisionRecordKind } from '../models/Task';

/**
 * The planner's decision record (ADR-0067): what it decided and why, the
 * user's constraints in their own words, the options it rejected, and what is
 * still open. It is the part of a long conversation a checkpoint must not
 * paraphrase, so it is kept as entries the planner writes as it goes rather
 * than recovered from a summary afterwards.
 */

/** Past this many entries the planner supersedes rather than adds: the whole record rides every fresh context. */
export const RECORD_LIMIT = 150;

export interface DecisionRecordInput {
  kind: DecisionRecordKind;
  text: string;
  why?: string;
  supersedes?: string;
}

export interface RecordContext {
  /** The transcript index of the recording turn's user message. */
  at: number;
  timestamp: string;
  /** Every user message so far, the open turn's included: a constraint must quote one. */
  userWords: readonly string[];
  /** Applied to what is kept, after the constraint check has read the raw words (ADR-0061 P1). */
  redact: (text: string) => string;
}

export type RecordResult =
  | { ok: true; record: DecisionRecordEntry[]; added: DecisionRecordEntry[] }
  | { ok: false; errors: string[] };

const LETTER: Record<DecisionRecordKind, string> = { decision: 'D', constraint: 'C', rejected: 'R', question: 'Q' };
const NEEDS_WHY: Partial<Record<DecisionRecordKind, string>> = { decision: 'a decision', rejected: 'a rejection' };

const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();
const unquoted = (text: string) => text.replace(/^["'“‘](.*)["'”’]$/s, '$1').trim();

/** Adds a batch whole or not at all, so a refusal leaves nothing half-recorded for the planner to reconcile. */
export function addToRecord(record: readonly DecisionRecordEntry[], inputs: readonly DecisionRecordInput[], context: RecordContext): RecordResult {
  // A superseding entry replaces a live one, so it adds nothing net; counting it (or the superseded) would freeze a full record, where superseding is the way out.
  if (live(record).length + inputs.filter((input) => input.supersedes === undefined).length > RECORD_LIMIT) {
    return { ok: false, errors: [`The record holds its limit of ${RECORD_LIMIT} live entries: supersede what no longer stands rather than add to it.`] };
  }
  const heard = context.userWords.map(squeeze);
  const next = [...record];
  const added: DecisionRecordEntry[] = [];
  const errors: string[] = [];
  inputs.forEach((input, index) => {
    const fail = (message: string) => errors.push(`Entry ${index + 1}: ${message}`);
    const text = input.kind === 'constraint' ? unquoted(input.text.trim()) : input.text.trim();
    const why = input.why?.trim() || undefined;
    if (!text) return fail('the text is empty.');
    const needs = NEEDS_WHY[input.kind];
    if (needs && !why) return fail(`${needs} needs its why.`);
    if (input.supersedes !== undefined && !live(next).some((entry) => entry.id === input.supersedes)) {
      return fail(`there is no live entry ${input.supersedes} to supersede.`);
    }
    if (input.kind === 'constraint' && !heard.some((words) => words.includes(squeeze(text)))) {
      return fail(`a constraint is the user's words, verbatim: "${text}" is not in any of their messages. Quote them, or record a decision.`);
    }
    const entry: DecisionRecordEntry = {
      id: `${LETTER[input.kind]}${next.filter((kept) => kept.kind === input.kind).length + 1}`,
      kind: input.kind,
      text: context.redact(text),
      ...(why ? { why: context.redact(why) } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      at: context.at,
      timestamp: context.timestamp,
    };
    next.push(entry);
    added.push(entry);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, record: next, added };
}

/** The entries no later entry supersedes. */
export function live(record: readonly DecisionRecordEntry[]): DecisionRecordEntry[] {
  const superseded = new Set(record.flatMap((entry) => (entry.supersedes ? [entry.supersedes] : [])));
  return record.filter((entry) => !superseded.has(entry.id));
}

/** The record as it stood before transcript entry `index`, for a rewind or a fork cut there. */
export function recordBefore(record: readonly DecisionRecordEntry[], index: number): DecisionRecordEntry[] {
  return record.filter((entry) => entry.at < index);
}

const SECTIONS: ReadonlyArray<[DecisionRecordKind, string]> = [
  ['decision', 'Decisions:'],
  ['constraint', "Constraints, in the user's words:"],
  ['rejected', 'Rejected:'],
  ['question', 'Open questions:'],
];

const sentence = (text: string) => (/[.!?:;"]$/.test(text) ? text : `${text}.`);

function body(entry: DecisionRecordEntry): string {
  const text = entry.kind === 'constraint' ? `"${entry.text}"` : entry.text;
  return entry.why ? `${sentence(text)} Why: ${entry.why}` : text;
}

/** What stands, grouped by kind; null for a record with nothing standing. */
export function recordBlock(record: readonly DecisionRecordEntry[]): string | null {
  const standing = live(record);
  if (standing.length === 0) return null;
  const lines = SECTIONS.flatMap(([kind, heading]) => {
    const entries = standing.filter((entry) => entry.kind === kind);
    return entries.length === 0 ? [] : [heading, ...entries.map((entry) => `- ${entry.id}: ${body(entry)}`)];
  });
  return ['<decision_record>', ...lines, '</decision_record>'].join('\n');
}

/** The entries past the `told` the planner already holds, each naming what it supersedes; null when there are none. */
export function recordChanges(record: readonly DecisionRecordEntry[], told: number): string | null {
  const added = record.slice(told);
  if (added.length === 0) return null;
  const lines = added.map((entry) => `- ${entry.kind} ${entry.id}: ${body(entry)}${entry.supersedes ? ` (supersedes ${entry.supersedes})` : ''}`);
  return ['<decision_record_changes>', ...lines, '</decision_record_changes>'].join('\n');
}
