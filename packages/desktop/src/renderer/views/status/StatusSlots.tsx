import type { RunnerAuth } from '@ordewell/core';
import { accountLimitsText } from '@ordewell/core/plan-utils';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { holderShort } from '../../session/holder';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';

/** The session's lease and what the daemon's own process is attached to. */
function Lease({ host }: { host: DaemonHost }): JSX.Element {
  const { state, held, readOnly, link } = useSession(host);
  // The lease is free once the holder exits, though the view stays read-only until Continue here.
  if (held && link?.kind === 'gone') return <span className="frame-status-text">{holderShort(held.holder)} exited · read-only</span>;
  if (held && link?.kind === 'joined') return <span className="frame-status-text">held by {holderShort(held.holder)} · joined</span>;
  if (held) return <span className="frame-status-text">held by {holderShort(held.holder)}{readOnly ? ' · read-only' : ''}</span>;
  if (readOnly) return <span className="frame-status-text">lease: another host</span>;
  if (!state.plan) return <span className="frame-status-text">lease: this window</span>;
  return <span className="frame-status-text">lease: this daemon</span>;
}

/** The daemon a joined session runs in, beside the app's own (W16). */
function JoinedDaemon({ host }: { host: DaemonHost }): JSX.Element | null {
  const { link } = useSession(host);
  if (link?.kind !== 'joined') return null;
  const { holder } = link;
  return <span className="frame-status-text" title={`Joined the daemon on :${holder.port}${holder.version ? `, v${holder.version}` : ''} (pid ${holder.pid})`}>· joined :{holder.port}</span>;
}

const SIGN_IN: Record<RunnerAuth['state'], { mark: string; words: string }> = {
  'signed-in': { mark: ' ✓', words: 'signed in' },
  'signed-out': { mark: ' · signed out', words: 'signed out' },
  // Only the runner can say its user is signed out (ADR-0009): no answer is not a warning.
  unknown: { mark: '', words: 'sign-in not known' },
};

/** Which coding agents the settings file has on, each by its name and whether its own login says it is signed in. */
function Runners({ host }: { host: DaemonHost }): JSX.Element {
  const { state } = useSession(host);
  const ids = state.enabledRunnerIds;
  if (!state.runnersKnown) return <span className="frame-status-text" data-runners="checking">runners: checking…</span>;
  if (ids.length === 0) return <span className="frame-status-text" data-runners="known">runners: none</span>;
  return (
    <span className="frame-status-text frame-status-runners" data-runners="known">
      {ids.map((id) => {
        const name = state.runnerList.find((runner) => runner.id === id)?.displayName ?? id;
        const auth = state.planner.backends.find((backend) => backend.runner === id && backend.auth)?.auth?.state ?? 'unknown';
        const label = `${name}, ${SIGN_IN[auth].words}`;
        return <span key={id} data-auth={auth} aria-label={label} title={label}>{name}{SIGN_IN[auth].mark}</span>;
      })}
    </span>
  );
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
    api.registerSlot({ slot: 'status.daemon', id: 'status.daemon', render: () => <JoinedDaemon host={host} /> }),
    api.registerSlot({ slot: 'status.lease', id: 'status.lease', render: () => <Lease host={host} /> }),
    api.registerSlot({ slot: 'status.runners', id: 'status.runners', render: () => <Runners host={host} /> }),
    api.registerSlot({ slot: 'status.usage', id: 'status.usage', render: () => <Usage host={host} /> }),
  );
}
