import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconComponent } from './Icon';

export interface TabItem {
  id: string;
  label: string;
  icon?: IconComponent;
  /** A count after the label, tabular in a box sized for three digits. */
  count?: number;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  active: string;
  onSelect: (id: string) => void;
  /** What the tabs switch between, for a screen reader. */
  label: string;
  /** The id of the panel the tabs control; each tab names it. */
  panelId?: string;
  /** Anything after the tabs in the same 36px band, such as a close or an overflow button. */
  trailing?: ReactNode;
  className?: string;
}

/**
 * A strip of tabs in the 36px band. Arrow keys move between them and select,
 * Home and End go to the ends; only the active tab is in the Tab order.
 */
export function Tabs({ tabs, active, onSelect, label, panelId, trailing, className }: TabsProps): JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = event.key === 'ArrowRight' ? index + 1
      : event.key === 'ArrowLeft' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    onSelect(next.id);
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
  };
  return (
    <div className={['ow-tabs', className].filter(Boolean).join(' ')}>
      <div ref={strip} role="tablist" aria-label={label} className="ow-tabs-list">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className={['ow-tab', selected ? 'ow-tab-active' : ''].filter(Boolean).join(' ')}
              title={tab.label}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => move(event, index)}
            >
              {tab.icon && <Icon icon={tab.icon} size={16} />}
              <span className="ow-tab-label">{tab.label}</span>
              {tab.count !== undefined && <span className="ow-count">{tab.count}</span>}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
