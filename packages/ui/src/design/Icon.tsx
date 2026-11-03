import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { ICON_STROKE, type GlyphProps, type IconSize } from './glyphs';

/** A Lucide icon or an Ordewell glyph: both take a size and a stroke in pixels. */
export type IconComponent = LucideIcon | ComponentType<GlyphProps>;

export interface IconProps {
  icon: IconComponent;
  size?: IconSize;
  /** A label makes the icon an image a screen reader announces; without one it is decoration. */
  label?: string;
  className?: string;
}

/**
 * One icon at a fixed size and a 1.5px stroke. Lucide draws on a 24px grid, so
 * its stroke is held at pixels rather than scaled with the icon: a 16px icon
 * keeps the stroke a 20px one has.
 */
export function Icon({ icon: Drawn, size = 16, label, className }: IconProps): JSX.Element {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  const classes = ['ow-icon', className].filter(Boolean).join(' ');
  // A glyph ignores the Lucide-only props; both accept size and className.
  const Any = Drawn as ComponentType<LucideProps & GlyphProps>;
  return <Any size={size} strokeWidth={ICON_STROKE} absoluteStrokeWidth focusable="false" className={classes} {...a11y} />;
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  icon: IconComponent;
  /** Required: an icon button has no text, so this is all a screen reader and a tooltip have. */
  label: string;
  size?: IconSize;
  /** The active item of a set: a teal stroke on a tinted pill. */
  active?: boolean;
  /** A count or dot drawn over the icon, such as the Changes count. */
  badge?: ReactNode;
}

/** A button that is only an icon, labelled for a screen reader and titled for a pointer. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 16, active, badge, className, type = 'button', ...rest },
  ref,
) {
  const classes = ['ow-icon-button', active ? 'ow-icon-button-active' : '', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={classes} {...rest}>
      <Icon icon={icon} size={size} />
      {badge !== undefined && badge !== null && badge !== false && <span className="ow-icon-badge" aria-hidden="true">{badge}</span>}
    </button>
  );
});
