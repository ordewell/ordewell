import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** The planner conversation on the right (W2). Design slice 8 owns this file. */
function PlannerPanel(): JSX.Element {
  return (
    <div className="frame-stack">
      <Stub what="The planner" slice={8} />
      {/* Where Mod+L lands; the slice's composer keeps the attribute. */}
      <textarea className="frame-input" aria-label="Message the planner" placeholder="Describe a goal" data-autofocus rows={3} />
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return api.registerPanel({ region: 'right', id: 'planner', title: 'Planner', render: () => <PlannerPanel /> });
}
