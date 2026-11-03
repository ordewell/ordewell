import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** Branches and their actions (W11). Design slice 14 owns this file. */
function Branches(): JSX.Element {
  return <Stub what="The branches" slice={14} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerSidebar({ activity: 'git', id: 'branches', title: 'Branches', render: () => <Branches /> });
}
