import { describe, expect, it } from 'vitest';
import { daemonHostKind } from '../daemon';

/** What the daemon's lease names its host as (ADR-0049), from the arguments it was started with. */
describe('daemonHostKind', () => {
  it('names the TUI a private daemon watches', () => {
    expect(daemonHostKind(['--port', '4100', '--watch-parent', '77'], 4100)).toEqual({ kind: 'daemon', port: 4100, ownerPid: 77 });
  });

  it('marks the daemon the desktop app forked', () => {
    expect(daemonHostKind(['--port', '4100', '--desktop-app'], 4100)).toEqual({ kind: 'daemon', port: 4100, app: 'desktop' });
  });

  it('names a plain daemon by its port alone', () => {
    expect(daemonHostKind(['--port', '4100'], 4100)).toEqual({ kind: 'daemon', port: 4100 });
  });
});
