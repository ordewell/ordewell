import { accountLimitsText } from '@ordewell/core/plan-utils';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';

/** The session's lease and what the daemon's own process is attached to. */
function Lease({ host }: { host: DaemonHost }): JSX.Element {
  const { state, held, readOnly } = useSession(host);
  if (readOnly) return <span className="frame-status-text">lease: another host</span>;
  if (held) return <span className="frame-status-text">lease: pid {held.holder.pid}</span>;
  if (!state.plan) return <span className="frame-status-text">lease: this window</span>;
  return <span className="frame-status-text">lease: this daemon</span>;
}

/** Which coding agents the settings file has on. */
function Runners({ host }: { host: DaemonHost }): JSX.Element {
  const { state } = useSession(host);
  const ids = state.enabledRunnerIds;
  if (!state.runnersKnown) return <span className="frame-status-text">runners: checking…</span>;
  if (ids.length === 0) return <span className="frame-status-text">runners: none</span>;
  return <span className="frame-status-text">runners: {ids.join(' ')}</span>;
}

/** The account limits the host has read, one line per account that said anything. */
function Usage({ host }: { host: DaemonHost }): JSX.Element | null {
  const { state } = useSession(host);
  const texts = state.accountLimits.map((snapshot) => accountLimitsText(snapshot)).filter((text): text is string => !!text);
  if (texts.length === 0) return null;
  return <span className="frame-status-text">{texts.join(' · ')}</span>;
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return all(
    api.registerSlot({ slot: 'status.lease', id: 'status.lease', render: () => <Lease host={host} /> }),
    api.registerSlot({ slot: 'status.runners', id: 'status.runners', render: () => <Runners host={host} /> }),
    api.registerSlot({ slot: 'status.usage', id: 'status.usage', render: () => <Usage host={host} /> }),
  );
}
