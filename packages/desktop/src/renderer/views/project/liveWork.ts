import type { HostState } from '@ordewell/ui';
import type { LiveWorkKind } from '../../../shared/bridge';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost } from '../../session/DaemonHost';
import { isLive } from '../needsYou/attention';

/** What this window has live, in the order main words it: what switching its folder would leave behind. */
export function liveWorkKinds(state: HostState): LiveWorkKind[] {
  const kinds: LiveWorkKind[] = [];
  if (isLive(state)) kinds.push('run');
  if ((state.run.escalations ?? []).length > 0) kinds.push('needsYou');
  if (state.checkpoint !== null) kinds.push('checkpoint');
  if (state.isResearchActive) kinds.push('planner');
  return kinds;
}

/**
 * Tells main what this window has live each time that changes, so a folder
 * chosen here can ask before it replaces the window (ADR-0063 H6). Main asks
 * the daemon about runs as well, so a report that arrives late errs only
 * towards asking.
 */
export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  let last = '';
  const update = (): void => {
    const kinds = liveWorkKinds(host.getSnapshot().state);
    const key = kinds.join(',');
    if (key === last) return;
    last = key;
    void window.ordewell.app.reportLiveWork(kinds);
  };
  const off = host.subscribe(update);
  update();
  return off;
}
