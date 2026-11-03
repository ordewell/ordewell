import type * as Monaco from 'monaco-editor';
import { buildTheme, EDITOR_FONT, EDITOR_FONT_SIZE, EDITOR_LINE_HEIGHT, THEME_NAME } from './theme';

/**
 * Monaco, set up once for the app: its workers, its themes and its font. The
 * Explorer's file tab uses it today, and the Changes and Git slices draw their
 * diffs with `createDiffEditor` from here rather than setting Monaco up again.
 *
 * Monaco is a large module, so it loads on the first editor, not at start-up.
 */

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | undefined;

/**
 * Monaco's workers are bundled files of the app, so `script-src 'self'` serves
 * them (shared/csp.ts). The specifiers are written for Monaco's `exports` map,
 * which serves `monaco-editor/<path>.js` from `esm/vs/<path>.js`; the
 * `esm/vs/...` path the docs show does not resolve under it.
 */
async function installWorkers(): Promise<void> {
  const [editor, json, css, html, ts] = await Promise.all([
    import('monaco-editor/editor/editor.worker.js?worker'),
    import('monaco-editor/language/json/json.worker.js?worker'),
    import('monaco-editor/language/css/css.worker.js?worker'),
    import('monaco-editor/language/html/html.worker.js?worker'),
    import('monaco-editor/language/typescript/ts.worker.js?worker'),
  ]);
  (self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker {
      switch (label) {
        case 'json': return new json.default();
        case 'css': case 'scss': case 'less': return new css.default();
        case 'html': case 'handlebars': case 'razor': return new html.default();
        case 'typescript': case 'javascript': return new ts.default();
        default: return new editor.default();
      }
    },
  };
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

/** (Re)defines the one theme from the live tokens; Monaco restyles open editors on `setTheme`. */
export function applyTheme(monaco: MonacoApi): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  monaco.editor.defineTheme(THEME_NAME, buildTheme(readToken, dark));
  monaco.editor.setTheme(THEME_NAME);
}

export function loadMonaco(): Promise<MonacoApi> {
  loading ??= (async () => {
    await installWorkers();
    const monaco = await import('monaco-editor');
    applyTheme(monaco);
    // The theme follows the OS, or the user's preference main hands the OS (prefs.theme).
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(monaco));
    return monaco;
  })();
  // A failed load is tried again on the next editor rather than cached.
  loading.catch(() => { loading = undefined; });
  return loading;
}

const BASE_OPTIONS: Monaco.editor.IEditorConstructionOptions & Monaco.editor.IDiffEditorConstructionOptions = {
  fontFamily: EDITOR_FONT,
  fontSize: EDITOR_FONT_SIZE,
  lineHeight: EDITOR_LINE_HEIGHT,
  fontLigatures: false,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderWhitespace: 'selection',
  smoothScrolling: false,
  padding: { top: 8, bottom: 8 },
  // The OS's reduced-motion setting, honoured by the editor's own animations.
  cursorSmoothCaretAnimation: 'off',
};

export interface ModelSource {
  /**
   * Names the model: two views of one file in two scopes need two, or they would
   * share one buffer. Its extension picks the language.
   */
  key: string;
  /** The path whose extension picks the language. */
  path: string;
  text: string;
}

function modelFor(monaco: MonacoApi, source: ModelSource): Monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme: 'ordewell', authority: encodeURIComponent(source.key), path: `/${source.path}` });
  // A closed tab's model is disposed with its editor, but a reopened one must not collide with a straggler.
  monaco.editor.getModel(uri)?.dispose();
  return monaco.editor.createModel(source.text, undefined, uri);
}

export interface EditorOptions {
  source: ModelSource;
  readOnly: boolean;
  /** Cmd/Ctrl+S inside the editor. */
  onSave?(): void;
  onChange?(text: string): void;
}

export interface EditorHandle {
  getText(): string;
  /** Replaces the buffer, as after a reload; fires no change. */
  setText(text: string): void;
  setReadOnly(readOnly: boolean): void;
  revealLine(line: number): void;
  focus(): void;
  dispose(): void;
}

/** One file in Monaco. Read-only in a scope that has no files on disk, an editor in the checkout. */
export function createEditor(monaco: MonacoApi, host: HTMLElement, options: EditorOptions): EditorHandle {
  const model = modelFor(monaco, options.source);
  const editor = monaco.editor.create(host, { ...BASE_OPTIONS, model, readOnly: options.readOnly, domReadOnly: options.readOnly });
  let applying = false;
  const subscription = model.onDidChangeContent(() => { if (!applying) options.onChange?.(model.getValue()); });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { options.onSave?.(); });
  return {
    getText: () => model.getValue(),
    setText: (text) => { applying = true; try { model.setValue(text); } finally { applying = false; } },
    setReadOnly: (readOnly) => { editor.updateOptions({ readOnly, domReadOnly: readOnly }); },
    revealLine: (line) => { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); },
    focus: () => { editor.focus(); },
    dispose: () => { subscription.dispose(); editor.dispose(); model.dispose(); },
  };
}

export interface DiffEditorOptions {
  original: ModelSource;
  modified: ModelSource;
  /** False shows the two sides in one column. */
  sideBySide?: boolean;
  /** The modified side is editable, as in the checkout; the Changes slice decides. */
  editable?: boolean;
  onChange?(text: string): void;
}

export interface DiffEditorHandle {
  getModifiedText(): string;
  setSideBySide(sideBySide: boolean): void;
  dispose(): void;
}

/** A diff of two texts, for the Changes and Git slices. */
export function createDiffEditor(monaco: MonacoApi, host: HTMLElement, options: DiffEditorOptions): DiffEditorHandle {
  const original = modelFor(monaco, options.original);
  const modified = modelFor(monaco, options.modified);
  const editor = monaco.editor.createDiffEditor(host, {
    ...BASE_OPTIONS,
    readOnly: !options.editable,
    originalEditable: false,
    renderSideBySide: options.sideBySide ?? true,
    useInlineViewWhenSpaceIsLimited: true,
  });
  editor.setModel({ original, modified });
  const subscription = modified.onDidChangeContent(() => { options.onChange?.(modified.getValue()); });
  return {
    getModifiedText: () => modified.getValue(),
    setSideBySide: (sideBySide) => { editor.updateOptions({ renderSideBySide: sideBySide }); },
    dispose: () => { subscription.dispose(); editor.dispose(); original.dispose(); modified.dispose(); },
  };
}
