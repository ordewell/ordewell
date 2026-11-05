import type { ReactNode, SVGProps } from 'react';

/**
 * The sizes an icon is drawn at, by context (docs/desktop/design.md, Icon
 * sizes): 22 in the activity bar, 40 in an empty state, 16 in a control, 14 on
 * a second line or a chip, 12 inside a badge. 20 and 24 stay for drawings
 * outside those contexts, such as the Welcome window's.
 */
export type IconSize = 12 | 14 | 16 | 20 | 22 | 24 | 40;

/** Every icon is stroked at this many pixels, whatever its size... */
export const ICON_STROKE = 1.5;

/** ...but a badge's: at 12px a 1.5px stroke thins out beside caption text. */
export const ICON_STROKE_SMALL = 1.75;

/** The stroke, in pixels, an icon of this size is drawn with. */
export function strokeFor(size: IconSize): number {
  return size <= 12 ? ICON_STROKE_SMALL : ICON_STROKE;
}

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> {
  size?: IconSize;
  /** The dot's colour, any CSS colour: the accent unless a state colour is given. */
  dot?: string;
  /** As Lucide's: keep the stroke at `strokeWidth` pixels at any size. On by default. */
  absoluteStrokeWidth?: boolean;
}

/** Where the dot sits and how big it is, in the 24px grid. */
interface Dot { cx: number; cy: number; r?: number }

/**
 * An Ordewell glyph: Lucide's frame (24px grid, round caps and joins, stroked
 * in currentColor) around the logo's motif, round-capped strokes converging
 * on a filled dot. The dot is filled, never stroked, so it reads as the one
 * point of colour in a row.
 */
function glyph(name: string, label: string, dot: Dot, strokes: ReactNode) {
  function Glyph({
    size = 16, strokeWidth = strokeFor(size), absoluteStrokeWidth = true, dot: dotColor, className, style, ...rest
  }: GlyphProps): JSX.Element {
    const width = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / size : strokeWidth;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={['ow-glyph', `ow-glyph-${name}`, className].filter(Boolean).join(' ')}
        style={style}
        {...rest}
      >
        {strokes}
        {/* A presentation attribute cannot read a custom property; a style can. */}
        <circle cx={dot.cx} cy={dot.cy} r={dot.r ?? 2.5} stroke="none" style={{ fill: dotColor ?? 'var(--ow-accent)' }} />
      </svg>
    );
  }
  Glyph.displayName = `${label.replace(/\s/g, '')}Glyph`;
  return Glyph;
}

/** Three strokes of falling length, the outer two bending in toward the dot: the work, in order. */
export const PlanGlyph = glyph('plan', 'Plan', { cx: 19.5, cy: 12 }, (
  <>
    <path d="M3 6h7.5c2.4 0 3.9 1.6 5 4.4" />
    <path d="M6 12h9.5" />
    <path d="M9 18h1.5c2.4 0 3.9-1.6 5-4.4" />
  </>
));

/** One stroke curving back round the dot, open where it would close. */
export const LoopGlyph = glyph('loop', 'Loop', { cx: 12, cy: 12 }, (
  <>
    <path d="M12 4.5a7.5 7.5 0 1 1-6.5 3.75" />
    <path d="M12 4.5 9.5 2.5M12 4.5 9.75 6.75" />
  </>
));

/** A vertical stroke crossed by a short one, the dot where they cross. */
export const CheckpointGlyph = glyph('checkpoint', 'Checkpoint', { cx: 12, cy: 12 }, (
  <>
    <path d="M12 3v5.5M12 15.5V21" />
    <path d="M6.5 12h2M15.5 12h2" />
  </>
));

/** Two strokes from the upper and lower left converging on the dot, a third leaving to the right. */
export const RunnerGlyph = glyph('runner', 'Runner', { cx: 11.5, cy: 12 }, (
  <>
    <path d="M3 5c3.5 0 5.4 1.6 6.4 4.6" />
    <path d="M3 19c3.5 0 5.4-1.6 6.4-4.6" />
    <path d="M14.5 12H21" />
  </>
));

/** Three strokes from the left joining into one that runs on to the dot. */
export const MergeAllGlyph = glyph('merge-all', 'Merge all', { cx: 19.5, cy: 12 }, (
  <>
    <path d="M3 5c4 0 6 2 7.5 7" />
    <path d="M3 19c4 0 6-2 7.5-7" />
    <path d="M3 12h12.5" />
  </>
));

/** The dot inside an open diamond: four strokes that do not meet. */
export const NeedsYouGlyph = glyph('needs-you', 'Needs you', { cx: 12, cy: 12 }, (
  <path d="M13.6 4.6l5.8 5.8M19.4 13.6l-5.8 5.8M10.4 19.4l-5.8-5.8M4.6 10.4l5.8-5.8" />
));

/** A small Plan glyph inside a rounded bracket: a plan the parent's task runs. */
export const ChildPlanGlyph = glyph('child-plan', 'Child plan', { cx: 16, cy: 12, r: 1.75 }, (
  <>
    <path d="M6 3.5H5.5a2.5 2.5 0 0 0-2.5 2.5v12a2.5 2.5 0 0 0 2.5 2.5H6" />
    <path d="M18 3.5h.5A2.5 2.5 0 0 1 21 6v12a2.5 2.5 0 0 1-2.5 2.5H18" />
    <path d="M7 8.5h3.5c1.2 0 1.9.7 2.5 2" />
    <path d="M8.5 12h4" />
    <path d="M10 15.5h.5c1.2 0 1.9-.7 2.5-2" />
  </>
));

/** Two nested open corners framing the dot: what a view is narrowed to. */
export const ViewScopeGlyph = glyph('view-scope', 'View scope', { cx: 14.5, cy: 14.5 }, (
  <>
    <path d="M3 11V6a3 3 0 0 1 3-3h5" />
    <path d="M7.5 13v-3a2.5 2.5 0 0 1 2.5-2.5h3" />
    <path d="M21 13v5a3 3 0 0 1-3 3h-5" />
  </>
));

/** Every glyph by the name the design doc gives it, for a sheet that shows them all and a test that checks them. */
export const GLYPHS = {
  Plan: PlanGlyph,
  Loop: LoopGlyph,
  Checkpoint: CheckpointGlyph,
  Runner: RunnerGlyph,
  'Merge all': MergeAllGlyph,
  'Needs you': NeedsYouGlyph,
  'Child plan': ChildPlanGlyph,
  'View scope': ViewScopeGlyph,
} as const;
