import type { DaemonStatus } from '../../../shared/bridge';
import { cardFor } from '../../DaemonBar';
import type { Banner, FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { checkAgain, holderShort, joinedName } from '../../session/holder';

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

function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const checkedAt = new Map<string, number>();
  let shownFor: string | undefined;

  const refreshHeld = async (sessionId: string): Promise<void> => {
    const words = await checkAgain(host, sessionId);
    if (words === undefined) return;
    api.announce(words);
    checkedAt.set(sessionId, Date.now());
    sync();
  };

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

    const held = snapshot.held;
    const link = snapshot.link;
    const checked = checkedAt.get(snapshot.sessionId);
    const checkedWords = checked === undefined ? '' : ` Checked at ${new Date(checked).toLocaleTimeString()}.`;
    const refresh = { label: 'Refresh', run: () => refreshHeld(snapshot.sessionId) };
    const watch = { label: 'View read-only', run: () => host.viewHeld(snapshot.sessionId) };
    const takeOver = {
      label: 'Take over…',
      run: async () => {
        if (!held) return;
        const sure = await window.ordewell.dialog.confirm({
          message: 'Take this session over?',
          detail: `${heldWords(held)} Taking over is refused while that host or the runners it started are still alive.`,
          confirmLabel: 'Take over',
        });
        if (!sure) return;
        const outcome = await host.takeOver();
        // The live region alone is easy to miss: the outcome also stays on screen until dismissed.
        show('takeover', {
          id: 'takeover',
          tone: outcome.ok ? 'info' : 'error',
          title: outcome.ok ? 'Taken over' : 'Take over refused',
          body: outcome.message,
          actions: [{ label: 'Dismiss', run: () => hide('takeover') }],
        });
        // After the banner, whose own announcement is only its title: the reason is what to hear.
        api.announce(outcome.message);
      },
    };

    if (link?.kind === 'gone') {
      show('held', {
        id: 'held',
        tone: 'info',
        title: `${joinedName(link.holder)} that held this session has exited.`,
        body: 'Nothing is running it now.',
        actions: [{ label: 'Continue here', run: () => host.continueHere() }],
      });
    } else if (link?.kind === 'joined' && link.away) {
      // The holder's pid still holds the lease, so nothing may continue it here: this is W15's bar, at its port.
      const who = link.holder.ownerPid !== undefined ? "the TUI's daemon" : 'the daemon';
      show('held', {
        id: 'held',
        tone: 'warning',
        title: `Reconnecting to ${who} on :${link.holder.port}…`,
        body: `Its process (pid ${link.holder.pid}) still holds this session. The plan is shown as it was last seen.`,
      });
    } else if (held && link?.kind !== 'joined' && link?.kind !== 'joining') {
      if (link?.kind === 'refused') {
        show('held', {
          id: 'held',
          tone: 'warning',
          title: `Can't join the ${holderShort(held.holder)}`,
          body: `${link.message} Its saved state is shown read-only.${checkedWords}`,
          actions: [{ ...watch, label: 'Watch read-only' }, refresh, takeOver],
        });
      } else if (held.holder.host?.kind === 'vscode' && (held.orphanedRunners ?? []).length === 0) {
        show('held', {
          id: 'held',
          tone: 'warning',
          title: 'This session is open in a VS Code window',
          body: `(extension host pid ${held.holder.pid}, since ${clock(held.holder.since)}). VS Code runs it inside its own window, so the app can't join it.${checkedWords}`,
          actions: [
            { label: 'Start a new session here', run: () => host.startHere() },
            { ...watch, label: 'Watch read-only' },
            refresh,
            takeOver,
          ],
        });
      } else {
        show('held', {
          id: 'held',
          tone: 'warning',
          title: holderTitle(held),
          body: `${heldWords(held)} Its saved state is shown read-only.${checkedWords}`,
          actions: [refresh, watch, takeOver],
        });
      }
    } else {
      hide('held');
    }
    if (shownFor !== snapshot.sessionId) {
      // An outcome belongs to the session it was asked for.
      if (shownFor !== undefined) hide('takeover');
      shownFor = snapshot.sessionId;
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

    readOnly = !connected;
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
