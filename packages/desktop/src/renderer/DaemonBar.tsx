import type { DaemonStatus } from '../shared/bridge';

export type Action = 'retry' | 'start' | 'restart';

export interface Card {
  tone: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  actions: Array<{ action: Action; label: string }>;
}

function versionOf(view: { version?: string; contract?: number }): string {
  const parts = [view.version ? `v${view.version}` : 'an unknown version', view.contract !== undefined ? `contract ${view.contract}` : 'no contract'];
  return parts.join(', ');
}

/** What each state tells the user and lets them do (design W15), or nothing when all is well. */
export function cardFor(status: DaemonStatus): Card | undefined {
  switch (status.state) {
    case 'connecting':
    case 'connected':
      return undefined;
    case 'reconnecting':
      return {
        tone: 'warning',
        title: 'Reconnecting to the daemon…',
        body: `Nothing answers on 127.0.0.1:${status.port} (attempt ${status.attempt}).`,
        actions: [{ action: 'retry', label: 'Retry now' }, ...(status.canStart ? [{ action: 'start' as const, label: 'Start a daemon' }] : [])],
      };
    case 'mismatch':
      return {
        tone: 'warning',
        title: 'The running daemon is another version',
        body: `The daemon on :${status.port} is ${versionOf(status.daemon)}; this app speaks ${versionOf(status.app)}. Restart it with the bundled one; a daemon with a live run is left alone.`,
        actions: [{ action: 'restart', label: 'Restart daemon' }, { action: 'retry', label: 'Retry' }],
      };
    case 'unauthorized':
      return {
        tone: 'error',
        title: 'Could not authenticate with the daemon',
        body: status.tokenPresented
          ? `The daemon on :${status.port} rejected the saved connection token. Retry to read its current token and reconnect.`
          : `The connection token for the daemon on :${status.port} is not available. Retry once it has finished starting.`,
        actions: [{ action: 'retry', label: 'Retry' }],
      };
    case 'port-taken':
      return {
        tone: 'error',
        title: `Port ${status.port} is taken`,
        body: `Something that is not an Ordewell daemon holds 127.0.0.1:${status.port}. Free the port, or set ORDEWELL_PORT to another one and relaunch.`,
        actions: [{ action: 'retry', label: 'Retry' }],
      };
    case 'failed':
      return {
        tone: 'error',
        title: 'The daemon could not start',
        body: `${status.message} The log is at ${status.logPath}.`,
        actions: [{ action: 'start', label: 'Start a daemon' }, { action: 'retry', label: 'Retry' }],
      };
  }
}

const named = (daemon: { version?: string }): string => (daemon.version ? `Daemon v${daemon.version}` : 'Daemon');

/**
 * The connection in a few words, for the bar at the foot of a window: the
 * daemon's version and port while all is well, otherwise what needs the user.
 * Who started it goes in daemonDetail, so the row stays one short line.
 */
export function daemonLabel(status: DaemonStatus): string {
  switch (status.state) {
    case 'connecting': return status.starting ? `Starting the daemon on :${status.port}…` : `Connecting to :${status.port}…`;
    case 'connected': return `${named(status.daemon)} · :${status.port}`;
    case 'reconnecting': return `Reconnecting to :${status.port}…`;
    case 'mismatch': return `Version mismatch on :${status.port}`;
    case 'unauthorized': return `Unauthorized on :${status.port}`;
    case 'port-taken': return `Port ${status.port} taken`;
    case 'failed': return 'Daemon failed';
  }
}

/** The connection in a sentence, for the daemon item's detail. */
export function daemonDetail(status: DaemonStatus): string {
  switch (status.state) {
    case 'connected':
      return `${named(status.daemon)} on 127.0.0.1:${status.port}, ${status.owned ? 'started by this app' : 'attached: started outside this app'}`;
    case 'mismatch':
      return `The daemon on :${status.port} is ${versionOf(status.daemon)}; this app speaks ${versionOf(status.app)}`;
    default:
      return cardFor(status)?.body ?? daemonLabel(status);
  }
}
