import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy } from 'lucide-react';
import { IconButton } from '@ordewell/ui/design';
import type { FrameApi } from '../../frame/api';
import type { Branches, CommitDetail, CommitSummary } from './gitData';
import { ago, commitWhen, plural, refChips, shortSha, summarizeRefs } from './gitModel';
import { gitStoreFor } from './gitStore';
import { Chip, chipKind, laneColor } from './GraphParts';

/*
 * One card for whatever part of a commit's row the pointer is on (subject,
 * ref chip, +N or lanes) in place of the native tooltips each part had: those
 * waited on the OS, competed with each other and could not be selected. It
 * opens beside the sidebar, over the main area, so the history it describes
 * stays in view. The log's own fields show at once; the message and files are
 * read when it opens, once per sha (GitStore.commitDetail).
 */

const OPEN_DELAY = 450;
/** Long enough to cross the gap into the card, which stays open while it is under the pointer. */
const CLOSE_GRACE = 150;
const GAP = 8;
const MARGIN = 8;

/** Where a card's top-left corner goes for the row it describes, before it is kept inside the window. */
export type CardPlacement = (row: HTMLElement) => { left: number; top: number };

/** Beside the sidebar the row is in, level with the row: the list stays whole and the card lies over the main area. */
export const besideSidebar: CardPlacement = (row) => {
  const side = row.closest('.frame-sidebar') ?? row;
  return { left: side.getBoundingClientRect().right + GAP, top: row.getBoundingClientRect().top };
};

/** After the end of the subject's text in a graph row, not of its column, so a short subject's card sits beside it. */
export const besideSubject: CardPlacement = (row) => {
  const subject = row.querySelector<HTMLElement>('.git-commit-subject');
  const box = (subject ?? row).getBoundingClientRect();
  const end = subject ? Math.min(box.right, box.left + subject.scrollWidth) : box.right;
  return { left: end + GAP, top: row.getBoundingClientRect().top };
};

interface Shown {
  commit: CommitSummary;
  lane: number;
  row: HTMLElement;
}

export interface RowHoverProps {
  onMouseEnter(event: MouseEvent<HTMLElement>): void;
  onMouseLeave(): void;
  onMouseDown(event: MouseEvent<HTMLElement>): void;
  onFocus(event: FocusEvent<HTMLElement>): void;
  onBlur(): void;
  'aria-describedby'?: string;
}

/**
 * The hover card of a list of commit rows: `rowProps` goes on each row, `card`
 * anywhere in the tree (it draws into the body). One card at a time; once one
 * is open, the next row's replaces it at once rather than waiting again.
 */
