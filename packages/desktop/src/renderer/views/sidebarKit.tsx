import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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

/** Where a word or path part starts: at a "/", or after "-", "_", "." or a space. */
const boundaries = (text: string): number[] => {
  const cuts: number[] = [];
  for (let at = 1; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '/') cuts.push(at);
    else if ('-_. '.includes(text[at - 1]!) && !'-_. '.includes(char)) cuts.push(at);
  }
  return cuts;
};

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
  const cuts = boundaries(text);
  const fits = cuts.filter((at) => n - at <= budget);
  const wanted = fits.filter((at) => n - at >= Math.max(tail, segment)).pop();
  const longest = fits.find((at) => n - at >= TAIL_STUB);
  const at = wanted ?? longest ?? n - (path ? Math.min(PATH_TAIL_MAX, budget) : tail);
  return { head: text.slice(0, at), tail: text.slice(at) };
}

/** How wide a text is drawn in a CSS font, in CSS px. */
export type MeasureText = (text: string, font: string) => number;

/** A cut leaves this much room spare, since the canvas and the layout may round a glyph run apart. */
const SLACK = 1;
/** How far the canvas may measure a text past its box and it still counts as whole: they round a glyph run apart by less. */
const FITS = 0.5;
/** The head keeps about this many em beside a measured tail (design.md O7: each part shows at least 32px). */
const HEAD_EM = 3;
const ELLIPSIS = '\u2026';

let injected: MeasureText | undefined;
let canvas: OffscreenCanvasRenderingContext2D | null | undefined;
const drawn = new Map<string, number>();
const remeasure = new Set<() => void>();

/** Swaps how MiddleText measures, for a test (jsdom draws no text); undefined goes back to the canvas. */
export function setMeasureText(measure: MeasureText | undefined): void {
  injected = measure;
  drawn.clear();
}

function canvasWidth(text: string, font: string): number {
  const key = `${font}\n${text}`;
  const known = drawn.get(key);
  if (known !== undefined) return known;
  // Many rows share a few fonts and the same few dozen cuts each; a bound keeps a long session's names from piling up.
  if (drawn.size > 5000) drawn.clear();
  canvas!.font = font;
  const width = canvas!.measureText(text).width;
  drawn.set(key, width);
  return width;
}

/** The measurer, or undefined where text cannot be measured, and MiddleText cuts by characters instead. */
function measurer(): MeasureText | undefined {
  if (injected) return injected;
  if (canvas === undefined) {
    // jsdom has no OffscreenCanvas, and its HTMLCanvasElement logs an error for every getContext.
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') : null;
    // A web font that lands after the first draw changes every width: forget them and cut again.
    if (canvas && typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', () => {
      drawn.clear();
      for (const again of remeasure) again();
    });
  }
  return canvas ? canvasWidth : undefined;
}

/**
 * Where a text is cut to fit `width` px, by measuring it: the longest tail that
 * starts at a word or path boundary and fits whole beside a head of at least
 * `headFloor` px, so the end that
 * tells one name from the next is never itself cut. When no boundary tail fits
 * there, the last word (a path's last segment) is the tail and the head may
 * shrink to its ellipsis, `headMin`; the tail is then the part that gives way.
 * A text with no boundary keeps the longest plain tail that fits.
 * Null when the text fits whole, or is one word too long for any cut.
 */
export function fitMiddle(text: string, width: number, measure: (text: string) => number, { headFloor, path = false }: { headFloor: number; path?: boolean }): { head: string; tail: string; headMin?: number } | null {
  // A box sized to its text is exactly as wide as the text, so whole is judged without the slack a cut keeps.
  if (measure(text) <= width + FITS) return null;
  const room = width - SLACK;
  // A head narrower than its floor would mean the whole text fits, which was ruled out above: the head is always cut here.
  const beside = (at: number): boolean => measure(text.slice(at)) + headFloor <= room;
  const cuts = boundaries(text);
  if (cuts.length === 0) {
    for (let at = 1; at < text.length; at += 1) if (beside(at)) return { head: text.slice(0, at), tail: text.slice(at) };
    return null;
  }
  const at = cuts.find(beside);
  if (at !== undefined) return { head: text.slice(0, at), tail: text.slice(at) };
  const slash = text.lastIndexOf('/');
  const last = path && slash > 0 ? slash : cuts[cuts.length - 1]!;
  return { head: text.slice(0, last), tail: text.slice(last), headMin: measure(ELLIPSIS) };
}

interface Box { width: number; font: string; em: number }

/**
 * The width MiddleText has and the font it draws in, read when it draws and
 * again whenever its box is resized; undefined until there is a width (jsdom
 * lays nothing out).
 */
function useBox(ref: RefObject<HTMLElement>): Box | undefined {
  const [box, setBox] = useState<Box>();
  const [, redraw] = useState(0);
  const last = useRef<Box>();
  const read = useCallback((given?: number): void => {
    const element = ref.current;
    if (!element) return;
    const width = given ?? element.getBoundingClientRect().width;
    const style = getComputedStyle(element);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const em = Number.parseFloat(style.fontSize) || 13;
    const next = width <= 0 ? undefined : { width, font, em };
    const was = last.current;
    // Compared here, not in an updater: a state set from a layout effect that runs on every draw, even to the same value,
    // draws the row again, and a list of them never settles (React's "Maximum update depth exceeded").
    if (was === next || (was && next && was.width === next.width && was.font === next.font && was.em === next.em)) return;
    last.current = next;
    setBox(next);
  }, [ref]);
  // Every draw, not once: a row's state can change its weight (the checked-out branch is strong) without resizing it.
  useLayoutEffect(() => read());
  useEffect(() => {
    const element = ref.current;
    const again = (): void => redraw((n) => n + 1);
    remeasure.add(again);
    if (!element || typeof ResizeObserver !== 'function') return () => { remeasure.delete(again); };
    const observer = new ResizeObserver((entries) => read(entries[0]?.contentRect.width));
    observer.observe(element);
    return () => {
      remeasure.delete(again);
      observer.disconnect();
    };
  }, [read, ref]);
  return box;
}

/**
 * A text that is shortened in the middle, so the end of a path or branch (the
 * part that tells one from the next) stays; the whole of it is the tooltip.
 * Where text can be measured (the app) the cut follows the room it has
 * (fitMiddle); elsewhere it is splitMiddle's, by characters, where `tail` is
 * the least of the end to keep. `path` marks a path, which keeps its last segment.
 */
export function MiddleText({ text, tail = 12, path = false, className }: { text: string; tail?: number; path?: boolean; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const box = useBox(ref);
  const measure = box && measurer();
  // The head holds all of its text and lets CSS draw the ellipsis, so the box's natural width never changes with the cut and a resize cannot feed back into it.
  const fit = measure && box ? fitMiddle(text, box.width, (part) => measure(part, box.font), { headFloor: HEAD_EM * box.em, path }) : undefined;
  const split = fit === undefined ? splitMiddle(text, { tail, path }) : fit;
  const mode = !fit ? '' : fit.headMin === undefined ? 'mid-fit' : 'mid-tight';
  const classes = ['mid', mode, className].filter(Boolean).join(' ');
  if (!split) return <span ref={ref} className={classes} title={text}><span className="mid-whole">{text}</span></span>;
  return (
    <span ref={ref} className={classes} title={text}>
      <span className="mid-head" style={fit?.headMin === undefined ? undefined : { minWidth: `${Math.ceil(fit.headMin)}px` }}>{split.head}</span>
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
            <Icon icon={open ? ChevronDown : ChevronRight} size={16} />
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
