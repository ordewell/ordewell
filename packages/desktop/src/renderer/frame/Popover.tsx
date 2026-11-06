import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

export const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** A title-bar menu: arrow keys, Home and End move between its items, as a menu's do. */
export function onMenuKey(event: KeyboardEvent<HTMLElement>): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    .filter((item) => item === document.activeElement || (item.checkVisibility?.() ?? true));
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'ArrowDown' ? (at + 1) % items.length
    : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
      : event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : undefined;
  if (next === undefined) return;
  event.preventDefault();
  items[next]?.focus();
}

interface PopoverProps {
  label: string;
  /** The control that opened it: focus goes back there when it closes. */
  anchor: RefObject<HTMLElement>;
  onClose(): void;
  role?: 'dialog' | 'menu';
  className?: string;
  children: ReactNode;
}

/**
 * A panel hung from a title-bar control. It takes focus when it opens, gives
 * it back to its control when Escape or a click elsewhere closes it.
 */
export function Popover({ label, anchor, onClose, role = 'dialog', className, children }: PopoverProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const root = panel.current;
    // The first control drawn: one the stylesheet hides (the ⋯ menu's scope chip above its breakpoint) would take focus out of sight, and Escape with it.
    const first = [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((element) => element.checkVisibility?.() ?? true);
    (first ?? root)?.focus();
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && !root?.contains(target) && !anchor.current?.contains(target)) close.current();
    };
    document.addEventListener('mousedown', outside);
    const control = anchor.current;
    return () => {
      document.removeEventListener('mousedown', outside);
      // Only when focus was inside: a click elsewhere has already put it where the user wanted.
      if (!document.activeElement || document.activeElement === document.body || root?.contains(document.activeElement)) control?.focus();
    };
  }, [anchor]);

  return (
    <div
      ref={panel}
      className={['frame-popover', className].filter(Boolean).join(' ')}
      role={role}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {children}
    </div>
  );
}
