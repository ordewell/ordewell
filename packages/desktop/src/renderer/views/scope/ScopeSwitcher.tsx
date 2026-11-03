import { useRef, useState } from 'react';
import { ViewScopeGlyph, Icon } from '@ordewell/ui/design';
import { ChevronDown } from 'lucide-react';
import type { FrameApi, Unregister, ViewScope } from '../../frame/api';
import { Popover } from '../../frame/Popover';
import { all } from '../Stub';
import { optionsFor, sameScope, scopeName, type ScopeState } from './scopeStore';
import { useScope } from './useScope';
import './scope.css';

/** A repo's path as the menu names it: `.` is the workspace's own. */
function repoLabel(repo: string): string {
  return repo === '.' ? 'Workspace' : repo;
}

/**
 * The view scope picker in the title bar (W8, ADR-0061 R2). Per repository in a
 * multi-repo workspace; the Explorer and the file tabs it opens follow it.
 */
function ScopeSwitcher({ api }: { api: FrameApi }): JSX.Element {
  const { store, state } = useScope(api);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const scope = store.scopeOf();
  const multi = state.repos.length > 1;
  const repos = multi ? state.repos.map((r) => r.repo) : [state.repo];

  const choose = (repo: string, next: ViewScope): void => {
    store.select(repo, next);
    setOpen(false);
    api.announce(`Viewing ${scopeName(next, state.session)}${multi ? ` in ${repoLabel(repo)}` : ''}.`);
  };

  return (
    <div className="frame-title-anchor scope-switcher">
      <button
        ref={button}
        type="button"
        className="frame-chip scope-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`View scope: ${scopeName(scope, state.session)}`}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon icon={ViewScopeGlyph} size={16} />
        {scopeName(scope, state.session)}
        <Icon icon={ChevronDown} size={12} />
      </button>
      {open && (
        <Popover label="View scope" anchor={button} role="menu" className="frame-menu scope-menu" onClose={() => setOpen(false)}>
          {repos.map((repo) => (
            <ScopeGroup key={repo} repo={repo} heading={multi} state={state} current={store.scopeOf(repo)} onChoose={(next) => choose(repo, next)} />
          ))}
        </Popover>
      )}
    </div>
  );
}

function ScopeGroup({ repo, heading, state, current, onChoose }: {
  repo: string;
  heading: boolean;
  state: ScopeState;
  current: ViewScope;
  onChoose(scope: ViewScope): void;
}): JSX.Element {
  return (
    <div role="group" aria-label={repoLabel(repo)}>
      {heading && <h3 className="frame-section-title scope-repo">{repoLabel(repo)}</h3>}
      <ul>
        {optionsFor(state, repo).map((option) => {
          const checked = sameScope(option.scope, current);
          return (
            <li key={option.label + (option.detail ?? '')}>
              <button type="button" role="menuitemradio" aria-checked={checked} onClick={() => onChoose(option.scope)}>
                <span className="scope-mark" aria-hidden="true">{checked ? '●' : '○'}</span>
                <span className="scope-label">{option.label}</span>
                {option.detail && <span className="scope-detail">{option.detail}</span>}
                {option.mark && <span className="scope-state" aria-label={option.mark === '✓' ? 'landed' : 'running'}>{option.mark}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** `repo › branch` after the workspace: the branch the scope reads (`ReadAt.branch`, ADR-0061 R5). */
function RepoBranch({ api }: { api: FrameApi }): JSX.Element | null {
  const { store, state } = useScope(api);
  const info = state.repos.find((r) => r.repo === state.repo);
  const scope = store.scopeOf();
  let branch: string | null | undefined;
  if (scope.kind === 'checkout') branch = info?.branch;
  else if (scope.kind === 'integration') branch = state.session?.integration.find((i) => i.repo === state.repo)?.branch ?? state.session?.integration[0]?.branch;
  else branch = scopeName(scope, state.session);
  if (!info && !branch) return null;
  const multi = state.repos.length > 1;
  return (
    <span className="scope-branch" title={scopeName(scope, state.session)}>
      {multi && <span>{repoLabel(state.repo)} · </span>}
      {branch ?? (info?.detached ? 'detached HEAD' : '')}
    </span>
  );
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerSlot({ slot: 'title.scope', id: 'scope', render: () => <ScopeSwitcher api={api} /> }),
    api.registerSlot({ slot: 'title.breadcrumb', id: 'repo-branch', render: () => <RepoBranch api={api} /> }),
  );
}
