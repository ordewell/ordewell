import { FileDiff } from 'lucide-react';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** A Monaco diff of a task's or the run's change to one file (W9). Design slice 12 owns this file. */
function DiffTab({ tab }: { tab: Tab }): JSX.Element {
  return <Stub what={`The diff of ${tab.id}`} slice={12} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'diff', icon: FileDiff, render: (tab) => <DiffTab tab={tab} /> });
}
