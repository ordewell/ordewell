import { useState } from 'react';
import { List, Network } from 'lucide-react';
import { IconButton, PlanGlyph } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { PlanGraph } from '../graph/PlanGraph';
import { PlanList } from './PlanList';

/**
 * The pinned Plan tab, with its List and Graph views. Design slice 8 owns this
 * file and the list; slice 10 owns the graph it switches to.
 */
function PlanTab(): JSX.Element {
  const [view, setView] = useState<'list' | 'graph'>('list');
  return (
    <div>
      <div className="frame-toolbar" role="group" aria-label="Plan view">
        <IconButton icon={List} label="List" active={view === 'list'} aria-pressed={view === 'list'} onClick={() => setView('list')} />
        <IconButton icon={Network} label="Graph" active={view === 'graph'} aria-pressed={view === 'graph'} onClick={() => setView('graph')} />
      </div>
      {view === 'list' ? <PlanList /> : <PlanGraph />}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'plan', icon: PlanGlyph, render: () => <PlanTab /> });
}
