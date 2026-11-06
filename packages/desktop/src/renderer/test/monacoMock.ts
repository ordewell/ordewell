import { vi } from 'vitest';
import type { DiffEditorHandle, DiffEditorOptions, EditorHandle } from '../monaco';

export interface FakeEditor extends EditorHandle {
  readOnly: boolean;
  /** What the user typing would do. */
  type(text: string): void;
  save(): void;
}

export const editors: FakeEditor[] = [];

export interface FakeDiffEditor extends DiffEditorHandle {
  options: DiffEditorOptions;
  host: HTMLElement;
  sideBySide: boolean;
}

export const diffEditors: FakeDiffEditor[] = [];

/**
 * Monaco does not run in jsdom (no layout, and its workers come from Vite), so
 * a test swaps `../monaco` for this: an editor that is a string and two callbacks.
 */
export function fakeMonacoModule(): {
  loadMonaco: () => Promise<object>;
  createEditor: (...args: unknown[]) => EditorHandle;
  createDiffEditor: (...args: unknown[]) => DiffEditorHandle;
} {
  return {
    loadMonaco: async () => ({}),
    // A diff is its two texts written into the host; a zone is its node appended there, so a test finds it by role.
    createDiffEditor: vi.fn((_monaco: unknown, host: unknown, options: unknown) => {
      const element = host as HTMLElement;
      const opts = options as DiffEditorOptions;
      const text = document.createElement('pre');
      text.textContent = `${opts.original.text}\n${opts.modified.text}`;
      element.append(text);
      const editor: FakeDiffEditor = {
        options: opts,
        host: element,
        sideBySide: opts.sideBySide ?? true,
        getModifiedText: () => opts.modified.text,
        setSideBySide: vi.fn((next: boolean) => { editor.sideBySide = next; }),
        goToChange: vi.fn(),
        addZone: (_side, _afterLine, node) => { element.append(node); return { remove: () => node.remove() }; },
        focus: vi.fn(),
        dispose: () => { text.remove(); const at = diffEditors.indexOf(editor); if (at >= 0) diffEditors.splice(at, 1); },
      };
      diffEditors.push(editor);
      return editor;
    }),
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
