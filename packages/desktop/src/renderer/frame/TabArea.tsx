import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type WheelEvent } from 'react';
import { Columns2, X } from 'lucide-react';
import { Icon, IconButton } from '@ordewell/ui/design';
import { isMac } from './keys';
import { activeTab, type Tab, type TabGroup } from './layout';
import { useFrameState, useFrameStore } from './store';

const DRAG_TYPE = 'application/x-ordewell-tab';

/** DOM ids can't hold a tab key's colons and slashes as they are. */
function domId(group: number, key: string, part: 'tab' | 'panel'): string {
  return `frame-${part}-${group}-${encodeURIComponent(key).replace(/%/g, '_')}`;
}

function TabStrip({ group, index }: { group: TabGroup; index: number }): JSX.Element {
  const store = useFrameStore();
  const { tabKinds } = useFrameState();
  const mac = isMac(store.platform);

  const focusTab = (key: string): void => {
    requestAnimationFrame(() => document.getElementById(domId(index, key, 'tab'))?.focus());
  };

  // The strip scrolls with no scrollbar: a tab opened past its edge, or left past it as the strip narrows, is brought
  // into view, or it would be selected unseen. Each edge with tabs past it fades, and a wheel scrolls it.
  const strip = useRef<HTMLDivElement>(null);
  const [past, setPast] = useState({ start: false, end: false });
  const measure = useCallback((): void => {
    const element = strip.current;
    if (!element) return;
    const start = element.scrollLeft > 0;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setPast((seen) => (seen.start === start && seen.end === end ? seen : { start, end }));
  }, []);
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    // A mouse wheel only says up and down; the strip only goes sideways.
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
  };
  useEffect(() => {
    const reveal = (): void => {
      if (group.active) document.getElementById(domId(index, group.active, 'tab'))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      measure();
    };
    reveal();
    if (!strip.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reveal);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [group.active, group.tabs.length, index, measure]);

  // The tablist's keys (WAI-ARIA tabs, automatic activation), plus the editor's
  // own: Enter keeps a preview, Delete closes, Mod+Shift+arrows move the tab.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, tab: Tab, at: number): void => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step && mod && event.shiftKey) {
      event.preventDefault();
      store.dispatch({ type: 'move', group: index, key: tab.key, to: at + step });
      focusTab(tab.key);
      return;
    }
    let next: Tab | undefined;
    if (step) next = group.tabs[(at + step + group.tabs.length) % group.tabs.length];
    else if (event.key === 'Home') next = group.tabs[0];
    else if (event.key === 'End') next = group.tabs[group.tabs.length - 1];
    if (next) {
      event.preventDefault();
      store.dispatch({ type: 'activate', group: index, key: next.key });
      focusTab(next.key);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      store.dispatch({ type: 'keep', group: index, key: tab.key });
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && !tab.fixed) {
      event.preventDefault();
      const neighbour = group.tabs[at + 1] ?? group.tabs[at - 1];
      store.dispatch({ type: 'close', group: index, key: tab.key });
      if (neighbour) focusTab(neighbour.key);
    }
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>, tab: Tab): void => {
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ group: index, key: tab.key }));
    event.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (event: DragEvent<HTMLDivElement>, at: number): void => {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    const dragged: unknown = JSON.parse(raw);
    if (typeof dragged !== 'object' || dragged === null) return;
    const { group: from, key } = dragged as { group?: unknown; key?: unknown };
    if (from === index && typeof key === 'string') store.dispatch({ type: 'move', group: index, key, to: at });
  };

  return (
    <div className="frame-tabs-head">
      <div
        className={['frame-tabs', past.start ? 'frame-tabs-past-start' : '', past.end ? 'frame-tabs-past-end' : ''].filter(Boolean).join(' ')}
        ref={strip}
        role="tablist"
        aria-label={index === 0 ? 'Editor tabs' : 'Editor tabs, right group'}
        onScroll={measure}
        onWheel={onWheel}
      >
        {group.tabs.map((tab, at) => {
          const selected = tab.key === group.active;
          const Kind = tabKinds[tab.kind]?.icon;
          return (
            <div
              key={tab.key}
              id={domId(index, tab.key, 'tab')}
              className={['frame-tab', selected ? 'frame-tab-active' : '', tab.preview ? 'frame-tab-preview' : '', tab.fixed ? 'frame-tab-fixed' : ''].filter(Boolean).join(' ')}
              data-tab-kind={tab.kind}
              role="tab"
              aria-selected={selected}
              aria-controls={domId(index, tab.key, 'panel')}
              tabIndex={selected ? 0 : -1}
              title={tab.preview ? `${tab.title} (preview: double-click to keep)` : tab.fixed ? `${tab.title} (pinned)` : tab.title}
              draggable={!tab.fixed}
              onClick={() => store.dispatch({ type: 'activate', group: index, key: tab.key })}
              onDoubleClick={() => store.dispatch({ type: 'keep', group: index, key: tab.key })}
              onAuxClick={(event) => { if (event.button === 1 && !tab.fixed) store.dispatch({ type: 'close', group: index, key: tab.key }); }}
              onKeyDown={(event) => onKeyDown(event, tab, at)}
              onDragStart={(event) => onDragStart(event, tab)}
              onDragOver={(event) => { if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault(); }}
              onDrop={(event) => onDrop(event, at)}
            >
              {Kind && <Icon icon={Kind} size={16} />}
              <span className="frame-tab-title">{tab.title}</span>
              {!tab.fixed && (
                <IconButton
                  icon={X}
                  size={14}
                  label={`Close ${tab.title}`}
                  className="frame-tab-close"
                  // Not a tab stop of its own: Delete closes the focused tab.
                  tabIndex={-1}
                  onClick={(event) => { event.stopPropagation(); store.dispatch({ type: 'close', group: index, key: tab.key }); }}
                />
              )}
            </div>
          );
        })}
      </div>
      <IconButton icon={Columns2} label="Split right" onClick={() => { store.dispatch({ type: 'focusGroup', group: index }); store.dispatch({ type: 'split' }); }} />
    </div>
  );
}

