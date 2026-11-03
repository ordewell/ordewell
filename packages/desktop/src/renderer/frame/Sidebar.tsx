import { activityTitle } from './commands';
import { useFrameState } from './store';

/** The sidebar of the chosen activity: the sections view modules registered for it, stacked. */
export function Sidebar(): JSX.Element {
  const { layout, sidebars } = useFrameState();
  const sections = sidebars.filter((section) => section.activity === layout.activity);
  const title = activityTitle(layout.activity);

  return (
    <aside className="frame-sidebar" aria-label={title} data-region="sidebar" style={{ width: layout.sizes.sidebar }}>
      <h1 className="frame-pane-title">{title}</h1>
      <div className="frame-sidebar-body">
        {sections.length === 0 && <p className="frame-empty">Nothing here yet.</p>}
        {sections.map((section) => {
          const heading = `sidebar-${section.activity}-${section.id}`;
          return (
            <section key={section.id} className="frame-sidebar-section" aria-labelledby={heading}>
              <h2 id={heading} className="frame-section-title">{section.title}</h2>
              {section.render()}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
