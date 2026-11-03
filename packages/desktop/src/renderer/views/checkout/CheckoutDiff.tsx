import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FrameApi, Tab } from '../../frame/api';
import { createDiffEditor, loadMonaco, type DiffEditorHandle } from '../../monaco';
import { stageHunks, unstageHunks, stagePaths, unstagePaths, readCheckoutDiff, describeGitError, type CheckoutDiff as CheckoutDiffData } from './checkoutData';
import { onCheckoutChange, notifyCheckoutChange } from './checkoutEvents';
import { hunkAfterLine, sliceHunk } from './checkoutModel';
import { parseCheckoutDiffTabId } from './checkoutTabs';
import '../explorer/explorer.css';
import './checkout.css';

/*
 * One file of the user's checkout as a Monaco diff (design W10): the working
 * tree against the index, or the index against HEAD. Each hunk carries its own
 * stage or unstage action, cut from the patch on screen (ADR-0062 G3).
 */

function Zone({ editor, afterLine, children }: { editor: DiffEditorHandle; afterLine: number; children: ReactNode }): JSX.Element {
  const [node] = useState(() => {
    const div = document.createElement('div');
    div.className = 'checkout-hunk';
    div.addEventListener('keydown', (event) => { event.stopPropagation(); });
    return div;
  });
  useEffect(() => {
    const zone = editor.addZone('modified', afterLine, node);
    return () => { zone.remove(); };
  }, [editor, afterLine, node]);
  return createPortal(children, node);
}

export function CheckoutDiff({ api, tab }: { api: FrameApi; tab: Tab }): JSX.Element {
  const parsed = parseCheckoutDiffTabId(tab.id);
  if (!parsed) return <p className="frame-empty">This diff does not name a file.</p>;
  return <CheckoutFileDiff api={api} tab={tab} repo={parsed.repo} path={parsed.path} kind={parsed.kind} />;
}

