import type { StructuredEvent } from '../interfaces/IRunner';
import { sensitiveEnvValues } from './outboundSecrets';
import { hideHeld, hideHeldUpTo, redactAgentText } from '../utils/redactSecrets';

type Delta = Extract<StructuredEvent, { type: 'assistant_text_delta' | 'thinking_delta' }>;

/**
 * The secrets Ordewell itself handed one attempt's runner: the attempt's MCP
 * token, the credentials in the runner's spawn env, the headers it was given
 * (ADR-0061, H1). The session owns one for its whole life, respawns and all,
 * and every sink of the runner's text reads it: the session hides what it
 * holds in everything the runner says before any of it is cut or kept, and the
 * output source, the handoff and a stderr tail redact with it.
 *
 * Only what Ordewell holds can be hidden exactly. A secret it never held is
 * left to the name and shape rules of {@link redactAgentText}.
 */
export class HeldSecrets {
  private readonly values = new Set<string>();
  /** The end of the stream the last delta was in, not yet safe to show. */
  private pending: Delta | null = null;

  hold(...values: ReadonlyArray<string | undefined>): void {
    for (const value of values) if (value) this.values.add(value);
  }

  /** The credentials among a spawn env's variables, as {@link sensitiveEnvValues} names them. */
  holdEnv(env: Record<string, string | undefined>): void {
    this.hold(...sensitiveEnvValues(env));
  }

  /** Runner text with what is held hidden and every agent-text rule applied. */
  redact(text: string): string {
    return redactAgentText(text, this.values);
  }

  /** Only what is held hidden: for runner text kept as the runner wrote it, before anything cuts it. */
  hide(text: string): string {
    return hideHeld(text, this.values);
  }

  /** `value` with {@link hide} applied to every string in it, at any depth, its keys included. */
  hideIn<T>(value: T): T {
    if (this.values.size === 0) return value;
    // A copy of the same shape, strings hidden and nothing else changed, so it is still a T.
    return hideDeep(value, (text) => this.hide(text)) as T;
  }

  /**
   * `err` with what is held hidden in its message and stack, rewritten where
   * it is so its class still tells why it was thrown. A start that failed ends
   * with the last words of a runner or of its container, which can quote any
   * of what the runner was handed.
   */
  hideError(err: unknown): unknown {
    if (!(err instanceof Error) || this.values.size === 0) return typeof err === 'string' ? this.hide(err) : err;
    err.message = this.hide(err.message);
    if (err.stack) err.stack = this.hide(err.stack);
    return err;
  }

  /**
   * The events to show for `event`, in order, what is held hidden in each. A
   * held value streamed in deltas of a few characters has no part in any one
   * of them, so a delta's text is read on from the ones before it, and its end
   * is held back until what follows shows it holds no part of a value
   * (ADR-0061, H1). Any other event, or a delta of another stream, passes on
   * what was held back before itself, so nothing is reordered.
   */
  shownEvents(event: StructuredEvent): StructuredEvent[] {
    if (this.values.size === 0) return [event];
    const out = this.pending && !sameStream(this.pending, event) ? this.flush() : [];
    if (event.type !== 'assistant_text_delta' && event.type !== 'thinking_delta') return [...out, this.hideIn(event)];
    const { shown, rest } = hideHeldUpTo((this.pending?.text ?? '') + event.text, this.values);
    this.pending = rest ? { ...event, text: rest } : null;
    return shown ? [...out, { ...event, text: shown }] : out;
  }

  /**
   * One pipe's text in chunks, as {@link shownEvents} reads deltas: `write`
   * returns what is safe to show of a chunk read on from the ones before it,
   * and `end` the rest, once the pipe has no more (ADR-0061, H1). A pipe's
   * chunks split wherever its buffer fills, through a held value as readily
   * as anywhere else.
   */
  stream(): { write: (text: string) => string; end: (text?: string) => string } {
    let pending = '';
    return {
      write: (text) => {
        if (this.values.size === 0) return text;
        const { shown, rest } = hideHeldUpTo(pending + text, this.values);
        pending = rest;
        return shown;
      },
      end: (text = '') => {
        const last = this.hide(pending + text);
        pending = '';
        return last;
      },
    };
  }

  private flush(): StructuredEvent[] {
    const pending = this.pending;
    this.pending = null;
    return pending ? [{ ...pending, text: this.hide(pending.text) }] : [];
  }
}

function sameStream(delta: Delta, event: StructuredEvent): boolean {
  if (delta.type === 'assistant_text_delta') return event.type === delta.type && event.runId === delta.runId;
  return event.type === delta.type && event.subagentId === delta.subagentId;
}

function hideDeep(value: unknown, hide: (text: string) => string): unknown {
  if (typeof value === 'string') return hide(value);
  if (Array.isArray(value)) return value.map((item) => hideDeep(item, hide));
  if (value === null || typeof value !== 'object') return value;
  const proto: unknown = Object.getPrototypeOf(value);
  // An Error or a class instance is passed on as it is: rebuilding one would lose what makes it one.
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [hide(key), hideDeep(item, hide)]));
}
