import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconComponent } from './Icon';

/**
 * What a badge says by its colour, beside its words. `attention`, `failed`
 * and `merge` are status colours, so they are for a task's state only
 * (design.md, Visual language, rule 5); `neutral` is everything else.
 */
export type BadgeTone = 'neutral' | 'accent' | 'attention' | 'failed' | 'passed' | 'merge';

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  children: ReactNode;
  tone?: BadgeTone;
  /** Drawn at 12px with the heavier stroke, a 4px gap from the words. */
  icon?: IconComponent;
}

/**
 * A short label in a 20px box: a kind, a count, a state's qualifier. Its words
 * are the one part that shrinks, to an ellipsis; the icon keeps its box.
 */
export function Badge({ children, tone = 'neutral', icon, className, ...rest }: BadgeProps): JSX.Element {
  const classes = ['ow-badge', `ow-badge-${tone}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...rest}>
      {icon && <Icon icon={icon} size={12} />}
      <span className="ow-badge-label">{children}</span>
    </span>
  );
}
