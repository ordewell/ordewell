import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Columns2, FileDiff as FileDiffIcon, FileQuestion, FileWarning, MessageSquarePlus, RefreshCw, Rows2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton } from '@ordewell/ui/design';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { PLANNER_TAB, scopeKey } from '../../frame/layout';
import { createDiffEditor, loadMonaco, type DiffEditorHandle, type DiffLines, type DiffSide } from '../../monaco';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { messageOf } from '../../session/daemon';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { CheckoutDiff } from '../checkout/CheckoutDiff';
import { parseFileTabId } from '../explorer/fileTabs';
import { Banner, EditorSkeleton, FileHeader, ScopeBadge, Segmented } from '../explorer/fileView';
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
    <form aria-label={`Comment on ${commentPlace(draft.comment)}`} onSubmit={(event) => { event.preventDefault(); primary(); }}>
      <Card density="compact" className="changes-comment-box">
        <p className="changes-comment-place">{commentPlace(draft.comment)}</p>
        {finished && <p className="changes-comment-note">Task {taskLabel} has finished, so it reads no more messages. Ask the planner instead: it can retry the task or add one.</p>}
        {failed && <p className="changes-comment-note error" role="alert">It did not reach task {taskLabel}: {failed}</p>}
        <textarea
          autoFocus
          className="changes-comment-input"
          aria-label={toPlanner ? 'Comment for the planner' : `Comment to task ${taskLabel}`}
          value={body}
          rows={3}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onKey}
        />
        <div className="changes-comment-actions">
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          {failed && !finished && <Button size="sm" disabled={empty || sending} onClick={() => void sendNow()}>Try again</Button>}
          <Button size="sm" variant="primary" type="submit" disabled={empty || sending}>
            {toPlanner ? 'Ask the planner' : sending ? 'Sending…' : `Send to task ${taskLabel}`}
          </Button>
        </div>
      </Card>
    </form>
  );
}

function Sent({ sent }: { sent: SentComment }): JSX.Element {
  return (
    <Card density="compact" className="changes-comment" role="note" aria-label={`Comment on ${commentPlace(sent.comment)}`}>
      <span className="changes-comment-to">{sent.to === 'task' ? `Sent to ${sent.recipient}` : 'Put in the planner’s composer'} · {commentPlace(sent.comment)}</span>
      <p>{sent.comment.body}</p>
    </Card>
  );
}

/**
 * What the header says the tab reads: task #N's worktree (a link to the task)
 * or the integration branch, then the repo and the base it is diffed against.
 */
