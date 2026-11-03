import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Command } from './api';
import { formatChord, isMac, parseChord } from './keys';
import { useFrameStore } from './store';

/** Every word typed appears in the title or the id, in any order. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const text = `${command.title} ${command.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * Cmd/Ctrl+K: every enabled command by name. A combobox over a listbox, so
 * focus stays in the field while the arrows move the choice; Escape and a run
 * both give focus back to where it was.
 */
export function CommandPalette(): JSX.Element {
  const store = useFrameStore();
  const mac = isMac(store.platform);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Read once: the list is what could run when the palette opened.
  const [all] = useState(() => store.enabledCommands().filter((command) => command.id !== 'palette.open'));
  const shown = useMemo(() => filterCommands(all, query), [all, query]);
  const index = Math.min(chosen, Math.max(0, shown.length - 1));

  const before = useRef<HTMLElement>();

  useEffect(() => {
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    input.current?.focus();
    // Closed some other way, such as by the shortcut again: focus would be left on nothing.
    return () => {
      if (!document.activeElement || document.activeElement === document.body) before.current?.focus();
    };
  }, []);

  const close = (): void => {
    if (before.current?.isConnected) before.current.focus();
    store.setOverlay(undefined);
  };
  const run = (command: Command | undefined): void => {
    if (!command) return;
    // Closed first, so focus is back before the command moves it on.
    close();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (shown.length === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setChosen((index + step + shown.length) % shown.length);
        return;
      }
      case 'Enter':
        event.preventDefault();
        run(shown[index]);
        return;
      case 'Escape':
        event.preventDefault();
        close();
        return;
      case 'Tab':
        // The field is the dialog's one stop: Tab stays in it.
        event.preventDefault();
        return;
    }
  };

  const optionId = (command: Command): string => `palette-${command.id}`;

  return (
    <div className="frame-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="frame-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="frame-palette-input"
          type="text"
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls="frame-palette-list"
          aria-autocomplete="list"
          aria-activedescendant={shown[index] ? optionId(shown[index]) : undefined}
          placeholder="Type a command"
          spellCheck={false}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setChosen(0); }}
          onKeyDown={onKeyDown}
        />
        <ul id="frame-palette-list" className="frame-palette-list" role="listbox" aria-label="Commands">
          {shown.map((command, at) => (
            <li
              key={command.id}
              id={optionId(command)}
              role="option"
              aria-selected={at === index}
              className={at === index ? 'frame-palette-chosen' : undefined}
              onMouseMove={() => { if (at !== index) setChosen(at); }}
              onClick={() => run(command)}
            >
              <span>{command.title}</span>
              {command.keys && <kbd>{formatChord(parseChord(command.keys), mac)}</kbd>}
            </li>
          ))}
          {shown.length === 0 && <li className="frame-empty" role="presentation">No command matches.</li>}
        </ul>
      </div>
    </div>
  );
}
