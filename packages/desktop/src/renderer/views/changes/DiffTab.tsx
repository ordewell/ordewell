import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FileDiff as FileDiffIcon } from 'lucide-react';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { scopeKey } from '../../frame/layout';
import { createDiffEditor, loadMonaco, type DiffEditorHandle, type DiffLines, type DiffSide } from '../../monaco';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { messageOf } from '../../session/daemon';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { parseFileTabId } from '../explorer/fileTabs';
import { messageTask, readFileDiff, type FileDiff, type ReviewScope } from './changesData';
import { commentMessage, commentPlace, isFinished, type DiffSides, type LineComment } from './changesModel';
import { addComment, commentsKey, useComments, type SentComment } from './comments';
import { repoName } from './preflight';
import '../explorer/explorer.css';
import './changes.css';

/*
 * A Monaco diff of one file as a task or the whole run changed it (design
 * slice 12, ADR-0062): the scope it reads, the two sides, and line comments
 * that go to the task as the person's own message.
 */

/** The diff the person last worked in: what Next and Previous change move through. */
let active: DiffEditorHandle | undefined;

/** A comment widget or a sent comment, drawn between two lines of one side. */
function Zone({ editor, side, afterLine, children }: { editor: DiffEditorHandle; side: DiffSide; afterLine: number; children: ReactNode }): JSX.Element {
  const [node] = useState(() => {
    const div = document.createElement('div');
    div.className = 'changes-zone';
    // Monaco binds keys on its own DOM, and this node lives inside it: what is typed here is the widget's alone.
    div.addEventListener('keydown', (event) => { event.stopPropagation(); });
    return div;
  });
  useEffect(() => {
    const zone = editor.addZone(side, afterLine, node);
    return () => { zone.remove(); };
  }, [editor, side, afterLine, node]);
  return createPortal(children, node);
}

/** Which drawn line shows a line of the file: where a sent comment goes back to. */
function drawnLine(sides: DiffSides, side: DiffSide, line: number): number | undefined {
  const at = sides.lines[side].indexOf(line);
  return at < 0 ? undefined : at + 1;
}

/** The file's own lines a drawn selection covers; undefined when it holds only separators. */
function realLines(sides: DiffSides, lines: DiffLines): { startLine: number; endLine: number } | undefined {
  const numbers = sides.lines[lines.side].slice(lines.startLine - 1, lines.endLine).filter((n) => n > 0);
  if (numbers.length === 0) return undefined;
  return { startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}

interface Draft {
  comment: Omit<LineComment, 'body'>;
  /** The drawn line the widget opens under. */
  afterLine: number;
}

interface CommentBoxProps {
  draft: Draft;
  taskLabel: string;
  finished: boolean;
  send(body: string): Promise<void>;
  askPlanner(body: string): void;
  cancel(): void;
}

function CommentBox({ draft, taskLabel, finished, send, askPlanner, cancel }: CommentBoxProps): JSX.Element {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const empty = body.trim() === '';
  // A finished task reads no more messages: the comment can only become the planner's to act on.
  const toPlanner = finished || failed !== undefined;

  const sendNow = async (): Promise<void> => {
    setSending(true);
    setFailed(undefined);
    try {
      await send(body);
    } catch (error) {
      setFailed(messageOf(error));
      setSending(false);
    }
  };

  const primary = (): void => {
    if (empty || sending) return;
    if (toPlanner) askPlanner(body);
    else void sendNow();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); primary(); }
  };

  return (
    <form className="changes-comment-box" aria-label={`Comment on ${commentPlace(draft.comment)}`} onSubmit={(event) => { event.preventDefault(); primary(); }}>
      <p className="changes-comment-place">{commentPlace(draft.comment)}</p>
      {finished && <p className="changes-comment-note">Task {taskLabel} has finished, so it reads no more messages. Ask the planner instead: it can retry the task or add one.</p>}
      {failed && <p className="changes-comment-note error" role="alert">It did not reach task {taskLabel}: {failed}</p>}
      <textarea
        autoFocus
        aria-label={toPlanner ? 'Comment for the planner' : `Comment to task ${taskLabel}`}
        value={body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKey}
      />
      <div className="changes-comment-actions">
        <button type="button" className="ft-button" onClick={cancel}>Cancel</button>
        {failed && !finished && <button type="button" className="ft-button" disabled={empty || sending} onClick={() => void sendNow()}>Try again</button>}
        <button type="submit" className="ft-button ft-primary" disabled={empty || sending}>
          {toPlanner ? 'Ask the planner' : sending ? 'Sending…' : `Send to task ${taskLabel}`}
        </button>
      </div>
    </form>
  );
}

