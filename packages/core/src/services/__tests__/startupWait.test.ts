import { describe, expect, it } from 'vitest';
import { DAEMON_STILL_WAITING_MS, daemonStillWaitingLine, daemonWaitLine } from '../startupWait';

describe('the startup wait, in the words every surface uses', () => {
  it('names the daemon a window waits for', () => {
    expect(daemonWaitLine(3742, true)).toBe("Starting Ordewell's daemon on port 3742…");
    expect(daemonWaitLine(3742, false)).toBe("Connecting to Ordewell's daemon on port 3742…");
  });

  // The terminal has printed this line since before the desktop app said it too: it must not change.
  it('says where the log is once a start has waited about five seconds', () => {
    expect(DAEMON_STILL_WAITING_MS).toBe(5_000);
    expect(daemonStillWaitingLine(5125, '/home/me/.ordewell/server.log'))
      .toBe('Still waiting for the daemon on port 5125 to answer. Its log: /home/me/.ordewell/server.log');
  });
});
