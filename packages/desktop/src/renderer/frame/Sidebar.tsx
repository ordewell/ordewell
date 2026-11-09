import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Icon, SectionHeader } from '@ordewell/ui/design';
import type { SidebarSection } from './api';
import { ACTIVITY_ICONS } from './ActivityBar';
import { activityTitle } from './commands';
import { paneSizes } from './layout';
import { useDisclosure, useFrameState } from './store';

/**
 * A sidebar section's header: its name and count, a toggle that folds it when
 * `open` is given, and its actions beside it. A section that owns its heading
 * (SidebarSection.ownsHeading) draws this itself, so it looks like the rest.
 */
export function SectionHead({ id, title, count, showZero = false, open, onToggle, controls, actions }: {
  id: string;
  title: string;
  count?: number;
  /** Say "(0)" too: a folded empty section says why it is folded. */
  showZero?: boolean;
  open?: boolean;
  onToggle?(open: boolean): void;
  /** The id of what the toggle folds, where that is not the rest of the section. */
  controls?: string;
  actions?: ReactNode;
}): JSX.Element {
  const name = (
    <>
      <span className="frame-section-name">{title}</span>
      {count !== undefined && (count > 0 || showZero) && <span className="ow-count">({count})</span>}
    </>
  );
  return (
    <div className="frame-section-head">
      <h3 id={id} className="frame-section-title">
        {open === undefined ? name : (
          <button type="button" className="frame-section-toggle" aria-expanded={open} aria-controls={controls} onClick={() => onToggle?.(!open)}>
            {name}
            <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          </button>
        )}
      </h3>
      {actions && <div className="frame-section-actions">{actions}</div>}
    </div>
  );
}

function Section({ section }: { section: SidebarSection }): JSX.Element {
  const [chosen, setOpen] = useDisclosure(`sidebar:${section.activity}/${section.id}`);
  const heading = `sidebar-${section.activity}-${section.id}`;
  if (section.ownsHeading) return <section className="frame-sidebar-section" aria-label={section.title}>{section.render()}</section>;
  const count = section.count?.();
  // An empty foldable section folds to its header with its 0 (W7) until the user opens it, and opens again when something arrives.
  const empty = section.collapsible === true && count === 0;
  const open = chosen ?? !empty;
  return (
    <section className="frame-sidebar-section" aria-labelledby={heading}>
      <SectionHead
        id={heading}
        title={section.title}
        count={count}
        showZero={empty}
        open={section.collapsible ? open : undefined}
        onToggle={setOpen}
        actions={section.actions?.()}
      />
      {open && section.render()}
    </section>
  );
}

/**
 * The sidebar of the chosen activity: the sections view modules registered for
 * it, stacked. Docked beside the activity bar, or a drawer over the centre
 * while the window is too narrow to dock it (Collapse order).
 */
export function Sidebar({ drawer = false }: { drawer?: boolean }): JSX.Element {
  const { layout, sidebars } = useFrameState();
  const sections = sidebars.filter((section) => section.activity === layout.activity);
  const title = activityTitle(layout.activity);

  return (
    <nav
      className={['frame-sidebar', drawer ? 'frame-drawer frame-drawer-left' : ''].filter(Boolean).join(' ')}
      aria-label={title}
      data-region="sidebar"
      data-activity={layout.activity}
      style={{ width: paneSizes(layout).sidebar }}
    >
      <SectionHeader className="frame-pane-head" icon={ACTIVITY_ICONS[layout.activity]} title={title} level={2} />
      <div className="frame-sidebar-body">
        {sections.length === 0 && <p className="frame-empty">Nothing here yet.</p>}
        {sections.map((section) => <Section key={section.id} section={section} />)}
      </div>
    </nav>
  );
}
