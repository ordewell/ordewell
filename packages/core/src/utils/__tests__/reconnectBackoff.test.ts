import { describe, expect, it } from 'vitest';
import { ReconnectBackoff } from '../reconnectBackoff';

describe('ReconnectBackoff', () => {
  it('waits briefly at first, doubling while the daemon stays away, up to a ceiling', () => {
    const backoff = new ReconnectBackoff();
    const waits = Array.from({ length: 7 }, () => backoff.next());

    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    expect(backoff.failed).toBe(7);
  });

  it('starts over once the socket is followed again', () => {
    const backoff = new ReconnectBackoff();
    backoff.next();
    backoff.next();
    backoff.reset();

    expect(backoff.failed).toBe(0);
    expect(backoff.next()).toBe(500);
  });
});
