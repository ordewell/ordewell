import { describe, expect, it } from 'vitest';
import { daemonLabel } from '../DaemonBar';

describe('daemonLabel', () => {
  // A window waiting on the daemon this app is starting names that, not only "connecting" (F4).
  it('says the daemon is starting while this app starts its own, and connecting while it looks for one', () => {
    expect(daemonLabel({ state: 'connecting', port: 3742, starting: true })).toBe('Starting the daemon on :3742…');
    expect(daemonLabel({ state: 'connecting', port: 3742 })).toBe('Connecting to :3742…');
  });
});
