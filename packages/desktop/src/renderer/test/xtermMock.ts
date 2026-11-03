import { vi } from 'vitest';
import type { TermHandle, TermOptions } from '../views/terminal/xterm';

export interface FakeTerm extends TermHandle {
  options: TermOptions;
  /** Everything the shell has written to it. */
  output: string;
  /** What fit() will report. */
  grid: { cols: number; rows: number };
  disposed: boolean;
  element: HTMLElement;
  /** The user typing. */
  type(data: string): void;
  /** The user ctrl-clicking a link. */
  link(url: string): void;
}

export const terms: FakeTerm[] = [];

/**
 * xterm needs a browser's layout, so a test swaps `../xterm` for this: a
 * terminal that is a string of output, a grid size and two callbacks.
 */
export function fakeXtermModule(): { createTerm: (options: TermOptions, mac: boolean) => Promise<TermHandle> } {
  return {
    createTerm: vi.fn(async (options: TermOptions) => {
      const element = document.createElement('div');
      element.className = 'fake-xterm';
      const term: FakeTerm = {
        options,
        output: '',
        grid: { cols: 100, rows: 30 },
        disposed: false,
        element,
        mount: vi.fn((parent: HTMLElement) => { if (element.parentElement !== parent) parent.replaceChildren(element); }),
        write: vi.fn((data: string) => { term.output += data; element.textContent = term.output; }),
        fit: vi.fn(() => term.grid),
        size: () => term.grid,
        focus: vi.fn(),
        setTheme: vi.fn(),
        dispose: vi.fn(() => { term.disposed = true; element.remove(); }),
        type: (data) => options.onData(data),
        link: (url) => options.onLink(url),
      };
      terms.push(term);
      return term;
    }),
  };
}
