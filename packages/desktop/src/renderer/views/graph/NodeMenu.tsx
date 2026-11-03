import { useEffect, useRef } from 'react';
import type { NodeCommand, NodeCommandId } from './nodeCommands';

export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * The node's context menu, a menu in the ARIA sense: arrows and Home/End move,
 * Esc and Tab close, and focus goes back to the node it came from.
 */
export function NodeMenu({ commands, at, label, onPick, onClose }: {
  commands: readonly NodeCommand[];
  at: MenuAnchor;
  label: string;
  onPick(id: NodeCommandId): void;
  onClose(): void;
}): JSX.Element {
  const list = useRef<HTMLUListElement>(null);
  const items = (): HTMLButtonElement[] => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    items()[0]?.focus();
    const away = (event: PointerEvent): void => {
      if (!list.current?.contains(event.target as Node)) onClose();
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
