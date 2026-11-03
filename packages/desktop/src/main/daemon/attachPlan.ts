import type { DaemonProbe } from '@ordewell/core/daemon-client';

/** What this app held before the probe: nothing yet, a daemon it attached to, or one it started. */
export type Holding = 'none' | 'attached' | 'owned';

export type AttachDecision =
  | { action: 'attach'; version?: string; contract: number }
  /** The port is free and the app may take it: start the bundled daemon and own it. */
  | { action: 'own' }
  /**
   * The attached daemon went away. The app keeps probing and offers to start
   * one, but does not take the port by itself: the user's daemon may be
   * restarting, and a second owner would race it.
   */
  | { action: 'reconnect' }
  /** A daemon speaking another contract, or none; `restart` when the app owns it. */
  | { action: 'mismatch'; version?: string; contract?: number; restart: boolean }
  | { action: 'unauthorized'; tokenPresented: boolean }
  | { action: 'port-taken' };

/**
 * ADR-0060 H2 and H3 as one table: what to do with a probe's answer. Only the
 * contract decides compatibility; the version is for the status bar, so a
 * patch release on either side never refuses the other.
 */
export function decideAttach(probe: DaemonProbe, bundledContract: number, holding: Holding): AttachDecision {
  switch (probe.kind) {
    case 'unreachable':
      return holding === 'attached' ? { action: 'reconnect' } : { action: 'own' };
    case 'daemon': {
      const { version, contract } = probe.identity;
      if (contract === bundledContract) return { action: 'attach', contract, ...(version !== undefined ? { version } : {}) };
      return {
        action: 'mismatch',
        ...(version !== undefined ? { version } : {}),
        ...(contract !== undefined ? { contract } : {}),
        restart: holding === 'owned',
      };
    }
    case 'unauthorized':
      return { action: 'unauthorized', tokenPresented: probe.tokenPresented };
    case 'unverifiable':
      return { action: 'port-taken' };
  }
}
