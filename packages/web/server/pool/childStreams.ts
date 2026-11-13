import type { WebSocket } from 'ws';
import type { ChildFrame, ChildPlanHandle, RunSnapshotFrame, SessionFrame, StreamStamp } from '@ordewell/core';
import type { StreamSequence } from './streamSequence';

interface Watched {
  sockets: Set<WebSocket>;
  stop(): void;
}

/**
 * The sockets on a child plan (ADR-0055 D20): a child's frames reach only those
 * watching it, numbered on a count of its own. The count outlives every watcher
 * and every Session of the root, so a socket that comes back never sees the
 * numbers go backward. The child's words stay on these sockets: no frame of
 * theirs enters the root's stream.
 */
export class ChildStreams {
  private readonly watched = new Map<string, Watched>();

  constructor(private readonly sequence: StreamSequence, private readonly hears: (ws: WebSocket, workspace: string | undefined) => boolean) {}

  /**
   * Snapshot and watching in one turn, as a root's socket has them: no frame can
   * fall between. `workspace` is the root's: its later frames reach only sockets allowed to hear it.
   */
  join(rootId: string, childId: string, child: ChildPlanHandle, ws: WebSocket, workspace: string | undefined): void {
    if (ws.readyState !== ws.OPEN) return;
    const key = keyOf(rootId, childId);
    const view = child.view();
    ws.send(JSON.stringify({ type: 'connected', sessionId: childId }));
    ws.send(JSON.stringify({
      type: 'run_snapshot', sessionId: childId, view: view.run, approvals: [], ...this.position(rootId, childId),
    } satisfies RunSnapshotFrame));
    if (view.plannerCompaction) ws.send(JSON.stringify(view.plannerCompaction satisfies SessionFrame));
    const watching = this.watched.get(key);
    if (watching) {
      watching.sockets.add(ws);
      return;
    }
    const sockets = new Set([ws]);
    this.watched.set(key, { sockets, stop: child.watch((frame) => this.send(key, sockets, workspace, frame)) });
  }

  leave(rootId: string, childId: string, ws: WebSocket): void {
    const key = keyOf(rootId, childId);
    const watching = this.watched.get(key);
    if (!watching) return;
    watching.sockets.delete(ws);
    if (watching.sockets.size === 0) this.drop(key, watching);
  }

  position(rootId: string, childId: string): StreamStamp {
    return this.sequence.position(keyOf(rootId, childId));
  }

  closeRoot(rootId: string, code: number): void {
    for (const [key, watching] of this.watched) {
      if (!key.startsWith(keyOf(rootId, ''))) continue;
      this.drop(key, watching);
      for (const ws of watching.sockets) {
        if (ws.readyState === ws.OPEN) ws.close(code, 'Child plan closed');
      }
    }
  }

  private send(key: string, sockets: Set<WebSocket>, workspace: string | undefined, frame: ChildFrame): void {
    const payload = JSON.stringify({ ...frame, ...this.sequence.next(key) } satisfies SessionFrame);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN && this.hears(ws, workspace)) ws.send(payload);
    }
  }

  private drop(key: string, watching: Watched): void {
    watching.stop();
    this.watched.delete(key);
  }
}

// A root's own stream is keyed by its bare id, which never holds a NUL: the two never share a count.
const keyOf = (rootId: string, childId: string) => `${rootId}\0${childId}`;
