import type { MouseEvent } from 'react';
import { GitBranch, TriangleAlert, X } from 'lucide-react';
import { Badge, Button, Icon, IconButton, NeedsYouGlyph, StatusIndicator } from '@ordewell/ui/design';
import type { RecentWorkspace } from '../../shared/bridge';
import { fullDate, gitLine, middleEllipsis, relativeTime, sessionLook } from './model';
import { Skeleton } from './parts';
import type { Live } from './useLiveFacts';

/**
 * One recent project (design W1). It draws at once from the app's store and
 * swaps in the daemon's lines when they arrive; a missing folder keeps only
 * its name, its path and Forget.
 */
export function RecentCard({ entry, live, now, onOpen, onForget }: {
  entry: RecentWorkspace;
  live: Live;
  now: Date;
  onOpen(path: string): void;
  onForget(entry: RecentWorkspace): void;
}): JSX.Element {
  const facts = live.state === 'ready' ? live.facts : undefined;
  const git = facts?.git ?? entry.git;
  const session = facts && facts.session !== undefined ? facts.session : entry.lastSession;
  const needsYou = facts?.needsYou ?? 0;
  const when = relativeTime(entry.openedAt, now);
  const forget = (event: MouseEvent): void => {
    event.stopPropagation();
    onForget(entry);
  };

  if (entry.missing) {
    return (
      <li className="welcome-card welcome-recent welcome-recent-missing" data-path={entry.path} data-state="missing">
        <span className="welcome-recent-top">
          <span className="welcome-recent-name" title={entry.name}>{entry.name}</span>
        </span>
        <span className="welcome-line welcome-path" title={entry.path}>{middleEllipsis(entry.displayPath)}</span>
        <span className="welcome-line welcome-recent-warning">
          <Icon icon={TriangleAlert} size={14} />
          <span>Folder not found</span>
        </span>
        <span className="welcome-line">Moved or deleted?</span>
        <span className="welcome-recent-foot">
          <span className="welcome-line" title={fullDate(entry.openedAt)}>{when}</span>
          <Button size="sm" variant="ghost" onClick={forget} aria-label={`Forget ${entry.name}`}>Forget</Button>
        </span>
      </li>
    );
  }

  return (
    <li
      className="welcome-card welcome-recent"
      data-path={entry.path}
      data-state={live.state}
      onClick={() => onOpen(entry.path)}
    >
      <span className="welcome-recent-top">
        {/* The name is the card's one real control, so Tab and Enter open it as a click does. */}
        <button type="button" className="welcome-recent-name welcome-recent-open" title={entry.name} onClick={(event) => { event.stopPropagation(); onOpen(entry.path); }}>
          {entry.name}
        </button>
        {needsYou > 0 && (
          <Badge tone="attention" icon={NeedsYouGlyph} title={`${needsYou} waiting on you`} aria-label={`Needs you: ${needsYou}`}>
            {needsYou}
          </Badge>
        )}
        <IconButton className="welcome-recent-forget" icon={X} size={14} label={`Forget ${entry.name}`} onClick={forget} />
      </span>
      <span className="welcome-line welcome-path" title={entry.path}>{middleEllipsis(entry.displayPath)}</span>
      <span className="welcome-line welcome-muted">
        <Icon icon={GitBranch} size={14} />
        {git ? <span className="welcome-ellipsis" title={gitLine(git)}>{gitLine(git)}</span> : live.state === 'loading' ? <Skeleton width="short" /> : <span>Branch unknown</span>}
      </span>
      <span className="welcome-line">
        {session ? (
          <>
            {live.state === 'loading'
              ? <Skeleton width="short" />
              : <StatusIndicator status={sessionLook(session.status).status} size={14} label={sessionLook(session.status).word} />}
            <span className="welcome-ellipsis" title={session.goal}>{session.goal}</span>
            {live.state !== 'loading' && <span className="welcome-muted welcome-nowrap">· {sessionLook(session.status).word}</span>}
          </>
        ) : live.state === 'loading' ? (
          <Skeleton width="long" />
        ) : (
          <span className="welcome-muted">No sessions yet</span>
        )}
      </span>
      <span className="welcome-recent-foot">
        <span className="welcome-line welcome-muted" title={fullDate(entry.openedAt)}>{when}</span>
        {live.state === 'unavailable' && <span className="welcome-line welcome-muted welcome-unavailable">Live state unavailable</span>}
      </span>
    </li>
  );
}
