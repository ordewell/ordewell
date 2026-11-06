import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { FileWarning } from 'lucide-react';
import { EmptyState } from '@ordewell/ui/design';
import { createEditor, loadMonaco, type EditorHandle } from '../../monaco';

export interface EditorPaneProps {
  /** Names the model: one per tab, so a file open in two scopes is two buffers. */
  modelKey: string;
  path: string;
  /** The text to show; a change replaces the buffer (a reload), it does not fire `onChange`. */
  text: string;
  readOnly: boolean;
  onChange?(text: string): void;
  onSave?(): void;
  handle: MutableRefObject<EditorHandle | undefined>;
  /** Called once the editor exists, so the tab can reveal a line or focus it. */
  onReady?(handle: EditorHandle): void;
}

/** One Monaco editor in a div; Monaco itself loads on the first one (monaco/index.ts). */
export function EditorPane({ modelKey, path, text, readOnly, onChange, onSave, handle, onReady }: EditorPaneProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string>();
  // Callbacks change every render; the editor is made once and calls the latest.
  const callbacks = useRef({ onChange, onSave, onReady });
  callbacks.current = { onChange, onSave, onReady };
  // Monaco loads asynchronously: what it opens with is what the props say by then.
  const latest = useRef({ text, readOnly });
  latest.current = { text, readOnly };

  useEffect(() => {
    let disposed = false;
    let created: EditorHandle | undefined;
    loadMonaco().then(
      (monaco) => {
        if (disposed || !host.current) return;
        created = createEditor(monaco, host.current, {
          source: { key: modelKey, path, text: latest.current.text },
          readOnly: latest.current.readOnly,
          onChange: (value) => callbacks.current.onChange?.(value),
          onSave: () => callbacks.current.onSave?.(),
        });
        handle.current = created;
        callbacks.current.onReady?.(created);
      },
      (error: unknown) => { if (!disposed) setFailed(error instanceof Error ? error.message : String(error)); },
    );
    return () => {
      disposed = true;
      created?.dispose();
      handle.current = undefined;
    };
  }, [modelKey, path, handle]);

  useEffect(() => {
    const editor = handle.current;
    if (editor && editor.getText() !== text) editor.setText(text);
  }, [text, handle]);

  useEffect(() => { handle.current?.setReadOnly(readOnly); }, [readOnly, handle]);

  if (failed) return <div className="fv-state"><EmptyState icon={FileWarning} title="The editor could not load" body={failed} /></div>;
  return <div ref={host} className="ft-editor" data-testid="monaco-host" />;
}