function CheckoutFileDiff({ api, tab, repo, path, kind }: {
  api: FrameApi;
  tab: Tab;
  repo: string;
  path: string;
  kind: 'staged' | 'unstaged';
}): JSX.Element {
  const [diff, setDiff] = useState<CheckoutDiffData>();
  const [round, setRound] = useState(0);
  const [sideBySide, setSideBySide] = useState(true);
  const [editor, setEditor] = useState<DiffEditorHandle>();
  const [failed, setFailed] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const hostNode = useRef<HTMLDivElement>(null);
  const sideBySideNow = useRef(sideBySide);
  sideBySideNow.current = sideBySide;
  const unstaged = kind === 'unstaged';

  useEffect(() => onCheckoutChange(() => setRound((n) => n + 1)), []);

  useEffect(() => {
    let live = true;
    setDiff(undefined);
    setProblem(undefined);
    void readCheckoutDiff(api.workspace, repo, path, kind).then((next) => { if (live) setDiff(next); });
    return () => { live = false; };
  }, [api.workspace, repo, path, kind, round]);

  const sides = diff?.kind === 'text' ? diff.sides : undefined;
  const hunks = diff?.kind === 'text' && !diff.untracked ? diff.patch.hunks : [];

  useEffect(() => {
    if (!sides) return;
    let disposed = false;
    let created: DiffEditorHandle | undefined;
    loadMonaco().then(
      (monaco) => {
        if (disposed || !hostNode.current) return;
        created = createDiffEditor(monaco, hostNode.current, {
          original: { key: `${tab.key}#checkout-original`, path, text: sides.original },
          modified: { key: `${tab.key}#checkout-modified`, path, text: sides.modified },
          sideBySide: sideBySideNow.current,
        });
        setEditor(created);
      },
      (error: unknown) => { if (!disposed) setFailed(describeGitError(error)); },
    );
    return () => {
      disposed = true;
      created?.dispose();
      setEditor(undefined);
    };
  }, [sides, tab.key, path]);

  useEffect(() => { editor?.setSideBySide(sideBySide); }, [editor, sideBySide]);

  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setProblem(undefined);
    try {
      await action();
      api.announce(unstaged ? 'Staged.' : 'Unstaged.');
      notifyCheckoutChange();
    } catch (error) {
      setProblem(describeGitError(error));
      setRound((n) => n + 1);
    } finally {
      setBusy(undefined);
    }
  }, [api, unstaged]);

  const applyHunk = (index: number): void => {
    if (!diff || diff.kind !== 'text') return;
    const hunk = sliceHunk(diff.patchText, index);
    if (!hunk) { setProblem('That hunk is no longer in the patch on screen. Refresh to see the file as it is now.'); return; }
    void run(`hunk:${index}`, () => (unstaged ? stageHunks(api.workspace, repo, hunk) : unstageHunks(api.workspace, repo, hunk)));
  };

  const applyFile = (): void => {
    void run('file', () => (unstaged ? stagePaths(api.workspace, repo, [path]) : unstagePaths(api.workspace, repo, [path])));
  };

  const label = `${repo === '.' ? '' : `${repo}/`}${path}`;
  const fileAction = diff?.kind === 'text' && diff.untracked ? 'Stage file' : unstaged ? 'Stage file' : 'Unstage file';

  const body = (): JSX.Element => {
    if (!diff) return <p className="frame-empty">Loading the diff…</p>;
    switch (diff.kind) {
      case 'error':
        return (
          <div className="ft-message">
            <p className="frame-empty error" role="alert">{diff.message}</p>
            <button type="button" className="ft-button" onClick={() => setRound((n) => n + 1)}>Try again</button>
          </div>
        );
      case 'binary': return <p className="frame-empty">This is a binary file, so its change is not shown.</p>;
      case 'unchanged': return <p className="frame-empty">This file has no change here any more.</p>;
      case 'text':
        if (failed) return <p className="frame-empty error">The diff editor could not load: {failed}</p>;
        return <div ref={hostNode} className="ft-editor" data-testid="monaco-diff-host" />;
    }
  };

  return (
    <div className="ft changes-diff checkout-diff">
      <div className="ft-bar">
        <span className="ft-path" title={label}>{label}</span>
        <span className="checkout-kind">{kind === 'staged' ? 'Staged' : 'Working tree'}</span>
        <span className="ft-spacer" />
        <div className="changes-toggle" role="group" aria-label="Layout">
          <button type="button" className="ft-button" aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Unified</button>
          <button type="button" className="ft-button" aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</button>
        </div>
        <button
          type="button"
          className={unstaged ? 'ft-button ft-primary' : 'ft-button'}
          disabled={!diff || diff.kind !== 'text' || busy !== undefined}
          onClick={applyFile}
        >
          {fileAction}
        </button>
        <button type="button" className="ft-button" onClick={() => setRound((n) => n + 1)}>Refresh</button>
      </div>
      {problem && <p className="ft-banner" role="alert">{problem}</p>}
      {diff?.kind === 'text' && diff.untracked && (
        <p className="ft-banner" role="note">This file is untracked: the whole file is the change.</p>
      )}
      {sides?.partial && (
        <p className="ft-banner" role="note">Only the changed lines are shown: the file as this pair of trees holds it could not be read, or has moved on since.</p>
      )}
      {body()}
      {editor && hunks.map((hunk, index) => (
        <Zone key={`${index}:${hunk.newStart}`} editor={editor} afterLine={hunkAfterLine(sides ?? { lines: { modified: [] } }, hunk)}>
          <div className="checkout-hunk-actions">
            <span className="checkout-hunk-where">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
            <button type="button" className="ft-button" disabled={busy !== undefined} onClick={() => applyHunk(index)}>
              {busy === `hunk:${index}` ? 'Working…' : unstaged ? 'Stage hunk' : 'Unstage hunk'}
            </button>
          </div>
        </Zone>
      ))}
    </div>
  );
}
