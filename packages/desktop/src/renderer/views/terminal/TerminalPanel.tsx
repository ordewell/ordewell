import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ChevronDown, CircleAlert, Plus, SquareTerminal, X } from 'lucide-react';
import { EmptyState, IconButton } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { Popover } from '../../frame/Popover';
import { setLoginTerminalOpener } from '../../session/loginTerminal';
import { folderIsView, optionsFor, viewRepos, type ScopeState } from '../scope/scopeStore';
import { useScope } from '../scope/useScope';
import { bannerFor, decisionFor, tabTitle, terminalStoreFor, type TerminalStore, type TerminalTab } from './terminalStore';
import { all } from '../Stub';
import './terminal.css';

const REFRESH_AFTER_MS = 400;

/**
 * Keeps the scope store's tasks current while the panel is open: the rule that
 * disables a task's worktree reads whether the task is running, and nothing
 * else refreshes that between daemon connections. The session's stream says
 * when anything changed; the read behind it is debounced.
 */
function useSessionWatch(api: FrameApi): void {
  const { store, state } = useScope(api);
  const sessionId = state.session?.sessionId;
  useEffect(() => {
    if (!sessionId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.ordewell.daemon.subscribe(sessionId, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void store.refresh(); }, REFRESH_AFTER_MS);
    });
    return () => { clearTimeout(timer); off(); };
  }, [store, sessionId]);
}

function repoLabel(repo: string, scopes: ScopeState): string {
  if (repo !== '.') return repo;
  return folderIsView(scopes) ? 'Workspace folder' : 'Workspace';
}

