import type { FrameApi, Unregister } from '../frame/api';
import * as changesSidebar from './changes/ChangesSidebar';
import * as diffTab from './changes/DiffTab';
import * as checkoutGroup from './checkout/CheckoutGroup';
import * as connectionBanners from './connection/ConnectionBanners';
import * as explorerSidebar from './explorer/ExplorerSidebar';
import * as fileTab from './explorer/FileTab';
import * as commitDiffTab from './git/CommitDiffTab';
import * as commitGraphTab from './git/CommitGraphTab';
import * as gitSidebar from './git/GitSidebar';
import * as needsYou from './needsYou/NeedsYou';
import * as planSidebar from './plan/PlanSidebar';
import * as planTab from './plan/PlanTab';
import * as plannerPanel from './planner/PlannerPanel';
import * as liveWork from './project/liveWork';
import * as scopeSwitcher from './scope/ScopeSwitcher';
import * as settingsTab from './settings/SettingsTab';
import * as statusSlots from './status/StatusSlots';
import * as taskTab from './task/TaskTab';
import * as terminalPanel from './terminal/TerminalPanel';

/**
 * Every view module, each registering itself through the frame API alone. A
 * slice edits its own modules; this list changes only when a module is added.
 */
const VIEWS: ReadonlyArray<{ register(api: FrameApi): Unregister }> = [
  planSidebar, planTab, plannerPanel, taskTab,
  needsYou, connectionBanners, settingsTab, statusSlots,
  explorerSidebar, fileTab, scopeSwitcher,
  changesSidebar, diffTab, checkoutGroup,
  gitSidebar, commitGraphTab, commitDiffTab,
  terminalPanel, liveWork,
];

export function registerViews(api: FrameApi): Unregister {
  const offs = VIEWS.map((view) => view.register(api));
  return () => { for (const off of offs) off(); };
}
