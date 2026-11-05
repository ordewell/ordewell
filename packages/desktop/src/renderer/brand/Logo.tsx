import wordmarkDark from '../assets/brand/logo-dark.png';
import wordmarkLight from '../assets/brand/logo-light.png';

/**
 * The wordmark, from the bundle so it loads under the CSP's `'self'`. The
 * colour-scheme query follows the app's theme, since main sets it through
 * `nativeTheme.themeSource` the way theme.css is switched.
 */
export function Wordmark({ className }: { className?: string }): JSX.Element {
  return (
    <picture className={className}>
      <source srcSet={wordmarkDark} media="(prefers-color-scheme: dark)" />
      <img src={wordmarkLight} alt="Ordewell" width={200} height={66} draggable={false} />
    </picture>
  );
}

/**
 * The bare mark of packages/vscode/media/icon.svg, for where a small logo is
 * needed. Its strokes take the text colour: the file's own are near-black
 * and would vanish on dark.
 */
export function LogoMark({ size = 40, label }: { size?: number; label?: string }): JSX.Element {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg className="ow-logo-mark" viewBox="45 115 400 280" width={size} height={(size * 280) / 400} focusable="false" {...a11y}>
      <g fill="none" stroke="currentColor" strokeWidth={26} strokeLinecap="round" strokeLinejoin="round">
        <path d="M 72 142 C 190 142 232 256 336 256" />
        <path d="M 72 256 L 336 256" />
        <path d="M 72 370 C 190 370 232 256 336 256" />
      </g>
      <circle cx={392} cy={256} r={40} fill="var(--ow-area-planner)" />
    </svg>
  );
}
