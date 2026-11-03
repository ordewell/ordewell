import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/**
 * The user's own checkout changes: stage, commit, push (W10, W13), and Merge
 * all's preflight. Design slice 13 owns this file.
 */
function CheckoutChanges(): JSX.Element {
  return <Stub what="Your checkout's changes" slice={13} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerSidebar({ activity: 'changes', id: 'checkout', title: 'Checkout', order: 0, render: () => <CheckoutChanges /> });
}
