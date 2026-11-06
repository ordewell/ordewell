import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconComponent } from './Icon';

export interface SectionHeaderProps {
  /** Drawn as an overline: uppercase, tracked, 11px. */
  title: string;
  /** An area's icon, at 16px. */
  icon?: IconComponent;
  /** A count beside the title, tabular so a change moves nothing. */
  count?: number;
  /** Icon buttons at the right, kept whole while the title shrinks. */
  actions?: ReactNode;
  /** The heading level; a sidebar's section is a third-level heading by default. */
  level?: 2 | 3 | 4;
  className?: string;
}

/** A sidebar or panel section's 36px header: SESSIONS, STAGE 2. */
export function SectionHeader({ title, icon, count, actions, level = 3, className }: SectionHeaderProps): JSX.Element {
  const Heading = `h${level}` as const;
  return (
    <div className={['ow-section-header', className].filter(Boolean).join(' ')}>
      {icon && <Icon icon={icon} size={16} />}
      <Heading className="ow-section-header-title" title={title}>{title}</Heading>
      {count !== undefined && <span className="ow-count">{count}</span>}
      {actions && <div className="ow-section-header-actions">{actions}</div>}
    </div>
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Comfortable pads 16px, compact 8px. */
  density?: 'comfortable' | 'compact';
  /** The selected card's border is the accent. */
  selected?: boolean;
}

/** A bordered, flat box: level 0 elevation, the 8px radius. */
export function Card({ density = 'comfortable', selected, className, children, ...rest }: CardProps): JSX.Element {
  const classes = ['ow-card', `ow-card-${density}`, selected ? 'ow-card-selected' : '', className].filter(Boolean).join(' ');
  return <div className={classes} {...rest}>{children}</div>;
}

export interface EmptyStateProps {
  /** 40px, secondary grey. */
  icon?: IconComponent;
  title: string;
  /** One line (checklist S2). */
  body?: ReactNode;
  /** At most one action (checklist S2). */
  action?: ReactNode;
  className?: string;
}

/** What a region says when it has nothing to show: an icon, one line and at most one action. */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={['ow-empty', className].filter(Boolean).join(' ')}>
      {icon && <Icon icon={icon} size={40} />}
      <p className="ow-empty-title">{title}</p>
      {body && <p className="ow-empty-body">{body}</p>}
      {action && <div className="ow-empty-action">{action}</div>}
    </div>
  );
}

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** What the toolbar acts on, for a screen reader. */
  label: string;
}

/** A row of controls 8px apart; an `ow-toolbar-spacer` child pushes the rest to the end. */
export function Toolbar({ label, className, children, ...rest }: ToolbarProps): JSX.Element {
  return <div role="toolbar" aria-label={label} className={['ow-toolbar', className].filter(Boolean).join(' ')} {...rest}>{children}</div>;
}

/** A key or chord, such as ⌘K, in the mono face. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <kbd className={['ow-kbd', className].filter(Boolean).join(' ')}>{children}</kbd>;
}
