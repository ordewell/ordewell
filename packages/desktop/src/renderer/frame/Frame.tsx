import { useEffect, useRef, type DragEvent, type RefObject } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@ordewell/ui/design';
import type { DaemonStatus } from '../../shared/bridge';
import { ActivityBar } from './ActivityBar';
import { Banners } from './Banners';
import { CommandPalette } from './CommandPalette';
import { isMac, matchesChord, parseChord } from './keys';
import { paneSizes, shown } from './layout';
import { PlanPanel, PlanRail } from './PlanPanel';
import { FOCUSABLE } from './Popover';
import { Sash } from './Sash';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TabArea } from './TabArea';
import { TitleBar } from './TitleBar';
import { useFrameState, useFrameStore, type FrameStore } from './store';
import type { Layout } from './layout';

/** Runs the command a key chord is bound to; a chord the focused control already handled is left alone. */
function useShortcuts(store: FrameStore): void {
  useEffect(() => {
    const mac = isMac(store.platform);
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || store.getSnapshot().overlay === 'palette') return;
      if (event.key === 'Escape' && !store.getSnapshot().overlay && store.getSnapshot().layout.drawer) {
        event.preventDefault();
        store.dispatch({ type: 'closeDrawer' });
        return;
      }
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
 * A drawer is a layer over the centre (design.md, Keyboard): it takes focus
 * when it opens, and gives it back to where it was when it closes.
 */
function useDrawerFocus(drawer: Layout['drawer'], center: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = center.current?.querySelector<HTMLElement>('.frame-drawer');
    [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((element) => element.checkVisibility?.() ?? true)?.focus();
    return () => {
      const now = document.activeElement;
      // Only when focus was inside: a click elsewhere has already put it where the user wanted.
      if (opener?.isConnected && (!now || now === document.body || panel?.contains(now))) opener.focus();
    };
  }, [drawer, center]);
}

/** The window's size drives the collapse order (layout.ts, fit), so the layout hears every resize. */
function useViewport(store: FrameStore): void {
  useEffect(() => {
    const onResize = (): void => store.dispatch({ type: 'viewport', viewport: { width: window.innerWidth, height: window.innerHeight } });
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [store]);
}

/** Said for a drop of several files, as Welcome says it. */
const DROP_ONE = 'Drop one folder.';

/**
 * A folder dropped anywhere on the window goes to main, which opens it as the
 * File menu would: focus its window, switch this one, or ask first when work
 * is live here (ADR-0063 H6). A drop a tab or a view already took is theirs.
 */
function useFolderDrop(store: FrameStore): { onDragOver(event: DragEvent): void; onDrop(event: DragEvent): void } {
  const refuse = (message: string): void => {
    const title = 'Could not open the folder';
    const dismiss = store.api.showBanner({ id: 'folder-drop', tone: 'warning', title, body: message, actions: [{ label: 'Dismiss', run: () => dismiss() }] });
    store.api.announce(`${title}: ${message}`);
  };
  const files = (event: DragEvent): boolean => !event.defaultPrevented && Array.from(event.dataTransfer.types).includes('Files');
  return {
    onDragOver(event) {
      if (!files(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop(event) {
      if (!files(event)) return;
      event.preventDefault();
      const dropped = event.dataTransfer.files;
      const file = dropped.length === 1 ? dropped.item(0) : null;
      if (!file) { refuse(DROP_ONE); return; }
      void store.projects.openDropped(file).then(
        (result) => { if (!result.ok) refuse(result.message ?? 'Only a folder can be opened.'); },
        (err: unknown) => refuse(err instanceof Error ? err.message : String(err)),
      );
    },
  };
}

function Terminal(): JSX.Element {
  const store = useFrameStore();
  const { panels, layout } = useFrameState();
  const views = panels.filter((panel) => panel.region === 'terminal');
  return (
    <section className="frame-panel-terminal" aria-label="Terminal" data-region="terminal" style={{ height: paneSizes(layout).terminal }}>
      {views.length === 0 ? <p className="frame-empty">Nothing here yet.</p> : views.map((view) => <div key={view.id} className="frame-panel-view">{view.render()}</div>)}
      <IconButton
        className="frame-terminal-hide"
        icon={X}
        label="Hide terminal"
        title="Hide terminal (Ctrl+`)"
        onClick={() => store.dispatch({ type: 'toggleTerminal', open: false })}
      />
    </section>
  );
}

/**
 * The workspace window (design.md, Layout): title bar; activity bar and the
 * sidebar it picks; the centre, whose first tab is the planner's
 * conversation, with the terminal below it; the plan panel on the right; the
 * status bar. Each is a landmark, in the order F6 reaches them. A panel the
 * window is too narrow to dock opens as a drawer over the centre instead.
 */
export function Frame({ daemon }: { daemon: DaemonStatus | undefined }): JSX.Element {
  const store = useFrameStore();
  const { layout, overlay, announcement, readOnly } = useFrameState();
  useShortcuts(store);
  useViewport(store);
  const center = useRef<HTMLDivElement>(null);
  useDrawerFocus(layout.drawer, center);
  const drop = useFolderDrop(store);
  const docked = shown(layout);
  const closeDrawer = (): void => store.dispatch({ type: 'closeDrawer' });

  return (
    <div className="frame" onDragOver={drop.onDragOver} onDrop={drop.onDrop}>
      <TitleBar />
      <Banners />
      <div className="frame-body" {...(readOnly ? { inert: '' } : {})}>
        <ActivityBar />
        {docked.sidebar && (
          <>
            <Sidebar />
            <Sash pane="sidebar" label="Resize sidebar" grows="right" />
          </>
        )}
        <div className="frame-center" ref={center}>
          <main className="frame-main" aria-label="Centre" data-region="main">
            <TabArea />
          </main>
          {layout.terminalOpen && (
            <>
              <Sash pane="terminal" label="Resize terminal" grows="up" />
              <Terminal />
            </>
          )}
          {layout.drawer && <div className="frame-drawer-scrim" aria-hidden="true" onClick={closeDrawer} />}
          {layout.drawer === 'sidebar' && <Sidebar drawer />}
          {layout.drawer === 'plan' && <PlanPanel drawer />}
        </div>
        {docked.plan ? (
          <>
            <Sash pane="plan" label="Resize plan panel" grows="left" />
            <PlanPanel />
          </>
        ) : <PlanRail />}
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
