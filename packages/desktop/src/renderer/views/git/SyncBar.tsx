import { useState } from 'react';
import { Check, GitBranch, RefreshCw } from 'lucide-react';
import { Button, Icon, PullIcon, PushIcon } from '@ordewell/ui/design';
import type { SyncKind } from './gitStore';
import { MiddleText } from '../sidebarKit';
import '../sidebarKit.css';

/*
 * "[↓ Pull 1] [↑ Push 2] [⟳]" (design W10, W11): the one place the sidebars
 * show where a branch stands against its upstream and offer the three ways to
 * move it, on one line. A count is only drawn when there is something to move,
 * and a button that cannot act says why in its tooltip and its description; a
 * line of words is kept for the states the person has to do something about.
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

const commits = (n: number): string => `${n} commit${n === 1 ? '' : 's'}`;

/** Why Pull is unavailable, or undefined when it is not. */
export function pullBlocked(state: SyncState): string | undefined {
  if (state.branchless) return 'Nothing to pull: no branch is checked out';
  if (state.hasRemote === false) return 'Nothing to pull: no remote is configured';
  if (!state.upstream) return 'Nothing to pull: this branch has no upstream yet';
  if (state.behind === 0) return `Nothing to pull: ${state.upstream} has no new commits`;
  return undefined;
}

/** Why Push is unavailable. A branch with a remote but no upstream can still be pushed: that publishes it. */
export function pushBlocked(state: SyncState): string | undefined {
  if (state.branchless) return 'Nothing to push: no branch is checked out';
  if (state.hasRemote === false) return 'Nothing to push: no remote is configured';
  if (state.upstream && state.ahead === 0) return `Nothing to push: ${state.upstream} has every commit`;
  return undefined;
}

/**
 * The line under the buttons, only for a state the person has to act on. Up to
 * date, ahead or behind is what the counts and the tooltips already say.
 */
export function syncNote(state: SyncState): string | undefined {
  if (state.branchless) return 'No branch is checked out: Pull and Push need one.';
  if (state.hasRemote === undefined) return undefined;
  if (state.hasRemote === false) return 'No remote: add one to fetch, pull or push.';
  if (!state.upstream) return 'Not published: Push publishes it.';
  return undefined;
}

/** A count is drawn only when there is something to move, and never wider than its box. */
const shown = (n: number): string => (n <= 0 ? '' : n > 99 ? '99+' : String(n));

/**
 * `running` is the action git is doing now, whoever started it (the palette's
 * Fetch included); it moves that button's icon. Fetch's arrows turn; Pull's and
 * Push's glide along their own way, since a turned arrow points backwards half
 * the time, and their word says it ("Pulling") in the count's place, so the
 * button reads as working even where motion is reduced. A press also holds all three from the click until its action ends,
 * since Pull and Push ask first and nothing is running while the question is
 * open.
 *
 * `branch` draws the checkout's own line above the buttons, its name and the
 * upstream, for a sidebar that does not already show them.
 */
export function SyncBar({ state, actions, label, running, branch }: {
  state: SyncState;
  actions: SyncActions;
  label: string;
  running?: SyncKind;
  branch?: string;
}): JSX.Element {
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
  const fetchBlocked = state.hasRemote === false ? 'Nothing to fetch: no remote is configured' : undefined;
  const readingTip = 'Reading the remotes…';
  const pullTip = reading ? readingTip : pull ?? `Pull ${commits(state.behind)} from ${state.upstream}`;
  const pushTip = reading ? readingTip : push ?? (state.upstream ? `Push ${commits(state.ahead)} to ${state.upstream}` : 'Publish this branch: push it and track it');
  const note = syncNote(state);
  return (
    <div className="sync" role="group" aria-label={`Sync ${label}`}>
      {branch !== undefined && (
        <div className="sync-head" title="Your checkout: Pull, Push and Fetch act on it">
          <Icon icon={state.branchless ? GitBranch : Check} size={16} />
          <MiddleText className="sync-branch" text={branch} />
          {state.upstream && <MiddleText className="sync-upstream" text={state.upstream} />}
        </div>
      )}
      <div className="sync-actions">
        <Button className="sync-move" icon={PullIcon} busy={running === 'pull'} busyMotion="glide" disabled={busy || reading || pull !== undefined} title={pullTip} onClick={() => run('pull')}>
          <span className="sync-word">{running === 'pull' ? 'Pulling' : 'Pull'}</span>
          {running !== 'pull' && <span className="ow-count sync-n" aria-hidden="true">{shown(state.behind)}</span>}
        </Button>
        <Button className="sync-move" icon={PushIcon} busy={running === 'push'} busyMotion="glide" disabled={busy || reading || push !== undefined} title={pushTip} onClick={() => run('push')}>
          <span className="sync-word">{running === 'push' ? 'Pushing' : 'Push'}</span>
          {running !== 'push' && <span className="ow-count sync-n" aria-hidden="true">{shown(state.ahead)}</span>}
        </Button>
        <Button className="sync-fetch" icon={RefreshCw} busy={running === 'fetch'} disabled={busy || reading || fetchBlocked !== undefined} aria-label="Fetch" title={reading ? readingTip : fetchBlocked ?? 'Fetch from the remote'} onClick={() => run('fetch')}>
          {null}
        </Button>
      </div>
      {note && <p className="sync-note">{note}</p>}
    </div>
  );
}
