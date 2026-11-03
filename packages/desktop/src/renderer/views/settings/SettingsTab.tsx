import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** Settings over `/api/settings`, opened by the activity bar's gear and Mod+,. Design slice 9 owns this file. */
function SettingsTab(): JSX.Element {
  return <Stub what="Settings" slice={9} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'settings', render: () => <SettingsTab /> });
}