function TabPanel({ group, index, tab }: { group: TabGroup; index: number; tab: Tab }): JSX.Element {
  const { tabKinds } = useFrameState();
  const kind = tabKinds[tab.kind];
  const selected = tab.key === group.active;
  return (
    <div
      id={domId(index, tab.key, 'panel')}
      className="frame-tabpanel"
      role="tabpanel"
      aria-labelledby={domId(index, tab.key, 'tab')}
      data-tab-kind={tab.kind}
      hidden={!selected}
      tabIndex={-1}
    >
      {kind ? kind.render(tab) : <p className="frame-empty">Nothing draws a {tab.kind} tab yet.</p>}
    </div>
  );
}

/**
 * The active tab's panel. A fixed tab's stays drawn while another is shown, so
 * the planner keeps its draft, its scroll and its live stream across a look at
 * a task.
 */
function TabPanels({ group, index }: { group: TabGroup; index: number }): JSX.Element {
  const tab = activeTab(group);
  // One keyed list in tab order: a fixed tab's panel drawn apart from the
  // active one moved between React slots on every switch, and remounted.
  const drawn = group.tabs.filter((candidate) => candidate.fixed || candidate.key === tab?.key);
  return (
    <>
      {drawn.map((shown) => <TabPanel key={shown.key} group={group} index={index} tab={shown} />)}
      {!tab && <div className="frame-tabpanel frame-empty">No tab is open.</div>}
    </>
  );
}

/** The editor area: one tab group, or two side by side. */
export function TabArea(): JSX.Element {
  const store = useFrameStore();
  const { layout } = useFrameState();
  return (
    <div className="frame-groups">
      {layout.groups.map((group, index) => (
        <div
          key={index}
          className={['frame-group', index === layout.focusedGroup ? 'frame-group-focused' : ''].filter(Boolean).join(' ')}
          onFocusCapture={() => { if (store.getSnapshot().layout.focusedGroup !== index) store.dispatch({ type: 'focusGroup', group: index }); }}
        >
          <TabStrip group={group} index={index} />
          <TabPanels group={group} index={index} />
        </div>
      ))}
    </div>
  );
}
