import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Icon, SectionHeader } from '@ordewell/ui/design';
import type { SidebarSection } from './api';
import { ACTIVITY_ICONS } from './ActivityBar';
import { activityTitle } from './commands';
import { paneSizes } from './layout';
import { useFrameState } from './store';

function Section({ section }: { section: SidebarSection }): JSX.Element {
  const [chosen, setOpen] = useState<boolean>();
  const heading = `sidebar-${section.activity}-${section.id}`;
  const count = section.count?.();
  // An empty foldable section folds to its header with its 0 (W7) until the user opens it, and opens again when something arrives.
  const empty = section.collapsible === true && count === 0;
  const open = chosen ?? !empty;
  const title = (
    <>
      <span className="frame-section-name">{section.title}</span>
      {count !== undefined && (count > 0 || empty) && <span className="ow-count">({count})</span>}
    </>
  );
  return (
    <section className="frame-sidebar-section" aria-labelledby={heading}>
      <div className="frame-section-head">
        <h3 id={heading} className="frame-section-title">
          {section.collapsible ? (
            <button type="button" className="frame-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              {title}
              <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
            </button>
          ) : title}
        </h3>
        {section.actions && <div className="frame-section-actions">{section.actions()}</div>}
      </div>
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
