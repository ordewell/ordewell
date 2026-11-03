import { RunnerGlyph } from '@ordewell/ui/design';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** One task followed in its own tab (W4): `id` is the task id, `scope` its task scope. Design slice 8 owns this file. */
function TaskTab({ tab }: { tab: Tab }): JSX.Element {
  return <Stub what={`The view of ${tab.title}`} slice={8} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'task', icon: RunnerGlyph, render: (tab) => <TaskTab tab={tab} /> });
}
