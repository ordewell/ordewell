import { FileText } from 'lucide-react';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** One file in Monaco, read-only outside the checkout (W8). Design slice 11 owns this file. */
function FileTab({ tab }: { tab: Tab }): JSX.Element {
  return <Stub what={`The editor for ${tab.id}`} slice={11} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'file', icon: FileText, render: (tab) => <FileTab tab={tab} /> });
}
