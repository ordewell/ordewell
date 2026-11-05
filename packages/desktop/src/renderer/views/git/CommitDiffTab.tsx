import { useEffect, useRef, useState } from 'react';
import { FileDiff as FileDiffIcon, FileX } from 'lucide-react';
import { Button, EmptyState } from '@ordewell/ui/design';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { createDiffEditor, loadMonaco, type DiffEditorHandle } from '../../monaco';
import { messageOf } from '../../session/daemon';
import { all } from '../Stub';
import { diffSides, parsePatch, type DiffSides } from '../changes/changesModel';
import '../diffKit.css';
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
      case 'loading': return <EmptyState className="dk-state" icon={FileDiffIcon} title="Loading the diff…" />;
      case 'error':
        return <EmptyState className="dk-state" icon={FileX} title={read.message} action={<Button onClick={() => setRound((n) => n + 1)}>Try again</Button>} />;
      case 'binary': return <EmptyState className="dk-state" icon={FileX} title="This is a binary file, so its change is not shown." />;
      case 'none': return <EmptyState className="dk-state" icon={FileX} title="This commit changes this file’s mode or name only, so there are no lines to show." />;
      case 'text':
        if (failed) return <EmptyState className="dk-state" icon={FileX} title={`The diff editor could not load: ${failed}`} />;
        return <div ref={hostNode} className="dk-editor" data-testid="monaco-diff-host" />;
    }
  };

  const label = `${repo === '.' ? '' : `${repo}/`}${path}`;
  return (
    <div className="dk">
      <div className="dk-bar">
        <span className="dk-path" title={label}>{label}</span>
        <span className="dk-commit">commit {shortSha(sha)}</span>
        <span className="dk-spacer" />
        <div className="dk-toggle" role="group" aria-label="Layout">
          <Button size="sm" aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Unified</Button>
          <Button size="sm" aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</Button>
        </div>
        <Button size="sm" disabled={!editor} onClick={() => editor?.goToChange('previous')}>Previous change</Button>
        <Button size="sm" disabled={!editor} onClick={() => editor?.goToChange('next')}>Next change</Button>
      </div>
      {sides && <p className="dk-banner" role="note">Only the changed lines are shown: this commit’s files are not checked out.</p>}
      {body()}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return all(api.registerTabKind({ kind: 'commit-diff', icon: FileDiffIcon, render: (tab) => <CommitDiff key={tab.key} api={api} tab={tab} /> }));
}
