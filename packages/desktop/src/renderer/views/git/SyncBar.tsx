import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, PullIcon, PushIcon } from '@ordewell/ui/design';
import type { SyncKind } from './gitStore';
import '../sidebarKit.css';

/*
 * "↓ 0 ↑ 2 [Fetch] [Pull] [Push]" (design W10, W11): the one place the sidebars
 * show where a branch stands against its upstream and offer the three ways to
 * move it. A button that cannot act says why on the line below it, in words,
 * not only in a tooltip.
 */

export interface SyncState {
  /** The branch's upstream, as `origin/main`; null when it has none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Whether any remote is known; without one nothing can be pulled or pushed. Undefined while the remotes are being read. */
  hasRemote: boolean | undefined;
  /** HEAD is detached or unborn: there is no branch to move. */
  branchless: boolean;
}

export interface SyncActions {
  fetch(): Promise<void>;
  pull(): Promise<void>;
  push(): Promise<void>;
}

/** Why Pull is unavailable, or undefined when it is not. */
export function pullBlocked(state: SyncState): string | undefined {
  if (state.branchless) return 'No branch is checked out, so there is nothing to pull into.';
  if (state.hasRemote === false) return 'No remote is configured.';
  if (!state.upstream) return 'This branch has no upstream to pull from.';
  if (state.behind === 0) return `Nothing to pull: ${state.upstream} has no new commits.`;
  return undefined;
}

/** Why Push is unavailable. A branch with a remote but no upstream can still be pushed: that publishes it. */
export function pushBlocked(state: SyncState): string | undefined {
  if (state.branchless) return 'No branch is checked out, so there is nothing to push.';
  if (state.hasRemote === false) return 'No remote is configured.';
  if (state.upstream && state.ahead === 0) return `Nothing to push: ${state.upstream} has every commit.`;
  return undefined;
}

/**
 * `running` is the action git is doing now, whoever started it (the palette's
 * Fetch included); it moves that button's icon. Fetch's arrows turn; Pull's and
 * Push's glide along their own way, since a turned arrow points backwards half
 * the time. A press also holds all three from the click until its action ends,
 * since Pull and Push ask first and nothing is running while the question is
 * open.
 */
export function SyncBar({ state, actions, label, running }: { state: SyncState; actions: SyncActions; label: string; running?: SyncKind }): JSX.Element {
  const [pressed, setPressed] = useState(false);
  const run = (which: SyncKind): void => {
    setPressed(true);
    // Every refusal is worded in a banner where the action ran; what is left to catch here only has to release the buttons.
    actions[which]().catch(() => undefined).finally(() => setPressed(false));
  };
  const busy = pressed || running !== undefined;
  const reading = state.hasRemote === undefined;
  const pull = pullBlocked(state);
  const push = pushBlocked(state);
  const fetchBlocked = state.hasRemote === false ? 'No remote is configured.' : undefined;
  // Without a remote all three share one reason: say it once.
  const why = reading ? [] : fetchBlocked ? [fetchBlocked] : [pull, push].filter((r): r is string => r !== undefined);
  return (
    <div className="sync" role="group" aria-label={`Sync ${label}`}>
      {state.upstream && (
        <div className="sync-counts" title={`${state.ahead} ahead, ${state.behind} behind ${state.upstream}`}>
          <span className="sync-count">↓ {state.behind} ↑ {state.ahead}</span>
        </div>
      )}
      <div className="sync-actions">
        <Button size="sm" icon={RefreshCw} busy={running === 'fetch'} disabled={busy || reading || fetchBlocked !== undefined} title={fetchBlocked ?? 'Fetch from the remote'} onClick={() => run('fetch')}>Fetch</Button>
        <Button size="sm" icon={PullIcon} busy={running === 'pull'} busyMotion="glide" disabled={busy || reading || pull !== undefined} title={pull ?? 'Pull'} onClick={() => run('pull')}>Pull</Button>
        <Button size="sm" icon={PushIcon} busy={running === 'push'} busyMotion="glide" disabled={busy || reading || push !== undefined} title={push ?? 'Push'} onClick={() => run('push')}>Push</Button>
      </div>
      {why.length > 0 && <p className="sync-why">{why.join(' ')}</p>}
    </div>
  );
}
