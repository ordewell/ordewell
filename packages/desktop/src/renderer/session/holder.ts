import type { SessionHeld } from '@ordewell/core';
import type { HolderView } from '../../shared/bridge';
import type { DaemonHost } from './DaemonHost';

type Holder = SessionHeld['holder'];

/**
 * The holder as W16 names it in a chip or a status item: a daemon with an
 * owner is a TUI's private one, named by the TUI's pid, as the person knows it.
 */
export function holderShort(holder: Holder): string {
  const host = holder.host;
  if (host?.kind === 'vscode') return `VS Code (pid ${holder.pid})`;
  if (host?.kind === 'daemon') return host.ownerPid !== undefined ? `TUI (pid ${host.ownerPid})` : `daemon :${host.port} (pid ${holder.pid})`;
  return `pid ${holder.pid}`;
}

/** A joined holder in the session header's chip: "TUI pid 48120", or "daemon :49213". */
export function joinedShort(holder: HolderView): string {
  return holder.ownerPid !== undefined ? `TUI pid ${holder.ownerPid}` : `daemon :${holder.port}`;
}

/** The holder that joined daemon is, in a sentence: "The TUI" or "The daemon on :49213". */
export function joinedName(holder: HolderView): string {
  return holder.ownerPid !== undefined ? 'The TUI' : `The daemon on :${holder.port}`;
}

/**
 * Asks the lease again and says what it found: a click that changed nothing
 * still shows it ran. Undefined when another session was opened meanwhile.
 */
export async function checkAgain(host: DaemonHost, sessionId: string): Promise<string | undefined> {
  await host.open(sessionId);
  const after = host.getSnapshot();
  if (after.sessionId !== sessionId) return undefined;
  const found = after.link?.kind === 'joined'
    ? `joined ${joinedName(after.link.holder).replace(/^The/, 'the')}.`
    : after.held ? `still held by ${holderShort(after.held.holder)}.` : 'the session is open here.';
  return `Checked again: ${found}`;
}

/** Why a take over was refused, naming the live holder and the way out (W16, ADR-0049). */
export function takeOverRefusal(held: SessionHeld): string {
  const groups = held.orphanedRunners ?? [];
  if (groups.length > 0) {
    return `The host that last ran this session is gone, but runners it started are still running (process group${groups.length === 1 ? '' : 's'} ${groups.join(', ')}). Stop them, then take it over again.`;
  }
  const { pid, host } = held.holder;
  if (host?.kind === 'daemon') {
    return host.ownerPid !== undefined
      ? `The TUI (pid ${host.ownerPid}) is still running and holds this session. Quit it, or close the session there, then choose Continue here.`
      : `The Ordewell daemon on :${host.port} (pid ${pid}) is still running and holds this session. Stop it, or close the session there, then choose Continue here.`;
  }
  if (host?.kind === 'vscode') {
    return `VS Code (extension host pid ${pid}) is still running and holds this session. Close the session there, then take it over again.`;
  }
  return `An older Ordewell process (pid ${pid}) is still running and holds this session. Stop it, then take it over again.`;
}
