import { vi } from 'vitest';
import type { EditorHandle } from '../monaco';

export interface FakeEditor extends EditorHandle {
  readOnly: boolean;
  /** What the user typing would do. */
  type(text: string): void;
  save(): void;
}

export const editors: FakeEditor[] = [];

/**
 * Monaco does not run in jsdom (no layout, and its workers come from Vite), so
 * a test swaps `../monaco` for this: an editor that is a string and two callbacks.
 */
export function fakeMonacoModule(): { loadMonaco: () => Promise<object>; createEditor: (...args: unknown[]) => EditorHandle } {
  return {
    loadMonaco: async () => ({}),
    createEditor: vi.fn((_monaco: unknown, host: unknown, options: unknown) => {
      const { source, readOnly, onChange, onSave } = options as {
        source: { text: string }; readOnly: boolean; onChange?(t: string): void; onSave?(): void;
      };
      let text = source.text;
      const editor: FakeEditor = {
        readOnly,
        getText: () => text,
        setText: (next) => { text = next; (host as HTMLElement).textContent = next; },
        setReadOnly: (next) => { editor.readOnly = next; },
        revealLine: vi.fn(),
        focus: vi.fn(),
        dispose: () => { const at = editors.indexOf(editor); if (at >= 0) editors.splice(at, 1); },
        type: (next) => { text = next; onChange?.(next); },
        save: () => onSave?.(),
      };
      (host as HTMLElement).textContent = text;
      editors.push(editor);
      return editor;
    }),
  };
}