function NewTerminalMenu({ scopes, terminals, anchor, onClose }: {
  scopes: ScopeState;
  terminals: TerminalStore;
  anchor: React.RefObject<HTMLButtonElement>;
  onClose(): void;
}): JSX.Element {
  const repos = viewRepos(scopes);
  const multi = repos.length > 1;
  return (
    <Popover label="Open a terminal in" anchor={anchor} role="menu" className="frame-menu terminal-menu" onClose={onClose}>
      {repos.map((repo) => (
        <div key={repo} role="group" aria-label={multi ? repoLabel(repo, scopes) : 'Scopes'}>
          {multi && <p className="terminal-menu-repo">{repoLabel(repo, scopes)}</p>}
          <ul>
            {optionsFor(scopes, repo).map((option) => {
              const decision = decisionFor(option.scope, scopes);
              const reason = decision.ok ? undefined : decision.reason;
              return (
                <li key={`${option.label}:${option.detail ?? ''}`}>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!decision.ok}
                    // A disabled button gets no hover or focus, so the reason is also in the accessible description.
                    title={reason}
                    aria-description={reason}
                    onClick={() => { onClose(); void terminals.open(option.scope, repo); }}
                  >
                    <span>{option.label}</span>
                    {option.detail && <span className="terminal-menu-detail">{option.detail}</span>}
                    {reason && <span className="terminal-menu-reason">{reason}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Popover>
  );
}

function TabLabel({ tab, renaming, onRename, onDone }: {
  tab: TerminalTab;
  renaming: boolean;
  onRename(name: string): void;
  onDone(): void;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) { input.current?.focus(); input.current?.select(); } }, [renaming]);
  if (!renaming) {
    return (
      <>
        <span className="terminal-tab-name">{tabTitle(tab)}</span>
        {tab.scopeLabel !== tabTitle(tab) && <span className="terminal-tab-scope">{tab.scopeLabel}</span>}
        {(tab.phase === 'exited' || tab.phase === 'failed') && <span className={`terminal-tab-state terminal-tab-state-${tab.phase}`}>{tab.phase === 'failed' ? 'failed' : 'exited'}</span>}
      </>
    );
  }
  return (
    <input
      ref={input}
      className="terminal-tab-input"
      aria-label="Terminal name"
      defaultValue={tabTitle(tab)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') { onRename(event.currentTarget.value); onDone(); }
        else if (event.key === 'Escape') onDone();
      }}
      onBlur={(event) => { onRename(event.currentTarget.value); onDone(); }}
    />
  );
}

function TerminalPanel({ api }: { api: FrameApi }): JSX.Element {
  const terminals = terminalStoreFor(api);
  const state = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
  const { store: scopeStore, state: scopes } = useScope(api);
  useSessionWatch(api);
  const host = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const active = state.tabs.find((tab) => tab.key === state.active);
  const banner = bannerFor(active, scopes);

  // The terminals outlive this component; it only lends them its element.
  useLayoutEffect(() => {
    terminals.setHost(host.current);
    return () => terminals.setHost(null);
  }, [terminals]);
  useEffect(() => { terminals.ensureOne(); }, [terminals]);
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => terminals.fit());
    observer.observe(element);
    return () => observer.disconnect();
  }, [terminals]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => terminals.restyle();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [terminals]);

  // Said once, when a task starts in the worktree this terminal is in.
  const announced = useRef<string>();
  useEffect(() => {
    if (banner && announced.current !== banner) api.announce(banner);
    announced.current = banner;
  }, [api, banner]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, tab: TerminalTab, at: number): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = step ? state.tabs[(at + step + state.tabs.length) % state.tabs.length] : undefined;
    if (next) {
      event.preventDefault();
      terminals.select(next.key);
      requestAnimationFrame(() => document.getElementById(`terminal-tab-${next.key}`)?.focus());
    } else if (event.key === 'F2') {
      event.preventDefault();
      setRenaming(tab.key);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      terminals.close(tab.key);
    }
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-head">
        <div className="terminal-tabs" role="tablist" aria-label="Terminals">
          {state.tabs.map((tab, at) => {
            const selected = tab.key === state.active;
            return (
              <div
                key={tab.key}
                id={`terminal-tab-${tab.key}`}
                className={['terminal-tab', selected ? 'terminal-tab-active' : '', tab.phase === 'exited' || tab.phase === 'failed' ? 'terminal-tab-ended' : ''].filter(Boolean).join(' ')}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={`${tabTitle(tab)} · ${tab.scopeLabel} (double-click or F2 to rename)`}
                onClick={() => terminals.select(tab.key)}
                onDoubleClick={() => setRenaming(tab.key)}
                onAuxClick={(event) => { if (event.button === 1) terminals.close(tab.key); }}
                onKeyDown={(event) => onKeyDown(event, tab, at)}
              >
                <TabLabel
                  tab={tab}
                  renaming={renaming === tab.key}
                  onRename={(name) => terminals.rename(tab.key, name)}
                  onDone={() => { setRenaming(undefined); terminals.focus(); }}
                />
                <IconButton
                  icon={X}
                  size={14}
                  label={`Close ${tabTitle(tab)} (${tab.scopeLabel})`}
                  className="terminal-tab-close"
                  tabIndex={-1}
                  onClick={(event) => { event.stopPropagation(); terminals.close(tab.key); }}
                />
              </div>
            );
          })}
        </div>
        <IconButton icon={Plus} label="New terminal in your checkout" onClick={() => { void terminals.open({ kind: 'checkout' }); }} />
        <IconButton
          ref={menuButton}
          icon={ChevronDown}
          label="Open a terminal in another scope"
          className="terminal-menu-button"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => { setMenu((was) => !was); void scopeStore.refresh(); }}
        />
        {menu && <NewTerminalMenu scopes={scopes} terminals={terminals} anchor={menuButton} onClose={() => setMenu(false)} />}
      </div>
      {banner && <p className="terminal-banner" role="status">{banner}</p>}
      {api.platform === 'darwin' && active && <p className="terminal-banner" id="terminal-word-keys">Option+Left/Right is temporarily unavailable in the terminal.</p>}
      <div className="terminal-stage">
        <div className="terminal-host" ref={host} role="tabpanel" aria-describedby={api.platform === 'darwin' && active ? 'terminal-word-keys' : undefined} aria-label={active ? `${tabTitle(active)}, ${active.scopeLabel}` : 'Terminal'} hidden={!active || active.phase === 'failed'} />
        {active?.phase === 'failed' && <p className="terminal-failed" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{active.message}</span></p>}
        {!active && <EmptyState className="terminal-empty" icon={SquareTerminal} title="No terminal is open" body="The plus button opens one in your checkout. Ctrl+` shows or hides this panel." />}
      </div>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const terminals = terminalStoreFor(api);
  // A login the session host asks for becomes a tab in the panel, whose pty main runs.
  setLoginTerminalOpener((runner, label) => terminals.openLogin(runner, label));
  return all(
    api.registerPanel({ region: 'terminal', id: 'terminal', title: 'Terminal', render: () => <TerminalPanel api={api} /> }),
    () => setLoginTerminalOpener(undefined),
  );
}
