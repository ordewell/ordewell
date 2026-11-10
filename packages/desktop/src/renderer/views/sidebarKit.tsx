import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, Info } from 'lucide-react';
import { Icon } from '@ordewell/ui/design';
import './sidebarKit.css';

/*
 * What the Checkout and Git sidebars draw rows and sections with, so a long
 * path or branch can never run under an icon or out of its box (design.md,
 * Layout rules that prevent overlap): the label is the one part that shrinks.
 */

/** A list longer than this starts folded: a long section opens on demand. */
export const LONG_LIST = 10;

/** The longest tail a path keeps, so a very long file name still leaves its folders a head. */
const PATH_TAIL_MAX = 40;
/** A tail shorter than this is a stub ("-x"), not a name worth keeping. */
const TAIL_STUB = 6;

/**
 * Where a text is cut for MiddleText: the tail starts at a word or path boundary (after "-", "_", "." or a space, or at a "/"), so the end that tells one name from the next reads whole ("…query-strings", not "…uery-stri").
 * It is the shortest boundary tail of at least `tail` characters and at most about 40% of the text, so the head keeps the room; a path keeps its last segment whole, up to PATH_TAIL_MAX, whatever the share.
 * When no boundary fits (one long word, or a last segment longer than the budget) it keeps the longest boundary tail that does, then a plain cut of `tail` characters (a path's, of the budget).
 * Returns undefined for a text short enough to show whole.
 */
export function splitMiddle(text: string, { tail = 12, path = false }: { tail?: number; path?: boolean } = {}): { head: string; tail: string } | undefined {
  const n = text.length;
  if (n <= tail + 6) return undefined;
  const lastSegment = n - Math.max(0, text.lastIndexOf('/'));
  const segment = path && lastSegment <= PATH_TAIL_MAX ? lastSegment : 0;
  const budget = Math.max(Math.floor(n * 0.4), tail, segment);
  const cuts: number[] = [];
  for (let at = 1; at < n; at += 1) {
    const char = text[at]!;
    if (char === '/') cuts.push(at);
    else if ('-_. '.includes(text[at - 1]!) && !'-_. '.includes(char)) cuts.push(at);
  }
  const fits = cuts.filter((at) => n - at <= budget);
  const wanted = fits.filter((at) => n - at >= Math.max(tail, segment)).pop();
  const longest = fits.find((at) => n - at >= TAIL_STUB);
  const at = wanted ?? longest ?? n - (path ? Math.min(PATH_TAIL_MAX, budget) : tail);
  return { head: text.slice(0, at), tail: text.slice(at) };
}

/**
 * A text that is shortened in the middle, so the end of a path or branch (the
 * part that tells one from the next) stays; the whole of it is the tooltip.
 * `tail` is the least of the end to keep; `path` marks a path, which keeps its last segment.
 */
export function MiddleText({ text, tail = 12, path = false, className }: { text: string; tail?: number; path?: boolean; className?: string }): JSX.Element {
  const classes = ['mid', className].filter(Boolean).join(' ');
  const split = splitMiddle(text, { tail, path });
  if (!split) return <span className={classes} title={text}><span className="mid-whole">{text}</span></span>;
  return (
    <span className={classes} title={text}>
      <span className="mid-head">{split.head}</span>
      <span className="mid-tail">{split.tail}</span>
    </span>
  );
}

/**
 * A sidebar section that folds: its header is one button, so a second press
 * folds it again. Whether it starts open is decided when it first draws; what
 * the person does after that is theirs.
 */
export function SidebarGroup({ title, label, count, actions, startOpen = true, children }: {
  title: string;
  /** What a screen reader names the region, when the title alone does not say where it is ("Staged in web"). */
  label?: string;
  count?: number;
  /** Icon buttons at the right of the header, which keep their room. */
  actions?: ReactNode;
  startOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  return (
    <section className="sgroup" {...(label ? { 'aria-label': label } : { 'aria-labelledby': id })}>
      <div className="sgroup-head">
        <h4 id={id} className="sgroup-title">
          <button type="button" className="sgroup-toggle" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
            <span className="sgroup-name">{title}</span>
            {count !== undefined && <span className="ow-count">{count}</span>}
          </button>
        </h4>
        {actions && <div className="sgroup-actions">{actions}</div>}
      </div>
      {open && <div className="sgroup-body">{children}</div>}
    </section>
  );
}

/** A refusal or a failure in a sidebar, in words, with the icon the status vocabulary gives a problem. */
export function Notice({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }): JSX.Element {
  return (
    <p className={`snotice snotice-${tone}`} role={tone === 'error' ? 'alert' : 'note'}>
      <Icon icon={tone === 'error' ? CircleAlert : Info} size={14} />
      <span className="snotice-text">{children}</span>
    </p>
  );
}
