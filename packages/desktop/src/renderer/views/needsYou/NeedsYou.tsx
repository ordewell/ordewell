import type { FrameApi, Unregister } from '../../frame/api';
import { all, Stub } from '../Stub';

/**
 * What waits on the user (W7): the popover from the title bar and the section
 * at the head of the Plan sidebar. Design slice 9 owns this file; it also sets
 * the badge with `api.setNeedsYouCount`.
 */
function NeedsYouList(): JSX.Element {
  return <Stub what="The Needs you list" slice={9} />;
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerSidebar({ activity: 'plan', id: 'needs-you', title: 'Needs you', order: 0, render: () => <NeedsYouList /> }),
    api.registerSlot({ slot: 'popover.needsYou', id: 'needs-you', render: () => <NeedsYouList /> }),
  );
}
