import { useEffect, useRef, useState } from 'react';
import { FileDiff as FileDiffIcon } from 'lucide-react';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { createDiffEditor, loadMonaco, type DiffEditorHandle } from '../../monaco';
import { messageOf } from '../../session/daemon';
import { all } from '../Stub';
import { diffSides, parsePatch, type DiffSides } from '../changes/changesModel';
import '../explorer/explorer.css';
import '../changes/changes.css';
import { readCommit } from './gitData';
import { parseCommitDiffTabId, shortSha } from './gitModel';

/*
 * One file of one commit, drawn in the Changes slice's diff editor. A commit
 * is immutable and its files are not checked out, so only the changed hunks
 * are drawn and there is nowhere to comment to.
 */

type Read = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'binary' } | { kind: 'none' } | { kind: 'text'; sides: DiffSides };

function CommitDiff({ api, tab }: { api: FrameApi; tab: Tab }): JSX.Element {
  const { repo, sha, path } = parseCommitDiffTabId(tab.id);
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [sideBySide, setSideBySide] = useState(true);
  const [editor, setEditor] = useState<DiffEditorHandle>();
  const [failed, setFailed] = useState<string>();
  const [round, setRound] = useState(0);
  const hostNode = useRef<HTMLDivElement>(null);
  const sideBySideNow = useRef(sideBySide);
  sideBySideNow.current = sideBySide;

  useEffect(() => {
    let live = true;
    setRead({ kind: 'loading' });
    readCommit(api.workspace, repo, sha, path).then(
      (detail) => {
        if (!live) return;
        const patch = parsePatch(detail.patch ?? '');
        if (patch.binary) setRead({ kind: 'binary' });
        else if (patch.hunks.length === 0) setRead({ kind: 'none' });
        else setRead({ kind: 'text', sides: diffSides(patch, undefined) });
      },
      (error: unknown) => { if (live) setRead({ kind: 'error', message: messageOf(error) }); },
    );
    return () => { live = false; };
  }, [api, repo, sha, path, round]);

  const sides = read.kind === 'text' ? read.sides : undefined;
  useEffect(() => {
    if (!sides) return;
    let disposed = false;
    let created: DiffEditorHandle | undefined;
    loadMonaco().then(
      (monaco) => {
        if (disposed || !hostNode.current) return;
        created = createDiffEditor(monaco, hostNode.current, {
          original: { key: `${tab.key}#original`, path, text: sides.original },
          modified: { key: `${tab.key}#modified`, path, text: sides.modified },
          sideBySide: sideBySideNow.current,
        });
        setEditor(created);
      },
      (error: unknown) => { if (!disposed) setFailed(messageOf(error)); },
    );
    return () => { disposed = true; created?.dispose(); setEditor(undefined); };
  }, [sides, tab.key, path]);

  useEffect(() => { editor?.setSideBySide(sideBySide); }, [editor, sideBySide]);

  const body = (): JSX.Element => {
    switch (read.kind) {
      case 'loading': return <p className="frame-empty">Loading the diff…</p>;
      case 'error':
        return (
          <div className="ft-message">
            <p className="frame-empty error" role="alert">{read.message}</p>
            <button type="button" className="ft-button" onClick={() => setRound((n) => n + 1)}>Try again</button>
          </div>
        );
      case 'binary': return <p className="frame-empty">This is a binary file, so its change is not shown.</p>;
      case 'none': return <p className="frame-empty">This commit changes this file’s mode or name only, so there are no lines to show.</p>;
      case 'text':
        if (failed) return <p className="frame-empty error">The diff editor could not load: {failed}</p>;
        return <div ref={hostNode} className="ft-editor" data-testid="monaco-diff-host" />;
    }
  };

  const label = `${repo === '.' ? '' : `${repo}/`}${path}`;
  return (
    <div className="ft changes-diff">
      <div className="ft-bar">
        <span className="ft-path" title={label}>{label}</span>
        <span className="muted">commit {shortSha(sha)}</span>
        <span className="ft-spacer" />
        <div className="changes-toggle" role="group" aria-label="Layout">
          <button type="button" className="ft-button" aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Unified</button>
          <button type="button" className="ft-button" aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</button>
        </div>
        <button type="button" className="ft-button" disabled={!editor} onClick={() => editor?.goToChange('previous')}>Previous change</button>
        <button type="button" className="ft-button" disabled={!editor} onClick={() => editor?.goToChange('next')}>Next change</button>
      </div>
      {sides && <p className="ft-banner" role="note">Only the changed lines are shown: this commit’s files are not checked out.</p>}
      {body()}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return all(api.registerTabKind({ kind: 'commit-diff', icon: FileDiffIcon, render: (tab) => <CommitDiff key={tab.key} api={api} tab={tab} /> }));
}
