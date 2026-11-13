import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Folder } from 'lucide-react';
import { Icon } from '@ordewell/ui/design';
import type { RecentWorkspace } from '../../shared/bridge';
import { middleEllipsis } from '../welcome/model';
import { formatChord, isMac, parseChord } from './keys';
import { onMenuKey, Popover } from './Popover';
import { useFrameState, useFrameStore } from './store';

export function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The File menu's chord: main's accelerator owns it, so the frame only names it. */
const OPEN_FOLDER_KEYS = 'Mod+O';

interface Destination extends RecentWorkspace {
  /** What assistive technology reads: the name alone, or with its path where another folder shares the name. */
  spoken: string;
}

/** Where the switcher can go: not this window's own folder, and not a folder that is gone. */
function destinations(recents: readonly RecentWorkspace[], here: string): Destination[] {
  const others = recents.filter((entry) => !entry.missing && entry.path !== here);
  const shared = new Set(others.map((entry) => entry.name).filter((name, i, names) => names.indexOf(name) !== i));
  // Two folders with one name are told apart by their paths, as the File menu does. The row already shows the
  // path beside the name, so only the spoken name carries it: printing it in both put the path on screen twice.
  return others.map((entry) => ({ ...entry, spoken: shared.has(entry.name) ? `${entry.name} — ${entry.displayPath}` : entry.name }));
}

/**
 * The project name at the head of the title bar, as a menu button: the recent
 * folders, Open Folder… and whether a choice opens a new window. Main decides
 * what a choice does (ADR-0063 H6), so this only says which folder.
 */
export function ProjectSwitcher(): JSX.Element {
  const store = useFrameStore();
  const { overlay } = useFrameState();
  const { projects } = store;
  const here = store.api.workspace;
  const button = useRef<HTMLButtonElement>(null);
  const [recents, setRecents] = useState<readonly RecentWorkspace[]>();
  // Kept while the window lives: someone who opens projects side by side opens several.
  const [newWindow, setNewWindow] = useState(false);
  const open = overlay === 'project';
  const name = workspaceName(here);

  useEffect(() => {
    let live = true;
    const load = (): void => { void projects.recents().then((list) => { if (live) setRecents(list); }); };
    load();
    const off = projects.onRecentsChange(load);
    return () => { live = false; off(); };
  }, [projects]);

  const close = (): void => store.setOverlay(undefined);
  const choose = (path: string | undefined, beside = false): void => {
    close();
    projects.open(path, { newWindow: newWindow || beside });
  };
  const mac = isMac(store.platform);
  const besideKey = mac ? 'Meta' : 'Control';
  const isBeside = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => (mac ? event.metaKey : event.ctrlKey);
  const shown = destinations(recents ?? [], here);
  const keys = formatChord(parseChord(OPEN_FOLDER_KEYS), isMac(store.platform));

  return (
    <div className="frame-title-anchor frame-project">
      <button
        ref={button}
        type="button"
        className="frame-project-switcher"
        aria-label={`${name}, Switch project`}
        title={here}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => store.setOverlay(open ? undefined : 'project')}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          store.setOverlay('project');
        }}
      >
        <Icon icon={Folder} size={14} className="frame-project-icon" />
        <span className="frame-project-name">{name}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      {/* Drawn once the list is in, so focus lands on its first folder rather than below it. */}
      {open && recents && (
        <Popover label="Switch project" anchor={button} onClose={close} className="frame-menu frame-project-menu">
          <ul role="menu" aria-label="Switch project" onKeyDown={onMenuKey}>
            <li role="presentation" className="frame-menu-heading">Recent</li>
            {shown.length === 0 && <li role="presentation" className="frame-menu-empty">No other recent folders</li>}
            {shown.map((entry) => (
              <li key={entry.path} role="none">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={entry.spoken}
                  title={entry.path}
                  aria-keyshortcuts={`${besideKey}+Enter`}
                  onClick={(event) => choose(entry.path, isBeside(event))}
                  // The browser's own Enter-click is skipped for the chord: the modifier is read here, once.
                  onKeyDown={(event) => { if (event.key === 'Enter' && isBeside(event)) { event.preventDefault(); choose(entry.path, true); } }}
                >
                  <span className="frame-project-entry">{entry.name}</span>
                  {/* A middle ellipsis keeps both ends: two same-named folders differ in the parent, the end is the name. */}
                  <span className="frame-menu-hint">{middleEllipsis(entry.displayPath)}</span>
                </button>
              </li>
            ))}
            <li role="separator" className="frame-menu-separator" />
            <li role="none">
              <button type="button" role="menuitem" aria-label="Open Folder…" aria-keyshortcuts={isMac(store.platform) ? 'Meta+O' : 'Control+O'} onClick={() => choose(undefined)}>
                <span className="frame-project-entry">Open Folder…</span>
                <kbd className="frame-menu-hint">{keys}</kbd>
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitemcheckbox" aria-checked={newWindow} onClick={() => setNewWindow(!newWindow)}>
                <span className="frame-menu-check" aria-hidden="true">{newWindow && <Icon icon={Check} size={14} />}</span>
                <span className="frame-project-entry">Open in new window</span>
              </button>
            </li>
            {shown.length > 0 && (
              <li role="presentation" className="frame-menu-empty">
                {mac ? '⌘' : 'Ctrl'}-click to open in a new window
              </li>
            )}
          </ul>
        </Popover>
      )}
    </div>
  );
}
