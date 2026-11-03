import type { DaemonStatus } from '../../../shared/bridge';
import { cardFor } from '../../DaemonBar';
import type { Banner, FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function heldWords(held: NonNullable<ReturnType<DaemonHost['getSnapshot']>['held']>): string {
  const holder = held.holder;
  const who = holder.host?.kind === 'vscode'
    ? `a VS Code window (extension host pid ${holder.pid})`
    : holder.host?.kind === 'daemon'
      ? `the Ordewell daemon on port ${holder.host.port} (pid ${holder.pid})`
      : `an Ordewell process (pid ${holder.pid})`;
  const groups = held.orphanedRunners ?? [];
  if (groups.length > 0) {
    return `The Ordewell host that last ran this session, ${who}, is gone, but runners it started are still running (process group${groups.length === 1 ? '' : 's'} ${groups.join(', ')}). Stop them first, then open the session again.`;
  }
  const since = new Date(holder.since);
  return `This session is open in another Ordewell host: ${who} has held it since ${Number.isNaN(since.getTime()) ? holder.since : since.toLocaleString()}. Close it there, or stop that process, then open it here.`;
}

function holderTitle(held: NonNullable<ReturnType<DaemonHost['getSnapshot']>['held']>): string {
  const kind = held.holder.host?.kind === 'vscode' ? 'VS Code' : held.holder.host?.kind === 'daemon' ? 'a daemon' : 'another host';
  return `Held by ${kind} (pid ${held.holder.pid})`;
}

/**
 * The connection and the session's two quiet states as banners above the
 * window (W15, W16, W17): Reconnecting with the last time the daemon
 * answered, a session another host holds, and a session restored from disk.
 * While the daemon is away the frame is read-only; a held session keeps its
 * reads and its host refuses every write (ADR-0049). Coming back resyncs from
 * a fresh `run_snapshot` rather than inferring what happened.
 */
export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  const shown = new Map<string, { title: string; dismiss: () => void }>();
  const dismissedRestored = new Set<string>();
  let status: DaemonStatus | undefined;
  let lastSeenAt = Date.now();
  let readOnly = false;

  const show = (id: string, banner: Banner): void => {
    // `showBanner` replaces the same id itself, so a moving body is the same banner and is not announced again.
    shown.set(id, { title: banner.title, dismiss: api.showBanner(banner) });
  };
  const hide = (id: string): void => {
    shown.get(id)?.dismiss();
    shown.delete(id);
  };

  const sync = (): void => {
    const snapshot = host.getSnapshot();
    const connected = status?.state === 'connected';
    // Only the daemon's absence stops every control; a held session keeps reads and refuses its writes (ADR-0049).
    api.setReadOnly(!connected);

    if (!connected) {
      const card = status ? cardFor(status) : undefined;
      if (card) {
        show('daemon', {
          id: 'daemon',
          tone: card.tone,
          title: card.title,
          body: `${card.body} Last seen ${ago(Date.now() - lastSeenAt)}.`,
          actions: card.actions.map(({ action, label }) => ({
            label,
            run: async () => {
              const result = await window.ordewell.daemon[action]();
              if (!result.ok && result.message) api.announce(result.message);
            },
          })),
        });
      } else {
        hide('daemon');
      }
    } else {
      hide('daemon');
    }

    if (snapshot.held) {
      show('held', {
        id: 'held',
        tone: 'warning',
        title: holderTitle(snapshot.held),
        body: `${heldWords(snapshot.held)} Its saved state is shown read-only.`,
        actions: [
          { label: 'Refresh', run: () => host.open(snapshot.sessionId) },
          { label: 'View read-only', run: () => host.viewHeld(snapshot.sessionId) },
          {
            label: 'Take over…',
            run: async () => {
              const sure = await window.ordewell.dialog.confirm({
                message: 'Take this session over?',
                detail: `${heldWords(snapshot.held!)} Taking over is refused while that host or the runners it started are still alive.`,
                confirmLabel: 'Take over',
              });
              if (sure) await host.takeOver();
            },
          },
        ],
      });
    } else {
      hide('held');
    }

    if (snapshot.restored && !snapshot.readOnly && !dismissedRestored.has(snapshot.sessionId)) {
      show('restored', {
        id: 'restored',
        tone: 'info',
        title: 'Restored from disk',
        body: 'The run was not running when this daemon opened the session. A task that was running was interrupted and is not verified; nothing here is shown as completed unless its verdict says so.',
        actions: [
          {
            label: 'Resume run',
            run: async () => {
              dismissedRestored.add(snapshot.sessionId);
              hide('restored');
              await host.handle({ type: 'sendSystemCommand', command: 'executePlan' });
            },
          },
          {
            label: 'Dismiss',
            run: () => {
              dismissedRestored.add(snapshot.sessionId);
              hide('restored');
            },
          },
        ],
      });
    } else {
      hide('restored');
    }

    readOnly = !connected || snapshot.held !== null;
  };

  const apply = (next: DaemonStatus): void => {
    const wasConnected = status?.state === 'connected';
    const reconnected = next.state === 'connected' && !wasConnected;
    if (next.state !== 'connected' && wasConnected) lastSeenAt = Date.now();
    status = next;
    if (reconnected) {
      api.announce('Reconnected to the daemon.');
      host.resync();
    }
    sync();
  };

  const offStatus = window.ordewell.daemon.onStatus(apply);
  const offHost = host.subscribe(sync);
  void window.ordewell.daemon.status().then((first) => { if (status === undefined) apply(first); });

  // The last-seen age is the only part of a banner that moves; it is said in the body, never re-announced.
  const timer = setInterval(() => {
    if (status?.state !== 'connected') sync();
  }, 1_000);

  return () => {
    clearInterval(timer);
    offStatus();
    offHost();
    for (const id of [...shown.keys()]) hide(id);
    if (readOnly) api.setReadOnly(false);
  };
}
