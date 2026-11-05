import { useRef, type KeyboardEvent } from 'react';
import { ChevronRight, Ellipsis } from 'lucide-react';
import { Button, Icon, IconButton, NeedsYouGlyph } from '@ordewell/ui/design';
import { formatChord, isMac, parseChord } from './keys';
import { Popover } from './Popover';
import { slotsFor, useFrameState, useFrameStore } from './store';

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The ⋯ menu: arrow keys move between its items, as a menu's do. */
function onMenuKey(event: KeyboardEvent<HTMLDivElement>): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter((item) => item.offsetParent !== null || item === document.activeElement);
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[(at + step + items.length) % items.length]?.focus();
}

/**
 * The window's top row, drawn under the native controls (chrome.ts), laid out
 * on its own so no panel's width moves it (design.md, Title bar priority):
 * breadcrumb and scope on the left, then Needs you, the one primary action and
 * `⋯`, which never give way. As the bar narrows, the breadcrumb's segments and
 * then the scope leave it for `⋯`, by container queries in frame.css.
 */
export function TitleBar(): JSX.Element {
  const store = useFrameStore();
  const state = useFrameState();
  const { needsYou, primary, overlay, commands, readOnly } = state;
  const needsYouButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const mac = isMac(store.platform);
  const more = store.enabledCommands().filter((command) => command.more);
  const needsYouViews = slotsFor(state, 'popover.needsYou');
  const breadcrumbs = slotsFor(state, 'title.breadcrumb');
  const scopes = slotsFor(state, 'title.scope');
  const close = (): void => store.setOverlay(undefined);
  const keysOf = (id: string): string => {
    const keys = commands.find((command) => command.id === id)?.keys;
    return keys ? ` (${formatChord(parseChord(keys), mac)})` : '';
  };
  const name = workspaceName(store.api.workspace);
  const goTo = (activity: 'explorer' | 'git'): void => { close(); store.api.showActivity(activity); };

  return (
    <header className={`frame-title ${mac ? 'frame-title-mac' : 'frame-title-overlay'}`} data-region="title">
      <div className="frame-title-row">
        <nav className="frame-breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li className="frame-crumb-workspace" title={store.api.workspace}>{name}</li>
            {breadcrumbs.map((view) => (
              <li key={view.id} className="frame-crumb">
                <Icon icon={ChevronRight} size={12} />
                {view.render()}
              </li>
            ))}
          </ol>
        </nav>
        {scopes.map((view) => <div key={view.id} className="frame-title-slot frame-title-scope">{view.render()}</div>)}
        <div className="frame-title-drag" />
        <div className="frame-title-anchor">
          <button
            ref={needsYouButton}
            type="button"
            className={['frame-chip', 'frame-needs-you-button', needsYou > 0 ? 'frame-needs-attention' : ''].filter(Boolean).join(' ')}
            aria-label={needsYou > 0 ? `Needs you, ${needsYou}` : 'Needs you'}
            title={`Needs you${keysOf('needsYou.open')}`}
            aria-haspopup="dialog"
            aria-expanded={overlay === 'needsYou'}
            onClick={() => store.setOverlay(overlay === 'needsYou' ? undefined : 'needsYou')}
          >
            <Icon icon={NeedsYouGlyph} size={16} />
            {needsYou > 0 && <span className="frame-needs-you-count">{needsYou}</span>}
            {needsYou > 0 && <span className="frame-needs-you-word">Needs you</span>}
          </button>
          {overlay === 'needsYou' && (
            <Popover label="Needs you" anchor={needsYouButton} onClose={close} className="frame-needs-you">
              <h2 className="frame-section-title">Needs you</h2>
              {needsYouViews.length === 0 ? <p className="frame-empty">Nothing needs you.</p> : needsYouViews.map((view) => <div key={view.id}>{view.render()}</div>)}
            </Popover>
          )}
        </div>
        {primary && (
          <Button
            variant="primary"
            className="frame-primary"
            icon={primary.icon}
            // The title bar sits outside the inert body, so it stops itself while the daemon is away: disabled, not hidden (W15).
            disabled={primary.disabled || readOnly}
            title={`${primary.label}${keysOf('primary.run')}`}
            onClick={() => primary.run()}
          >
            {primary.label}
          </Button>
        )}
        <div className="frame-title-anchor">
          <IconButton
            ref={moreButton}
            icon={Ellipsis}
            label="More actions"
            aria-haspopup="menu"
            aria-expanded={overlay === 'more'}
            active={overlay === 'more'}
            onClick={() => store.setOverlay(overlay === 'more' ? undefined : 'more')}
          />
          {overlay === 'more' && (
            <Popover label="More actions" anchor={moreButton} onClose={close} className="frame-menu frame-more">
              <div onKeyDown={onMenuKey}>
                {scopes.length > 0 && (
                  // Only drawn once the bar has no room for the scope switcher (frame.css).
                  <div className="frame-more-scope" role="group" aria-label="View scope">
                    {scopes.map((view) => <div key={view.id}>{view.render()}</div>)}
                  </div>
                )}
                <ul role="menu" aria-label="More actions">
                  <li role="presentation" className="frame-menu-heading">Go to</li>
                  <li role="none">
                    <button type="button" role="menuitem" title={store.api.workspace} onClick={() => goTo('explorer')}>
                      {name} in Explorer
                    </button>
                  </li>
                  {breadcrumbs.length > 0 && (
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => goTo('git')}>Repository and branch in Git</button>
                    </li>
                  )}
                  {more.length > 0 && <li role="separator" className="frame-menu-separator" />}
                  {more.map((command) => (
                    <li key={command.id} role="none">
                      <button type="button" role="menuitem" onClick={() => { close(); command.run(); }}>{command.title}</button>
                    </li>
                  ))}
                </ul>
              </div>
            </Popover>
          )}
        </div>
      </div>
    </header>
  );
}
