import { useState } from 'react';
import type { ActionResult, DaemonStatus } from '../shared/bridge';

type Action = 'retry' | 'start' | 'restart';

interface Card {
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
        title: 'The daemon refused this app',
        body: status.tokenPresented
          ? `The daemon on :${status.port} did not accept the token on disk; it may belong to another user. Set ORDEWELL_PORT to use another port.`
          : `No token was found for the daemon on :${status.port}, so it cannot be reached as this user. Set ORDEWELL_PORT to use another port.`,
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

function label(status: DaemonStatus): string {
  switch (status.state) {
    case 'connecting': return `Connecting to :${status.port}…`;
    case 'connected': {
      const version = status.daemon.version ? ` v${status.daemon.version}` : '';
      return `Daemon${version} on :${status.port} · ${status.owned ? 'started by this app' : 'attached'}`;
    }
    case 'reconnecting': return `Reconnecting to :${status.port}…`;
    case 'mismatch': return `Version mismatch on :${status.port}`;
    case 'unauthorized': return `Unauthorized on :${status.port}`;
    case 'port-taken': return `Port ${status.port} taken`;
    case 'failed': return 'Daemon failed';
  }
}

/** The daemon line at the bottom of every window, with its card above when something needs the user. */
export function DaemonBar({ status }: { status: DaemonStatus }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const card = cardFor(status);

  const run = async (action: Action): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    try {
      const result: ActionResult = await window.ordewell.daemon[action]();
      if (!result.ok && result.message) setRefusal(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {card && (
        <section className={`daemon-card daemon-card-${card.tone}`} role="alert">
          <h2>{card.title}</h2>
          <p>{card.body}</p>
          {refusal && <p className="daemon-refusal">{refusal}</p>}
          <div className="daemon-actions">
            {card.actions.map(({ action, label: text }) => (
              <button key={action} type="button" disabled={busy} onClick={() => { void run(action); }}>{text}</button>
            ))}
          </div>
        </section>
      )}
      <footer className={`daemon-bar daemon-bar-${status.state}`}>
        <span className="daemon-dot" aria-hidden="true" />
        {label(status)}
      </footer>
    </>
  );
}
