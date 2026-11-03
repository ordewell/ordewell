import { useEffect } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@ordewell/ui/design';
import type { DaemonStatus } from '../../shared/bridge';
import { ActivityBar } from './ActivityBar';
import { Banners } from './Banners';
import { CommandPalette } from './CommandPalette';
import { isMac, matchesChord, parseChord } from './keys';
import { Sash } from './Sash';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TabArea } from './TabArea';
import { TitleBar } from './TitleBar';
import { useFrameState, useFrameStore, type FrameStore } from './store';

const PANEL_NAMES = { right: 'Planner', bottom: 'Terminal' } as const;

function Panel({ region }: { region: 'right' | 'bottom' }): JSX.Element {
  const store = useFrameStore();
  const { panels, layout } = useFrameState();
  const views = panels.filter((panel) => panel.region === region);
  const title = views[0]?.title ?? PANEL_NAMES[region];
  const size = region === 'right' ? { width: layout.sizes.right } : { height: layout.sizes.bottom };
  const Landmark = region === 'right' ? 'aside' : 'section';
  return (
    <Landmark className={`frame-panel frame-panel-${region}`} aria-label={title} data-region={region} style={size}>
      <div className="frame-panel-head">
        <h1 className="frame-pane-title">{title}</h1>
        <IconButton
          icon={X}
          label={`Hide ${title.toLowerCase()}`}
          onClick={() => store.dispatch({ type: 'togglePanel', panel: region, open: false })}
        />
      </div>
      <div className="frame-panel-body">
        {views.length === 0 ? <p className="frame-empty">Nothing here yet.</p> : views.map((view) => <div key={view.id}>{view.render()}</div>)}
      </div>
    </Landmark>
  );
}

/** Runs the command a key chord is bound to; a chord the focused control already handled is left alone. */
function useShortcuts(store: FrameStore): void {
  useEffect(() => {
    const mac = isMac(store.platform);
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || store.getSnapshot().overlay === 'palette') return;
      const command = store.enabledCommands().find((candidate) => candidate.keys && matchesChord(parseChord(candidate.keys), event, mac));
      if (!command) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
}

/**
 * The workspace window: title bar, activity bar and sidebar, the tabbed editor,
 * the planner on the right and the terminal below, the status bar. Each is a
 * landmark, in the order the keyboard reaches them.
 */
export function Frame({ daemon }: { daemon: DaemonStatus | undefined }): JSX.Element {
  const store = useFrameStore();
  const { layout, overlay, announcement, readOnly } = useFrameState();
  useShortcuts(store);

  return (
    <div className="frame">
      <TitleBar />
      <Banners />
      <div className="frame-body" {...(readOnly ? { inert: '' } : {})}>
        <ActivityBar />
        {layout.sidebarOpen && (
          <>
            <Sidebar />
            <Sash pane="sidebar" label="Resize sidebar" grows="right" />
          </>
        )}
        <div className="frame-center">
          <main className="frame-main" aria-label="Editor">
            <TabArea />
          </main>
          {layout.bottomOpen && (
            <>
              <Sash pane="bottom" label="Resize terminal" grows="up" />
              <Panel region="bottom" />
            </>
          )}
        </div>
        {layout.rightOpen && (
          <>
            <Sash pane="right" label="Resize planner" grows="left" />
            <Panel region="right" />
          </>
        )}
      </div>
      <StatusBar daemon={daemon} />
      {overlay === 'palette' && <CommandPalette />}
      <div className="frame-live" role="status" aria-live="polite" aria-atomic="true">
        {/* A zero-width space on alternate messages, so a repeat is a change a screen reader says again. */}
        {announcement.text && `${announcement.text}${announcement.serial % 2 ? '​' : ''}`}
      </div>
    </div>
  );
}
