import type { ModelToolCall } from '../types';

/**
 * Whether a call in a reply stopped at the output limit came through whole.
 * The limit can fall inside a call's arguments, and a provider may still close
 * the call, so only arguments that parse as an object count: anything less was
 * cut short and is never completed, nor run (ADR-0070).
 */
export function cameThroughWhole(call: ModelToolCall): boolean {
  return call.argumentsError === undefined && call.rawArguments.trim() !== '';
}
