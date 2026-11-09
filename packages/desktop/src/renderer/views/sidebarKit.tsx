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

/**
 * A text that is shortened in the middle, so the end of a path or branch (the
 * part that tells one from the next) stays; the whole of it is the tooltip.
 */
export function MiddleText({ text, tail = 12, className }: { text: string; tail?: number; className?: string }): JSX.Element {
  const classes = ['mid', className].filter(Boolean).join(' ');
  if (text.length <= tail + 6) return <span className={classes} title={text}><span className="mid-whole">{text}</span></span>;
  return (
    <span className={classes} title={text}>
      <span className="mid-head">{text.slice(0, -tail)}</span>
      <span className="mid-tail">{text.slice(-tail)}</span>
    </span>
  );
}

/**
 * The tail to keep of a path or a rename's "from …" line: its last segment and the slash before it, so the name that tells two paths apart is never what the ellipsis takes.
 * Bounded below by MiddleText's own default and above so a long name still leaves the head a few characters.
 */
export function pathTail(path: string): number {
  return Math.min(40, Math.max(12, path.length - path.lastIndexOf('/')));
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
