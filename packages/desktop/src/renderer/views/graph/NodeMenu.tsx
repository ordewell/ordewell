import { useEffect, useRef, type RefObject } from 'react';

export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * A card's small menu, a menu in the ARIA sense: arrows and Home/End move,
 * Esc and Tab close, and focus goes back to the card it came from. It holds
 * the card's commands, or the dependencies ← and → can go to. The task tab's
 * ⋯ opens it too.
 */
export function NodeMenu<T extends string>({ commands, at, label, anchor, onPick, onClose }: {
  commands: readonly { id: T; label: string }[];
  at: MenuAnchor;
  label: string;
  /** The button that toggles the menu: a press on it is its own click's to answer, or the click would open the menu again. */
  anchor?: RefObject<HTMLElement>;
  onPick(id: T): void;
  onClose(): void;
}): JSX.Element {
  const list = useRef<HTMLUListElement>(null);
  const items = (): HTMLButtonElement[] => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    items()[0]?.focus();
    const away = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !anchor?.current?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
    // Opening is the only time the menu focuses and listens; a re-render must not steal focus back.
  }, []);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (to: number): void => { event.preventDefault(); all[(to + all.length) % all.length]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': return go(index + 1);
      case 'ArrowUp': return go(index - 1);
      case 'Home': return go(0);
      case 'End': return go(all.length - 1);
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        onClose();
    }
  };

  return (
    <ul ref={list} className="graph-menu" role="menu" aria-label={label} style={{ left: at.x, top: at.y }} onKeyDown={onKeyDown}>
      {commands.map((command) => (
        <li key={command.id} role="none">
          <button type="button" role="menuitem" onClick={() => onPick(command.id)}>{command.label}</button>
        </li>
      ))}
    </ul>
  );
}
