import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { describeError, filesApi, FilesError, type FileContent, type ReadTarget } from '../../files/api';
import type { FrameApi, Tab, Unregister, ViewScope } from '../../frame/api';
import type { EditorHandle } from '../../monaco';
import { scopeName } from '../scope/scopeStore';
import { useScope } from '../scope/useScope';
import { clearDraft, getDraft, setDraft, stripDirtyMark, withDirtyMark } from './drafts';
import { EditorPane } from './EditorPane';
import { onLineRequest, openFile, parseFileTabId, takeLine } from './fileTabs';
import { revealLabel } from './shellLabels';
import './explorer.css';

const CHECKOUT: ViewScope = { kind: 'checkout' };

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string; gone: boolean }
  | { status: 'ready'; content: FileContent };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the user is told when the file on disk is not the one the buffer was read from. */
type Conflict = 'changed' | 'stale';

function FileTab({ api, tab }: { api: FrameApi; tab: Tab }): JSX.Element {
  const { repo, path } = parseFileTabId(tab.id);
  const scope = tab.scope ?? CHECKOUT;
  const editable = scope.kind === 'checkout';
  const { store, state } = useScope(api);
  const target: ReadTarget = { workspace: api.workspace, repo, scope };
  const targetRef = useRef(target);
  targetRef.current = target;

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // What the editor shows, which is the file's text on disk until the user types.
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<Conflict>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const editor = useRef<EditorHandle>();
  const baseHash = useRef<string | null>(null);
  const savedText = useRef('');
  // The buffer as last typed: the editor is already gone when the tab's own cleanup runs.
  const typed = useRef<string>();
  const baseTitle = stripDirtyMark(tab.title);

  const retitle = useCallback((marked: boolean): void => {
    api.openTab({ kind: tab.kind, id: tab.id, title: withDirtyMark(baseTitle, marked), ...(tab.scope ? { scope: tab.scope } : {}) }, { preview: false });
  }, [api, tab.kind, tab.id, tab.scope, baseTitle]);

  const dirtyNow = useRef(false);
  const markDirty = useCallback((now: boolean): void => {
    if (dirtyNow.current === now) return;
    dirtyNow.current = now;
    setDirty(now);
    retitle(now);
  }, [retitle]);

  /** Reads the file, and with it any draft left by a tab that was looked away from (drafts.ts). */
  const read = useCallback(async (): Promise<void> => {
    try {
      const content = await filesApi.content(targetRef.current, path);
      if (content.kind !== 'text') { setLoad({ status: 'ready', content }); return; }
      const draft = editable ? getDraft(tab.key) : undefined;
      if (draft) {
        savedText.current = content.text;
        typed.current = draft.text;
        baseHash.current = draft.baseHash;
        setText(draft.text);
        dirtyNow.current = true;
        setDirty(true);
        // The edits began from another version of the file than the one on disk now.
        if (draft.baseHash !== content.hash) setConflict('changed');
        setLoad({ status: 'ready', content });
        return;
      }
      baseHash.current = content.hash;
      savedText.current = content.text;
      typed.current = undefined;
      setText(content.text);
      // `text` may not change (a revert to what was loaded), so the editor is told directly.
      editor.current?.setText(content.text);
      dirtyNow.current = false;
      setDirty(false);
      setConflict(undefined);
      setLoad({ status: 'ready', content });
    } catch (error) {
      const gone = error instanceof FilesError && error.code === 'gone';
      if (gone) store.fallBack(repo, describeError(error));
      setLoad({ status: 'error', message: describeError(error), gone });
    }
  }, [editable, path, repo, store, tab.key]);

  useEffect(() => {
    setLoad({ status: 'loading' });
    void read();
    // A tab is one file in one scope; a change of either is a different tab.
  }, [read]);

  // The checkout changes under the user's feet; look again when they come back to the window.
  useEffect(() => {
    if (!editable) return;
    const onFocus = (): void => {
      void (async () => {
        try {
          const content = await filesApi.content(targetRef.current, path);
          if (content.kind !== 'text' || content.hash === baseHash.current) return;
          if ((typed.current ?? savedText.current) !== savedText.current) { setConflict('changed'); return; }
          // Nothing unsaved: take the disk's version quietly and say so.
          baseHash.current = content.hash;
          savedText.current = content.text;
          setText(content.text);
          setLoad({ status: 'ready', content });
          api.announce(`${baseTitle} reloaded: it changed on disk.`);
        } catch { /* a file that went away is reported when it is next saved */ }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [editable, path, api, baseTitle]);

  // A draft outlives the tab being looked away from (drafts.ts).
  useEffect(() => () => {
    if (typed.current !== undefined && typed.current !== savedText.current) setDraft(tab.key, { text: typed.current, baseHash: baseHash.current });
  }, [tab.key]);

  useEffect(() => {
    const show = (key: string): void => {
      // Monaco loads after the file does; a line asked for before the editor exists stays pending for onReady.
      if (key !== tab.key || !editor.current) return;
      const line = takeLine(key);
      if (line !== undefined) editor.current?.revealLine(line);
    };
    show(tab.key);
    return onLineRequest(show);
  }, [tab.key, load.status]);

  const onChange = (value: string): void => {
    typed.current = value;
    const changed = value !== savedText.current;
    markDirty(changed);
    if (changed) setDraft(tab.key, { text: value, baseHash: baseHash.current });
    else clearDraft(tab.key);
  };

  const save = async (overwrite = false): Promise<void> => {
    const current = editor.current;
    if (!editable || !current || saving) return;
    const next = current.getText();
    setSaving(true);
    try {
      let hash = baseHash.current;
      if (overwrite) {
        // The user chose to replace what is on disk: save against what is there now.
        const onDisk = await filesApi.content(targetRef.current, path);
        hash = onDisk.kind === 'text' ? onDisk.hash : null;
      }
      await filesApi.save(api.workspace, repo, path, next, hash);
      // The save route answers no hash; read it back so the next save has its base.
      const content = await filesApi.content(targetRef.current, path);
      if (content.kind === 'text') baseHash.current = content.hash;
      savedText.current = next;
      typed.current = undefined;
      clearDraft(tab.key);
      setConflict(undefined);
      setSaveError(undefined);
      markDirty(false);
      api.announce(`Saved ${baseTitle}.`);
    } catch (error) {
      if (error instanceof FilesError && error.code === 'stale') setConflict('stale');
      else { api.announce(describeError(error)); setSaveError(describeError(error)); }
    } finally {
      setSaving(false);
    }
  };

  const discardEdits = (): void => {
    clearDraft(tab.key);
    typed.current = undefined;
    setConflict(undefined);
    markDirty(false);
    setSaveError(undefined);
    void read();
  };

  const shell = async (action: 'reveal' | 'openInEditor'): Promise<void> => {
    const result = await window.ordewell.shell[action]({ repo, path });
    if (!result.ok) api.announce(result.message ?? 'That did not work.');
  };

  if (load.status === 'loading') return <p className="frame-empty">Loading {baseTitle}…</p>;
  if (load.status === 'error') {
    return (
      <div className="ft ft-message">
        <p className="frame-empty error" role="alert">{load.message}</p>
        {!editable && (
          <button type="button" className="ft-button" onClick={() => openFile(api, repo, path, CHECKOUT, { preview: false })}>Open Your checkout</button>
        )}
      </div>
    );
  }

  const { content } = load;
  const label = `${repo === '.' ? '' : `${repo}/`}${path}`;
  return (
    <div className="ft">
      <div className="ft-bar">
        <span className="ft-path" title={label}>{label}</span>
        <span className="ft-scope">{scopeName(scope, state.session)}</span>
        {dirty && <span className="ft-dirty" role="status">Unsaved changes</span>}
        <span className="ft-spacer" />
        {editable && content.kind === 'text' && dirty && (
          <button type="button" className="ft-button" onClick={discardEdits}>Revert</button>
        )}
        {editable && content.kind === 'text' && (
          <button type="button" className="ft-button ft-primary" disabled={!dirty || saving} onClick={() => void save()}>Save</button>
        )}
        {editable && <button type="button" className="ft-button" onClick={() => void shell('openInEditor')}>Open in editor</button>}
        {editable && <button type="button" className="ft-button" onClick={() => void shell('reveal')}>{revealLabel(api.platform)}</button>}
      </div>
      {!editable && (
        <div className="ft-banner" role="note">
          <span>Read-only: this is {scopeName(scope, state.session)}.</span>
          <button type="button" className="ft-button" onClick={() => openFile(api, repo, path, CHECKOUT, { preview: false })}>Open Your checkout</button>
        </div>
      )}
      {conflict && (
        <div className="ft-banner ft-conflict" role="alert">
          <span>
            {conflict === 'stale'
              ? `${baseTitle} changed on disk since you opened it, so it was not saved.`
              : `${baseTitle} changed on disk while you have unsaved changes.`}
          </span>
          <button type="button" className="ft-button" onClick={discardEdits}>Reload from disk</button>
          <button type="button" className="ft-button" onClick={() => void save(true)}>Overwrite the file</button>
        </div>
      )}
      {saveError && !conflict && <p className="ft-banner ft-conflict" role="alert">{saveError}</p>}
      {content.kind === 'text' ? (
        <EditorPane
          modelKey={tab.key}
          path={path}
          text={text}
          readOnly={!editable}
          handle={editor}
          onChange={onChange}
          onSave={() => void save()}
          onReady={() => { const line = takeLine(tab.key); if (line !== undefined) editor.current?.revealLine(line); }}
        />
      ) : (
        <div className="ft-message">
          <p className="frame-empty">
            {content.kind === 'binary'
              ? `This is a binary file (${formatSize(content.size)}), so it is not shown.`
              : `This file is ${formatSize(content.size)}, over the ${formatSize(content.limit)} the viewer opens.`}
          </p>
          {editable && <button type="button" className="ft-button" onClick={() => void shell('openInEditor')}>Open in editor</button>}
        </div>
      )}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'file', icon: FileText, render: (tab) => <FileTab api={api} tab={tab} /> });
}
