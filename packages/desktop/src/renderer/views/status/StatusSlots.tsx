import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { holderShort } from '../../session/holder';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';

/**
 * The session's lease, a line in the daemon item's detail. The session header's
 * chip and the banners already say when another host holds it, so the row
 * itself stays the daemon's alone.
 */
function Lease({ host }: { host: DaemonHost }): JSX.Element {
  const { state, held, readOnly, link } = useSession(host);
  // The lease is free once the holder exits, though the view stays read-only until Continue here.
  if (held && link?.kind === 'gone') return <span>Lease: {holderShort(held.holder)} exited · read-only</span>;
  if (held && link?.kind === 'joined') return <span>Lease: held by {holderShort(held.holder)} · joined</span>;
  if (held) return <span>Lease: held by {holderShort(held.holder)}{readOnly ? ' · read-only' : ''}</span>;
  if (readOnly) return <span>Lease: another host</span>;
  if (!state.plan) return <span>Lease: this window</span>;
  return <span>Lease: this daemon</span>;
}

/** The daemon a joined session runs in, beside the app's own (W16). */
function JoinedDaemon({ host }: { host: DaemonHost }): JSX.Element | null {
  const { link } = useSession(host);
  if (link?.kind !== 'joined') return null;
  const { holder } = link;
  return <span>Joined :{holder.port}{holder.version ? `, v${holder.version}` : ''} (pid {holder.pid})</span>;
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return all(
    api.registerSlot({ slot: 'status.daemon', id: 'status.lease', order: 1, render: () => <Lease host={host} /> }),
    api.registerSlot({ slot: 'status.daemon', id: 'status.joined', order: 2, render: () => <JoinedDaemon host={host} /> }),
  );
}
