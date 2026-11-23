import { describe, expect, it } from 'vitest';
import { daemonDetail, daemonLabel } from '../DaemonBar';

describe('daemonLabel', () => {
  // A window waiting on the daemon this app is starting names that, not only "connecting" (F4).
  it('says the daemon is starting while this app starts its own, and connecting while it looks for one', () => {
    expect(daemonLabel({ state: 'connecting', port: 3742, starting: true })).toBe('Starting the daemon on :3742…');
    expect(daemonLabel({ state: 'connecting', port: 3742 })).toBe('Connecting to :3742…');
  });

  it('names a connected daemon by its version and port alone, whoever started it', () => {
    expect(daemonLabel({ state: 'connected', port: 3742, owned: true, daemon: { version: '0.14.9', contract: 1 } })).toBe('Daemon v0.14.9 · :3742');
    expect(daemonLabel({ state: 'connected', port: 3742, owned: false, daemon: { version: '0.14.9', contract: 1 } })).toBe('Daemon v0.14.9 · :3742');
    expect(daemonLabel({ state: 'connected', port: 3742, owned: true, daemon: {} })).toBe('Daemon · :3742');
  });

  it('keeps the states that need the user in the label', () => {
    expect(daemonLabel({ state: 'reconnecting', port: 3742, attempt: 2, canStart: false })).toBe('Reconnecting to :3742…');
    expect(daemonLabel({ state: 'mismatch', port: 3742, daemon: { version: '0.12.3', contract: 4 }, app: { version: '0.13.0', contract: 5 } })).toBe('Version mismatch on :3742');
    expect(daemonLabel({ state: 'failed', port: 3742, message: 'Boom.', logPath: '/tmp/daemon.log' })).toBe('Daemon failed');
  });
});

describe('daemonDetail', () => {
  it('says who started a connected daemon, for the daemon item\'s detail', () => {
    expect(daemonDetail({ state: 'connected', port: 3742, owned: true, daemon: { version: '0.14.9', contract: 1 } }))
      .toBe('Daemon v0.14.9 on 127.0.0.1:3742, started by this app');
    expect(daemonDetail({ state: 'connected', port: 3742, owned: false, daemon: { version: '0.14.9', contract: 1 } }))
      .toBe('Daemon v0.14.9 on 127.0.0.1:3742, attached: started outside this app');
  });

  it('names both versions of a mismatch', () => {
    expect(daemonDetail({ state: 'mismatch', port: 3742, daemon: { version: '0.12.3', contract: 4 }, app: { version: '0.13.0', contract: 5 } }))
      .toBe('The daemon on :3742 is v0.12.3, contract 4; this app speaks v0.13.0, contract 5');
  });
});
