import { useId, type ReactNode } from 'react';
import { strokeFor, type GlyphProps } from './glyphs';

/**
 * An arrow meeting a still line, drawn as Lucide draws it (24px grid, round
 * caps and joins, currentColor) but with the arrow its own group, so a busy
 * Button's `glide` can move the arrow along its own direction while the line
 * stays put. Turning a directional arrow would point it the wrong way for half
 * of every turn and sweep its line round like a propeller.
 *
 * The arrow is clipped just above the line, so as it glides it slips into the
 * line (down) or rises out of it (up) instead of crossing it.
 */
function arrowToLine(name: string, direction: 'down' | 'up', arrow: ReactNode, line: string) {
  function Arrow({
    size = 16, strokeWidth = strokeFor(size), absoluteStrokeWidth = true, className, ...rest
  }: Omit<GlyphProps, 'dot'>): JSX.Element {
    // React's ids hold colons, which a url() reference cannot be trusted to carry.
    const clip = `ow-arrow-clip-${useId().replace(/[^\w-]/g, '')}`;
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
        className={['ow-arrow', `ow-arrow-${name}`, className].filter(Boolean).join(' ')}
        {...rest}
      >
        <clipPath id={clip}>
          {/* The line's stroke starts below 19.5; the arrow at rest ends above 18.5. */}
          <rect x="0" y="0" width="24" height="19" />
        </clipPath>
        <g clipPath={`url(#${clip})`}>
          <g className={`ow-glide-${direction}`}>{arrow}</g>
        </g>
        <path d={line} />
      </svg>
    );
  }
  Arrow.displayName = `${name.replace(/(^|-)(\w)/g, (_m, _s, c: string) => c.toUpperCase())}Icon`;
  return Arrow;
}

/** Pull: Lucide's `arrow-down-to-line`, its arrow gliding down into the line while a pull runs. */
export const PullIcon = arrowToLine('pull', 'down', (
  <>
    <path d="M12 17V3" />
    <path d="m6 11 6 6 6-6" />
  </>
), 'M19 21H5');

/** Push: Lucide's `arrow-up-from-line`, its arrow rising out of the line while a push runs. */
export const PushIcon = arrowToLine('push', 'up', (
  <>
    <path d="m18 9-6-6-6 6" />
    <path d="M12 3v14" />
  </>
), 'M5 21h14');