function Sent({ sent }: { sent: SentComment }): JSX.Element {
  return (
    <div className="changes-comment" role="note" aria-label={`Comment on ${commentPlace(sent.comment)}`}>
      <span className="changes-comment-to">{sent.to === 'task' ? `Sent to ${sent.recipient}` : 'Put in the planner’s composer'} · {commentPlace(sent.comment)}</span>
      <p>{sent.comment.body}</p>
    </div>
  );
}

/** What the tab says it reads: task #N's worktree or the integration branch, the repo, the base it is diffed against. */
function ScopeLine({ host, scope, repo }: { host: DaemonHost; scope: ReviewScope; repo: string }): JSX.Element {
  const { state } = useSession(host);
  const handoff = state.run.handoff ?? state.run.runMerge;
  const base = handoff?.repos.find((r) => r.path === repo);
  const placed = scope.kind === 'task' ? host.task(scope.taskId) : undefined;
  const live = placed?.task.isolation && placed.task.isolation.state !== 'none' && placed.task.isolation.state !== 'integrated';
  return (
    <span className="changes-scope">
      {scope.kind === 'task' ? (
        <button type="button" className="changes-link" title="Open the task" onClick={() => host.openTask(scope.taskId, 'details')}>
          {placed ? `Task #${placed.label}${live ? ' worktree' : ''}` : 'Task worktree'}
        </button>
      ) : (
        <span>Integration vs base</span>
      )}
      <span className="muted">{repoName(repo)}</span>
      {base && <span className="muted" title={base.baseRef}>base {base.baseBranch ?? base.baseRef.slice(0, 12)}</span>}
    </span>
  );
}

