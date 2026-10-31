import { describe, expect, it } from 'vitest';
import { connectorFor } from '../connectors';

describe('the prompt cache a connector states (ADR-0057 R4)', () => {
  it.each(['claude-code', 'codex'])('%s states the shortest it may last, which a wake can count on', (runner) => {
    expect(connectorFor(runner)?.promptCacheTtlMs).toBe(5 * 60_000);
  });

  it('opencode states none: its cache is its provider\'s', () => {
    expect(connectorFor('opencode')?.promptCacheTtlMs).toBeUndefined();
  });
});
