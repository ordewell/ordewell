import type { ModelToolCall } from '../../model';

/** The identical call in a row whose result carries a nudge. */
export const REPEAT_NUDGE_AT = 3;
/** The identical call in a row that is not run and ends the attempt as failed. */
export const REPEAT_FAIL_AT = 4;

/** How much of a repeated call's arguments its failure quotes. */
const QUOTED_ARGS = 300;

/**
 * Counts how many times in a row the model has made the same call with the
 * same arguments. A model that keeps doing that is stuck, so the third such
 * call is nudged and the fourth ends the attempt (ADR-0070): a loop the model
 * cannot see itself in only spends the step limit. Arguments are compared by
 * value, so key order does not tell two calls apart.
 */
export class RepeatGuard {
  private last = '';
  private count = 0;

  /** How many times in a row this call has now been made, itself included. */
  see(call: ModelToolCall): number {
    const signature = `${call.name}\u0000${canonical(call.arguments)}`;
    this.count = signature === this.last ? this.count + 1 : 1;
    this.last = signature;
    return this.count;
  }
}

export function repeatNudge(call: ModelToolCall): string {
  return `\n\n[Ordewell] This is the third ${call.name} call in a row with the same arguments. Repeating it will not change what it returns: try another approach. A fourth identical call ends the attempt as failed.`;
}

/** The reason an attempt ended on a repeated call, naming the call and its arguments. */
export function repeatFailure(call: ModelToolCall): string {
  const args = canonical(call.arguments);
  const quoted = args.length > QUOTED_ARGS ? `${args.slice(0, QUOTED_ARGS)}…` : args;
  return `The model called ${call.name} with identical arguments ${REPEAT_FAIL_AT} times in a row (${quoted}), so the built-in runner stopped the attempt.`;
}

function canonical(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? 'undefined';
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sorted((value as Record<string, unknown>)[key]);
  return out;
}