function useDiff(workspace: string, scope: ReviewScope, repo: string, path: string): { diff: FileDiff | undefined; reload(): void } {
  const [diff, setDiff] = useState<FileDiff>();
  const [round, setRound] = useState(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const key = scopeKey(scope);
  useEffect(() => {
    let live = true;
    setDiff(undefined);
    void readFileDiff(workspace, scopeRef.current, repo, path).then((read) => { if (live) setDiff(read); });
    return () => { live = false; };
  }, [workspace, key, repo, path, round]);
  return { diff, reload: useCallback(() => setRound((n) => n + 1), []) };
}

function ReviewDiff({ api, tab, scope, repo, path }: { api: FrameApi; tab: Tab; scope: ReviewScope; repo: string; path: string }): JSX.Element {
  const host = daemonHost(api.workspace);
  useSession(host);
  const { diff, reload } = useDiff(api.workspace, scope, repo, path);
  const [sideBySide, setSideBySide] = useState(true);
  const [editor, setEditor] = useState<DiffEditorHandle>();
  const [failed, setFailed] = useState<string>();
  const [lines, setLines] = useState<DiffLines>();
  const [draft, setDraft] = useState<Draft>();
  const hostNode = useRef<HTMLDivElement>(null);
  const sideBySideNow = useRef(sideBySide);
  sideBySideNow.current = sideBySide;
  const key = commentsKey(scopeKey(scope), repo, path);
  const sent = useComments(key);
  const sides = diff?.kind === 'text' ? diff.sides : undefined;

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
          onLines: setLines,
        });
        active = created;
        setEditor(created);
      },
      (error: unknown) => { if (!disposed) setFailed(messageOf(error)); },
    );
    return () => {
      disposed = true;
      if (active === created) active = undefined;
      created?.dispose();
      setEditor(undefined);
      setLines(undefined);
      setDraft(undefined);
    };
  }, [sides, tab.key, path]);

  useEffect(() => { editor?.setSideBySide(sideBySide); }, [editor, sideBySide]);

  const placed = scope.kind === 'task' ? host.task(scope.taskId) : undefined;
  const taskLabel = placed ? `#${placed.label}` : '';
  const finished = placed ? isFinished(placed.task) : false;
  const selected = sides && lines ? realLines(sides, lines) : undefined;

  const openComment = (): void => {
    if (!sides || !lines || !selected) return;
    setDraft({ comment: { repo, path, side: lines.side, ...selected, quote: lines.text }, afterLine: lines.endLine });
  };

  const send = async (body: string): Promise<void> => {
    if (scope.kind !== 'task' || !draft) return;
    const comment: LineComment = { ...draft.comment, body };
    await messageTask(scope.sessionId, scope.taskId, commentMessage(comment, 'your change'));
    addComment(key, { comment, to: 'task', recipient: `task ${taskLabel}` });
    setDraft(undefined);
    api.announce(`Comment sent to task ${taskLabel}.`);
  };

  const askPlanner = (body: string): void => {
    if (!draft) return;
    const comment: LineComment = { ...draft.comment, body };
    host.askPlanner(commentMessage(comment, `task ${taskLabel}'s change`));
    // The planner panel may be hidden: the composer the comment went to has to be in view.
    if (!document.querySelector('.session-planner')) api.runCommand('planner.toggle');
    addComment(key, { comment, to: 'planner', recipient: 'the planner' });
    setDraft(undefined);
  };

  // A comment on the before side has no line to sit under in one column, where Monaco draws only the after side's lines.
  const where = (side: DiffSide, line: number): number | undefined => (sides && (sideBySide || side === 'modified') ? drawnLine(sides, side, line) : undefined);
  const unplaced = sent.filter((s) => where(s.comment.side, s.comment.endLine) === undefined);

  const body = (): JSX.Element => {
    if (!diff) return <p className="frame-empty">Loading the diff…</p>;
    switch (diff.kind) {
      case 'error':
        return (
          <div className="ft-message">
            <p className="frame-empty error" role="alert">{diff.message}</p>
            <button type="button" className="ft-button" onClick={reload}>Try again</button>
          </div>
        );
      case 'binary': return <p className="frame-empty">This is a binary file, so its change is not shown.</p>;
      case 'unchanged': return <p className="frame-empty">This file has no change here any more.</p>;
      case 'text':
        if (failed) return <p className="frame-empty error">The diff editor could not load: {failed}</p>;
        return <div ref={hostNode} className="ft-editor" data-testid="monaco-diff-host" onFocus={() => { if (editor) active = editor; }} />;
    }
  };

  const label = `${repo === '.' ? '' : `${repo}/`}${path}`;
  return (
    <div className="ft changes-diff">
      <div className="ft-bar">
        <span className="ft-path" title={label}>{label}</span>
        <ScopeLine host={host} scope={scope} repo={repo} />
        <span className="ft-spacer" />
        <div className="changes-toggle" role="group" aria-label="Layout">
          <button type="button" className="ft-button" aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Unified</button>
          <button type="button" className="ft-button" aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</button>
        </div>
        <button type="button" className="ft-button" disabled={!editor} title="Previous change (Shift+F7)" onClick={() => editor?.goToChange('previous')}>Previous change</button>
        <button type="button" className="ft-button" disabled={!editor} title="Next change (F7)" onClick={() => editor?.goToChange('next')}>Next change</button>
        {scope.kind === 'task' && (
          <button type="button" className="ft-button ft-primary" disabled={!editor || !selected || draft !== undefined} title="Select lines in the diff first" onClick={openComment}>
            Comment to task {taskLabel}
          </button>
        )}
        <button type="button" className="ft-button" onClick={reload}>Refresh</button>
      </div>
      {sides?.partial && (
        <p className="ft-banner" role="note">Only the changed lines are shown: the file as this scope holds it could not be read, or has moved on since.</p>
      )}
      {unplaced.length > 0 && (
        <div className="changes-unplaced">
          {unplaced.map((s) => <Sent key={s.id} sent={s} />)}
        </div>
      )}
      {body()}
      {editor && sent.map((s) => {
        const line = where(s.comment.side, s.comment.endLine);
        return line === undefined ? null : <Zone key={s.id} editor={editor} side={s.comment.side} afterLine={line}><Sent sent={s} /></Zone>;
      })}
      {editor && draft && (
        <Zone editor={editor} side={draft.comment.side} afterLine={draft.afterLine}>
          <CommentBox draft={draft} taskLabel={taskLabel} finished={finished} send={send} askPlanner={askPlanner} cancel={() => { setDraft(undefined); editor.focus(); }} />
        </Zone>
      )}
    </div>
  );
}

/** A diff tab: a file in a task's or the run's scope, its id the file tab's (fileTabs.ts). */
function DiffTab({ api, tab }: { api: FrameApi; tab: Tab }): JSX.Element {
  const { repo, path } = parseFileTabId(tab.id);
  const scope = tab.scope;
  // The checkout's own changes are the checkout group's to show (design slice 13).
  if (!scope || scope.kind === 'checkout') return <p className="frame-empty">Your checkout’s changes are under Your changes, in the Changes view.</p>;
  return <ReviewDiff key={tab.key} api={api} tab={tab} scope={scope} repo={repo} path={path} />;
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerTabKind({ kind: 'diff', icon: FileDiffIcon, render: (tab) => <DiffTab api={api} tab={tab} /> }),
    api.registerCommand({ id: 'changes.nextChange', title: 'Next change', keys: 'F7', enabled: () => active !== undefined, run: () => active?.goToChange('next') }),
    api.registerCommand({ id: 'changes.previousChange', title: 'Previous change', keys: 'Shift+F7', enabled: () => active !== undefined, run: () => active?.goToChange('previous') }),
  );
}
