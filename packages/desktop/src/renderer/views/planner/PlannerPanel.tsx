import type { FocusEvent } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { checkAgain, holderShort, joinedName, joinedShort } from '../../session/holder';
import { ChatSurface, useSession } from '../../session/useSession';

/**
 * Mod+L focuses a region's first focusable element in document order, and the
 * chat's composer sits below its conversation: this stand-in is first, and
 * hands the focus on to the composer.
 */
function toComposer(event: FocusEvent<HTMLDivElement>): void {
  if (event.target !== event.currentTarget) return;
  event.currentTarget.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

/**
 * Whose session this is, when it is not this window's own (W16): joined in
 * another daemon and driven live, being joined, or shown read-only. The
 * holder is named by what its lease records.
 */
function HolderChip({ host, announce }: { host: DaemonHost; announce: (text: string) => void }): JSX.Element | null {
  const { held, link, readOnly, sessionId } = useSession(host);
  if (link?.kind === 'joining') {
    const who = held?.holder.host?.kind === 'daemon' && held.holder.host.ownerPid !== undefined ? "the TUI's daemon" : 'the daemon';
    return <div className="session-holder"><span className="session-holder-chip">Joining {who} on :{link.port} …</span></div>;
  }
  if (link?.kind === 'joined') {
    const { holder } = link;
    const tui = holder.ownerPid !== undefined;
    const detail = `${tui ? "The TUI's daemon" : 'The daemon'} on port ${holder.port}, ${holder.version ? `v${holder.version}` : 'version unknown'}, has held the session since ${new Date(holder.since).toLocaleString()}.`;
    return (
      <div className="session-holder">
        <span className="session-holder-chip" title={detail}>⇄ Joined · {joinedShort(holder)}</span>
        <span className="session-holder-note muted">
          Live in {tui ? "the TUI's daemon" : 'the daemon'} on port {holder.port} (pid {holder.pid}), shared{tui ? ' with the TUI' : ''}.
        </span>
      </div>
    );
  }
  if (link?.kind === 'gone') {
    // Continue here is the banner's; Refresh would only find the lease free.
    return <div className="session-holder"><span className="session-holder-chip">⊡ Read-only · {joinedName(link.holder).replace(/^The/, 'the')} exited</span></div>;
  }
  if (held && readOnly) {
    return (
      <div className="session-holder">
        <span className="session-holder-chip">⊡ Read-only · held by {holderShort(held.holder)}</span>
        <button type="button" className="session-holder-refresh" onClick={() => { void checkAgain(host, sessionId).then((words) => { if (words) announce(words); }); }}>Refresh</button>
      </div>
    );
  }
  return null;
}

/** The planner conversation, the centre's pinned first tab (W2): ui's chat, without the plan, over the session's host. */
function PlannerPanel({ host, announce }: { host: DaemonHost; announce: (text: string) => void }): JSX.Element {
  return (
    <div className="session-planner" data-autofocus tabIndex={-1} onFocus={toComposer}>
      <HolderChip host={host} announce={announce} />
      <ChatSurface host={host} layout="conversation" />
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return api.registerTabKind({ kind: 'planner', icon: MessageSquareText, render: () => <PlannerPanel host={host} announce={(text) => api.announce(text)} /> });
}
