import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconComponent } from './Icon';

/**
 * `primary` is the one filled button a view has (checklist A2); `danger` is a
 * destructive action's, which asks first; `ghost` sits in a row or toolbar.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** 24, 28 and 36px: small in rows, default everywhere, large on Welcome and in dialogs. */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leads the label, 16px, 8px from it. */
  icon?: IconComponent;
  /**
   * An operation this button started is pending: the icon turns, `aria-busy`
   * says so, and the button refuses a second press. It stays at full strength,
   * unlike a disabled one, so it reads as working and not as unavailable.
   */
  busy?: boolean;
  children: ReactNode;
}

/**
 * A labelled button. Icon and label are a flex row with a gap, never a margin,
 * and the label is the one part that shrinks, to an ellipsis, so no text can
 * run under the icon (design.md, Layout rules that prevent overlap).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy, children, className, type = 'button', disabled, ...rest },
  ref,
) {
  const classes = ['ow-button', `ow-button-${variant}`, `ow-button-${size}`, className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon && <Icon icon={icon} size={16} className={busy ? 'ow-spin' : undefined} />}
      <span className="ow-button-label">{children}</span>
    </button>
  );
});