function useScopeParts(host: DaemonHost, scope: ReviewScope, repo: string): { scopeNode: JSX.Element; meta: JSX.Element } {
  const { state } = useSession(host);
  const handoff = state.run.handoff ?? state.run.runMerge;
  const base = handoff?.repos.find((r) => r.path === repo);
  const placed = scope.kind === 'task' ? host.task(scope.taskId) : undefined;
  const live = placed?.task.isolation && placed.task.isolation.state !== 'none' && placed.task.isolation.state !== 'integrated';
  const scopeNode = scope.kind === 'task'
    ? (
      <Button variant="secondary" size="sm" title="Show the task in the plan" onClick={() => host.revealTask(scope.taskId)}>
        {placed ? `Task #${placed.label}${live ? ' worktree' : ''}` : 'Task worktree'}
      </Button>
    )
    : <ScopeBadge name="Integration vs base" readOnly />;
  const meta = (
    <>
      <Badge>{repoName(repo)}</Badge>
      {base && <Badge title={base.baseRef}>{`base ${base.baseBranch ?? base.baseRef.slice(0, 12)}`}</Badge>}
    </>
  );
  return { scopeNode, meta };
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
    // The planner tab may be behind another: the composer the comment went to has to be in view.
    const planner = document.querySelector('.session-planner');
    if (!planner || planner.closest('[hidden]')) api.openTab(PLANNER_TAB);
    addComment(key, { comment, to: 'planner', recipient: 'the planner' });
    setDraft(undefined);
  };

  // A comment on the before side has no line to sit under in one column, where Monaco draws only the after side's lines.
  const where = (side: DiffSide, line: number): number | undefined => (sides && (sideBySide || side === 'modified') ? drawnLine(sides, side, line) : undefined);
  const unplaced = sent.filter((s) => where(s.comment.side, s.comment.endLine) === undefined);

  const body = (): JSX.Element => {
    if (!diff) return <EditorSkeleton label="Loading the diff…" />;
    switch (diff.kind) {
      case 'error':
        return (
          <div className="fv-state">
            <EmptyState icon={FileWarning} title="The diff could not be read" body={<span role="alert">{diff.message}</span>} action={<Button size="sm" icon={RefreshCw} onClick={reload}>Try again</Button>} />
          </div>
        );
      case 'binary':
        return <div className="fv-state"><EmptyState icon={FileQuestion} title="This is a binary file" body="This is a binary file, so its change is not shown." /></div>;
      case 'unchanged':
        return <div className="fv-state"><EmptyState icon={FileDiffIcon} title="No change" body="This file has no change here any more." /></div>;
      case 'text':
        if (failed) return <div className="fv-state"><EmptyState icon={FileWarning} title="The diff editor could not load" body={failed} /></div>;
        return <div ref={hostNode} className="ft-editor" data-testid="monaco-diff-host" onFocus={() => { if (editor) active = editor; }} />;
    }
  };

  const label = `${repo === '.' ? '' : `${repo}/`}${path}`;
  const { scopeNode, meta } = useScopeParts(host, scope, repo);
  return (
    <div className="ft changes-diff">
      <FileHeader
        label="Diff"
        path={label}
        scope={scopeNode}
        meta={meta}
        actions={(
          <>
            <Segmented label="Layout">
              <IconButton icon={Rows2} label="Unified" active={!sideBySide} aria-pressed={!sideBySide} onClick={() => setSideBySide(false)} />
              <IconButton icon={Columns2} label="Side by side" active={sideBySide} aria-pressed={sideBySide} onClick={() => setSideBySide(true)} />
            </Segmented>
            <IconButton icon={ChevronUp} label="Previous change" title="Previous change (Shift+F7)" disabled={!editor} onClick={() => editor?.goToChange('previous')} />
            <IconButton icon={ChevronDown} label="Next change" title="Next change (F7)" disabled={!editor} onClick={() => editor?.goToChange('next')} />
            <IconButton icon={RefreshCw} label="Refresh" onClick={reload} />
            {scope.kind === 'task' && (
              <Button variant="primary" size="sm" icon={MessageSquarePlus} disabled={!editor || !selected || draft !== undefined} title="Select lines in the diff first" onClick={openComment}>
                Comment to task {taskLabel}
              </Button>
            )}
          </>
        )}
      />
      {sides?.partial && (
        <Banner>Only the changed lines are shown: the file as this scope holds it could not be read, or has moved on since.</Banner>
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
  const scope = tab.scope;
  if (!scope) return <div className="fv-state"><EmptyState icon={FileWarning} title="This diff does not name the scope it reads" /></div>;
  // The checkout's own changes are the checkout group's to show (design slice 13).
  if (scope.kind === 'checkout') return <CheckoutDiff api={api} tab={tab} />;
  const { repo, path } = parseFileTabId(tab.id);
  return <ReviewDiff key={tab.key} api={api} tab={tab} scope={scope} repo={repo} path={path} />;
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerTabKind({ kind: 'diff', icon: FileDiffIcon, render: (tab) => <DiffTab api={api} tab={tab} /> }),
    api.registerCommand({ id: 'changes.nextChange', title: 'Next change', keys: 'F7', enabled: () => active !== undefined, run: () => active?.goToChange('next') }),
    api.registerCommand({ id: 'changes.previousChange', title: 'Previous change', keys: 'Shift+F7', enabled: () => active !== undefined, run: () => active?.goToChange('previous') }),
  );
}