export function useCommitCard({ api, repo, branches, place }: { api: FrameApi; repo: string; branches: Branches | undefined; place: CardPlacement }): {
  rowProps(commit: CommitSummary, lane: number): RowHoverProps;
  card: JSX.Element | null;
} {
  const [shown, setShown] = useState<Shown>();
  const current = useRef(shown);
  current.current = shown;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** The pointer is over a row or the card: a blur then is the click that went into the card, not a leaving. */
  const hovering = useRef(false);
  /** A press focuses its row too; that focus is the pointer's, and opens nothing. */
  const pressed = useRef<HTMLElement>();
  const id = useId();

  const clear = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const show = (next: Shown, delay: number): void => {
    clear();
    if (current.current || delay === 0) setShown(next);
    else timer.current = setTimeout(() => setShown(next), delay);
  };
  const hide = (): void => {
    clear();
    timer.current = setTimeout(() => setShown(undefined), CLOSE_GRACE);
  };
  const close = useCallback((): void => {
    clear();
    setShown(undefined);
  }, []);
  useEffect(() => clear, []);

  useEffect(() => {
    if (!shown) return undefined;
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    // The row it is level with has moved; the card's own scrolling is the reader's.
    const scroll = (event: Event): void => { if (!(event.target instanceof Node && document.getElementById(id)?.contains(event.target))) close(); };
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [shown, id, close]);

  const rowProps = (commit: CommitSummary, lane: number): RowHoverProps => ({
    onMouseEnter: (event) => { hovering.current = true; show({ commit, lane, row: event.currentTarget }, OPEN_DELAY); },
    onMouseLeave: () => { hovering.current = false; pressed.current = undefined; hide(); },
    // A click opens the commit in the main area, where the card would cover it.
    onMouseDown: (event) => { pressed.current = event.currentTarget; close(); },
    onFocus: (event) => {
      const byPointer = pressed.current === event.currentTarget;
      pressed.current = undefined;
      if (!byPointer) show({ commit, lane, row: event.currentTarget }, 0);
    },
    onBlur: () => { if (!hovering.current) hide(); },
    ...(shown?.commit.sha === commit.sha ? { 'aria-describedby': id } : {}),
  });

  const card = shown && shown.row.isConnected ? (
    <CommitCard
      key={shown.commit.sha}
      id={id}
      api={api}
      repo={repo}
      commit={shown.commit}
      lane={shown.lane}
      branches={branches}
      at={place(shown.row)}
      onEnter={() => { hovering.current = true; clear(); }}
      onLeave={() => { hovering.current = false; hide(); }}
    />
  ) : null;
  return { rowProps, card };
}

function filesLine(detail: CommitDetail): string {
  let added = 0;
  let removed = 0;
  for (const file of detail.files) {
    added += file.added ?? 0;
    removed += file.removed ?? 0;
  }
  return `${plural(detail.files.length, 'file')}, +${added} −${removed}`;
}

interface CardProps {
  id: string;
  api: FrameApi;
  repo: string;
  commit: CommitSummary;
  lane: number;
  branches: Branches | undefined;
  at: { left: number; top: number };
  onEnter(): void;
  onLeave(): void;
}

function CommitCard({ id, api, repo, commit, lane, branches, at, onEnter, onLeave }: CardProps): JSX.Element {
  const git = gitStoreFor(api);
  const [detail, setDetail] = useState(() => git.cachedCommit(repo, commit.sha));
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (detail) return undefined;
    let live = true;
    git.commitDetail(repo, commit.sha).then((read) => { if (live) setDetail(read); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [git, repo, commit.sha, detail]);

  // Kept inside the window, measured after each draw since the message arriving changes its height.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(MARGIN, Math.min(at.left, window.innerWidth - width - MARGIN))}px`;
    el.style.top = `${Math.max(MARGIN, Math.min(at.top, window.innerHeight - height - MARGIN))}px`;
  });

  const { chips } = summarizeRefs(refChips(commit.refs, branches));
  // HEAD is left out beside the checkout's own branch, which says it; a detached HEAD has none, so it is listed.
  const head = commit.refs.includes('HEAD') && !chips.some((chip) => chip.current) ? [{ text: 'HEAD', kind: 'head' as const }] : [];
  const listed = [...head, ...chips];
  const when = ago(commit.date);
  const relative = when === 'now' ? 'just now' : when && `${when} ago`;
  const body = detail?.commit.body.trim();
  const parents = commit.parents.length === 0 ? 'Root commit'
    : `${commit.parents.length > 1 ? 'Parents' : 'Parent'} ${commit.parents.map(shortSha).join(', ')}${commit.parents.length > 1 ? ' · merge' : ''}`;

  const copy = (): void => {
    void navigator.clipboard?.writeText(commit.sha).then(() => setCopied(true), () => undefined);
  };

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      aria-label={`Commit ${shortSha(commit.sha)}`}
      className="git-card"
      style={{ left: at.left, top: at.top, '--git-card-lane': laneColor(lane) } as CSSProperties}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <p className="git-card-subject">{commit.subject}</p>
      {body && <pre className="git-card-body">{body}</pre>}
      <div className="git-card-facts">
        <p className="git-card-row">
          <span className="git-card-sha">{shortSha(commit.sha)}</span>
          <IconButton icon={Copy} size={12} className="git-card-copy" label={copied ? 'Copied the full sha' : 'Copy the full sha'} title={commit.sha} onClick={copy} />
          <span className="git-card-author">{commit.author}{commit.email && <span className="git-card-dim"> &lt;{commit.email}&gt;</span>}</span>
        </p>
        <p className="git-card-row git-card-dim">{[relative, commitWhen(commit.date)].filter(Boolean).join(' · ')}</p>
        {listed.length > 0 && (
          <ul className="git-card-refs" aria-label="Refs">
            {listed.map((chip) => (
              <li key={chip.text}>
                <Chip chip={chip} lane={lane} />
                <span className="git-card-dim">{chipKind(chip)}{'tracked' in chip && chip.tracked ? ` · also on ${chip.tracked}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="git-card-row git-card-dim">{parents}</p>
        {detail ? <p className="git-card-row git-card-dim">{filesLine(detail)}</p>
          : !failed && <p className="git-card-row git-card-dim git-card-loading">Reading the message and files…</p>}
      </div>
    </div>,
    document.body,
  );
}
