import { type DragEvent, type KeyboardEvent } from 'react';
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
      <div className="frame-tabs" role="tablist" aria-label={index === 0 ? 'Editor tabs' : 'Editor tabs, right group'}>
        {group.tabs.map((tab, at) => {
          const selected = tab.key === group.active;
          const Kind = tabKinds[tab.kind]?.icon;
          return (
            <div
              key={tab.key}
              id={domId(index, tab.key, 'tab')}
              className={['frame-tab', selected ? 'frame-tab-active' : '', tab.preview ? 'frame-tab-preview' : ''].filter(Boolean).join(' ')}
              role="tab"
              aria-selected={selected}
              aria-controls={domId(index, tab.key, 'panel')}
              tabIndex={selected ? 0 : -1}
              title={tab.preview ? `${tab.title} (preview: double-click to keep)` : tab.title}
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
                  size={12}
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

function TabPanel({ group, index }: { group: TabGroup; index: number }): JSX.Element {
  const { tabKinds } = useFrameState();
  const tab = activeTab(group);
  if (!tab) return <div className="frame-tabpanel frame-empty">No tab is open.</div>;
  const kind = tabKinds[tab.kind];
  return (
    <div
      key={tab.key}
      id={domId(index, tab.key, 'panel')}
      className="frame-tabpanel"
      role="tabpanel"
      aria-labelledby={domId(index, tab.key, 'tab')}
      tabIndex={-1}
    >
      {kind ? kind.render(tab) : <p className="frame-empty">Nothing draws a {tab.kind} tab yet.</p>}
    </div>
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
          <TabPanel group={group} index={index} />
        </div>
      ))}
    </div>
  );
}
