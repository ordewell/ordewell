import { describe, expect, it } from 'vitest';
import { DAEMON_CONTRACT, type DaemonProbe } from '@ordewell/core/daemon-client';
import { decideAttach, type Holding } from '../attachPlan';

const daemon = (contract?: number, version = '0.12.3'): DaemonProbe => ({
  kind: 'daemon',
  identity: { pid: 1, version, ...(contract !== undefined ? { contract } : {}) },
});

describe('decideAttach (ADR-0063 H2, H3)', () => {
  it.each<[Holding, string]>([['none', 'own'], ['owned', 'own'], ['attached', 'reconnect']])(
    'a free port while holding %s → %s',
    (holding, action) => {
      expect(decideAttach({ kind: 'unreachable' }, 1, holding)).toEqual({ action });
    },
  );

  it('attaches on the same contract and carries the version for the status bar', () => {
    expect(decideAttach(daemon(1, '0.12.9'), 1, 'none')).toEqual({ action: 'attach', contract: 1, version: '0.12.9' });
  });

  it('shows a mismatch on another contract, restarting only a daemon it owns', () => {
    expect(decideAttach(daemon(2), 1, 'none')).toEqual({ action: 'mismatch', contract: 2, version: '0.12.3', restart: false });
    expect(decideAttach(daemon(2), 1, 'attached')).toMatchObject({ restart: false });
    expect(decideAttach(daemon(2), 1, 'owned')).toMatchObject({ restart: true });
  });

  it('shows a mismatch for a daemon that names no contract', () => {
    expect(decideAttach(daemon(undefined, '0.11.0'), 1, 'none')).toEqual({ action: 'mismatch', version: '0.11.0', restart: false });
  });

  it('reports an unauthorized daemon and whether a token was presented', () => {
    expect(decideAttach({ kind: 'unauthorized', tokenPresented: false }, 1, 'none')).toEqual({ action: 'unauthorized', tokenPresented: false });
  });

  it('reports a port held by something that cannot name itself', () => {
    expect(decideAttach({ kind: 'unverifiable' }, 1, 'none')).toEqual({ action: 'port-taken' });
  });
});

/**
 * Builds of 0.13.1 from before the Explorer read the workspace folder itself
 * answer contract 2, and their reader refuses repo "." in a folder that is not
 * a repository (`No repository "." in this workspace`). The version they report
 * is this app's own, so only the contract can tell them apart.
 */
describe('decideAttach with this build\'s contract, against a daemon from before workspace-folder reads', () => {
  const before = daemon(2, '0.13.1');

  it('does not attach it, whether the app held nothing or had attached to it', () => {
    expect(DAEMON_CONTRACT).toBeGreaterThan(2);
    for (const holding of ['none', 'attached'] as const) {
      expect(decideAttach(before, DAEMON_CONTRACT, holding)).toEqual({ action: 'mismatch', contract: 2, version: '0.13.1', restart: false });
    }
  });

  it('restarts it only when it is the app\'s own child: a stale bundled build', () => {
    expect(decideAttach(before, DAEMON_CONTRACT, 'owned')).toEqual({ action: 'mismatch', contract: 2, version: '0.13.1', restart: true });
  });

  it('attaches a daemon of this build, at the same reported version', () => {
    expect(decideAttach(daemon(DAEMON_CONTRACT, '0.13.1'), DAEMON_CONTRACT, 'none')).toEqual({ action: 'attach', contract: DAEMON_CONTRACT, version: '0.13.1' });
  });
});
