// By path, as the rows draw them: chat stays free of Lucide (status.tsx imports none).
import { STATUSES, StatusIndicator, type StatusId, type StatusLook } from '../../design/status';

/** The bar's order: settled work first, so it fills from the left as the run goes on. */
const BAR_ORDER: readonly StatusId[] = [
  'passed', 'waiting-for-merge', 'skipped', 'running', 'stalled', 'needs-you', 'failed', 'blocked', 'not-started',
];

/** The summary's order: what wants the user first, then what is moving, then the rest. */
const SUMMARY_ORDER: readonly StatusId[] = [
  'failed', 'stalled', 'running', 'blocked', 'waiting-for-merge', 'not-started', 'passed', 'skipped',
];

/**
 * The head of a tall, narrow plan list (docs/desktop/design.md, W4): the goal,
 * one bar segment per status sized by its count, the counts in words, and the
 * Needs you count on its own, since it is the one that asks for the user.
 */
export default function PlanHeader({ goal, looks }: { goal?: string; looks: readonly StatusLook[] }) {
  const counts = new Map<StatusId, number>();
  for (const look of looks) counts.set(look.id, (counts.get(look.id) ?? 0) + 1);
  const words = (id: StatusId): string => `${counts.get(id)} ${STATUSES[id].label.toLowerCase()}`;
  const summary = SUMMARY_ORDER.filter((id) => counts.has(id)).map(words);
  const needsYou = counts.get('needs-you') ?? 0;
  const total = looks.length;
  return (
    <div className="plan-head">
      {goal && <p className="plan-head-goal" title={goal}>{goal}</p>}
      {total > 0 && (
        <div className="plan-head-bar" role="img"
          aria-label={`${total} task${total === 1 ? '' : 's'}: ${BAR_ORDER.filter((id) => counts.has(id)).map(words).join(', ')}`}>
          {BAR_ORDER.filter((id) => counts.has(id)).map((id) => (
            <span key={id} className={`plan-head-segment ow-status-${STATUSES[id].tone}`} data-status={id}
              style={{ flexGrow: counts.get(id) }} />
          ))}
        </div>
      )}
      <p className="plan-head-counts">
        {needsYou > 0 && (
          <span className="plan-head-needs">
            <span aria-hidden="true"><StatusIndicator status="needs-you" size={12} /></span>
            {words('needs-you')}
          </span>
        )}
        <span className="plan-head-summary">{summary.join(' · ')}</span>
      </p>
    </div>
  );
}
