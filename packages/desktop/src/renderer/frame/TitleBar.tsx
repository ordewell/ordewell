import { useRef, type KeyboardEvent } from 'react';
import { ChevronRight, Ellipsis, PanelRight } from 'lucide-react';
import { Icon, IconButton, NeedsYouGlyph } from '@ordewell/ui/design';
import { formatChord, isMac, parseChord } from './keys';
import { Popover } from './Popover';
import { slotsFor, useFrameState, useFrameStore } from './store';

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The ⋯ menu: arrow keys move between its items, as a menu's do. */
function onMenuKey(event: KeyboardEvent<HTMLUListElement>): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[(at + step + items.length) % items.length]?.focus();
}

/**
 * The window's top row, drawn under the native controls (chrome.ts): the
 * breadcrumb and scope on the left, what needs the user and the one primary
 * action on the right. Only the empty stretch drags the window.
 */
export function TitleBar(): JSX.Element {
  const store = useFrameStore();
  const state = useFrameState();
  const { layout, needsYou, primary, overlay } = state;
  const needsYouButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const mac = isMac(store.platform);
  const more = store.enabledCommands().filter((command) => command.more);
  const needsYouViews = slotsFor(state, 'popover.needsYou');
  const close = (): void => store.setOverlay(undefined);
  const plannerKeys = state.commands.find((command) => command.id === 'planner.toggle')?.keys;

  return (
    <header className={`frame-title ${mac ? 'frame-title-mac' : 'frame-title-overlay'}`}>
      <nav className="frame-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li title={store.api.workspace}>{workspaceName(store.api.workspace)}</li>
          {slotsFor(state, 'title.breadcrumb').map((view) => (
            <li key={view.id}>
              <Icon icon={ChevronRight} size={12} />
              {view.render()}
            </li>
          ))}
        </ol>
      </nav>
      {slotsFor(state, 'title.scope').map((view) => <div key={view.id} className="frame-title-slot">{view.render()}</div>)}
      <div className="frame-title-drag" />
      <div className="frame-title-anchor">
        <IconButton
          ref={needsYouButton}
          icon={NeedsYouGlyph}
          label={needsYou > 0 ? `Needs you: ${needsYou}` : 'Needs you'}
          badge={needsYou > 0 ? needsYou : undefined}
          aria-haspopup="dialog"
          aria-expanded={overlay === 'needsYou'}
          active={overlay === 'needsYou'}
          onClick={() => store.setOverlay(overlay === 'needsYou' ? undefined : 'needsYou')}
        />
        {overlay === 'needsYou' && (
          <Popover label="Needs you" anchor={needsYouButton} onClose={close} className="frame-needs-you">
            <h2 className="frame-section-title">Needs you</h2>
            {needsYouViews.length === 0 ? <p className="frame-empty">Nothing needs you.</p> : needsYouViews.map((view) => <div key={view.id}>{view.render()}</div>)}
          </Popover>
        )}
      </div>
      {primary && (
        <button type="button" className="frame-primary" disabled={primary.disabled} onClick={() => primary.run()}>
          {primary.icon && <Icon icon={primary.icon} size={16} />}
          {primary.label}
        </button>
      )}
      <IconButton
        icon={PanelRight}
        label="Planner"
        title={`Planner${plannerKeys ? ` (${formatChord(parseChord(plannerKeys), mac)})` : ''}`}
        active={layout.rightOpen}
        aria-pressed={layout.rightOpen}
        onClick={() => store.api.runCommand('planner.toggle')}
      />
      {more.length > 0 && (
        <div className="frame-title-anchor">
          <IconButton
            ref={moreButton}
            icon={Ellipsis}
            label="More actions"
            aria-haspopup="menu"
            aria-expanded={overlay === 'more'}
            onClick={() => store.setOverlay(overlay === 'more' ? undefined : 'more')}
          />
          {overlay === 'more' && (
            <Popover label="More actions" anchor={moreButton} onClose={close} className="frame-menu">
              <ul role="menu" aria-label="More actions" onKeyDown={onMenuKey}>
                {more.map((command) => (
                  <li key={command.id} role="none">
                    <button type="button" role="menuitem" onClick={() => { close(); command.run(); }}>{command.title}</button>
                  </li>
                ))}
              </ul>
            </Popover>
          )}
        </div>
      )}
    </header>
  );
}
