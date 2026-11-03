import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/**
 * Task and run changes to review (W9). Design slice 12 owns this file; the
 * checkout's own changes are a separate section (checkout/CheckoutGroup).
 */
function ChangesList(): JSX.Element {
  return <Stub what="The changes to review" slice={12} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerSidebar({ activity: 'changes', id: 'review', title: 'Review', order: 10, render: () => <ChangesList /> });
}
