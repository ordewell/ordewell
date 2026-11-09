import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, GitMerge, GitPullRequestArrow, Info, RefreshCw } from 'lucide-react';
import { taskRowView, titledRefs, walkPlan } from '@ordewell/core/plan-utils';
import type { RunTask, RunView, Task, TaskType } from '@ordewell/core';
import { TaskSummary } from '@ordewell/ui';
import { Badge, Button, EmptyState, Icon, IconButton, SectionHeader, statusOf } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { SectionHead } from '../../frame/Sidebar';
import { useDisclosure } from '../../frame/store';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { fileTabId } from '../explorer/fileTabs';
import { readRunFiles, readTaskFiles, type FileList, type ReviewScope } from './changesData';
import { conflictRows, matchesFilter, reviewableTasks, taskDiffNote, type ChangedFile, type ConflictRow, type TaskDiffNote } from './changesModel';
import { mergeAll } from './mergeAll';
import '../explorer/explorer.css';
import './changes.css';

/*
 * The run's changes to review (design slice 12, W9): conflicts first, then
 * each task's files under the task, then the whole run against its base. A
 * file opens as a diff tab in the scope it was changed in. The checkout's own
 * changes are another section of this activity (checkout/CheckoutGroup).
 */

type Opener = (file: ChangedFile, scope: ReviewScope, tag: string, preview: boolean) => void;

/** A file opens as a diff tab in the scope it was changed in, a preview until it is kept. */
function opener(api: FrameApi): Opener {
  return (file, scope, tag, preview) => {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    api.openTab({ kind: 'diff', id: fileTabId(file.repo, file.path), title: `${name} (${tag})`, scope }, { preview });
  };
}

/**
 * One read of a file list, again whenever `key` changes: a task that moved on
 * has other files. While the same `scope` is read again its last list stays
 * drawn rather than flashing to a skeleton; a list from another scope is never
 * drawn, nor an answer that arrives after its read was superseded.
 */
function useFiles(read: () => Promise<FileList>, scope: string, key: string): { list: FileList | undefined; current: boolean } {
  const [held, setHeld] = useState<{ scope: string; key: string; list: FileList }>();
  useEffect(() => {
    let live = true;
    void read().then((list) => { if (live) setHeld({ scope, key, list }); });
    return () => { live = false; };
    // `read` is rebuilt each render; `scope` and `key` name everything it reads.
  }, [scope, key]);
  if (held?.scope !== scope) return { list: undefined, current: false };
  return { list: held.list, current: held.key === key };
}

/** How long each read after a quiet answer waits; past the last, Refresh reads again. A run saves a task's record within seconds of reporting it. */
const RETRY_MS = [1000, 2000, 4000, 8000, 16000];

/** Call `go` once the window is shown and the daemon connected: a read before then would only be retried again. */
function whenReachable(go: () => void): () => void {
  let done = false;
  const check = (): void => {
    if (done || document.hidden) return;
    void window.ordewell.daemon.status().then((status) => {
      if (done || document.hidden || status.state !== 'connected') return;
      stop();
      go();
    }, () => undefined); // An unreadable status waits for the next status event.
  };
  const offStatus = window.ordewell.daemon.onStatus((status) => { if (status.state === 'connected') check(); });
  document.addEventListener('visibilitychange', check);
  function stop(): void {
    done = true;
    offStatus();
    document.removeEventListener('visibilitychange', check);
  }
  check();
  return stop;
}

/**
 * A task's files, and what to say when it has none to show. The saved run the
 * daemon reads trails what the run broadcasts, so a task whose record has not
 * been saved yet is read again a few times, though nothing on its row changes;
 * a task that has settled is never polled.
 */
function useTaskFiles(host: DaemonHost, task: RunTask, refresh: number): { list: FileList | undefined; note: TaskDiffNote | undefined } {
  const sessionId = host.sessionId;
  // A new attempt is another scope: the last attempt's files are not this one's.
  const scope = [sessionId, task.id, task.attemptUsage?.length ?? 0].join('\0');
  const asked = [scope, task.status, task.isolation?.state, refresh].join('\0');
  const [retry, setRetry] = useState({ asked, tries: 0 });
  const tries = retry.asked === asked ? retry.tries : 0;
  const { list, current } = useFiles(() => readTaskFiles(host.workspace, sessionId, task.id), scope, `${asked}\0${tries}`);
  const note = list && !list.ok && list.unavailable ? taskDiffNote(list.unavailable, task) : undefined;
  // Only an answer to the latest read schedules the next, so a slow read is never overtaken by another.
  const again = current && note?.retry === true && tries < RETRY_MS.length;
  useEffect(() => {
    if (!again) return;
    let reachable: (() => void) | undefined;
    const timer = setTimeout(() => { reachable = whenReachable(() => setRetry({ asked, tries: tries + 1 })); }, RETRY_MS[tries]);
    return () => { clearTimeout(timer); reachable?.(); };
  }, [again, asked, tries]);
  return { list, note };
}

function Counts({ file }: { file: ChangedFile }): JSX.Element {
  if (file.added === null) return <span className="changes-counts muted">binary</span>;
  return (
    <span className="changes-counts" aria-label={`${file.added} added, ${file.removed ?? 0} removed`}>
      <span className="changes-added">+{file.added}</span> <span className="changes-removed">−{file.removed ?? 0}</span>
    </span>
  );
}

const LETTER_WORD = { A: 'Added', M: 'Modified', D: 'Deleted' } as const;

/** Rows with the height of the files that replace them, so the list moves nothing when it arrives (checklist S1). */
function FilesSkeleton(): JSX.Element {
  return (
    <div className="changes-skeleton" role="status" aria-label="Loading changes" aria-busy="true">
      {[58, 40, 66].map((width, index) => (
        <div key={index} className="changes-skeleton-row"><span className="changes-skeleton-bar" style={{ width: `${width}%` }} /></div>
      ))}
    </div>
  );
}

function Files({ list, note, scope, tag, filter, open, empty }: {
  list: FileList | undefined;
  /** What a task with no diff to show says instead of its read's failure. */
  note?: TaskDiffNote;
  scope: ReviewScope;
  tag: string;
  filter: string;
  open: Opener;
  empty: string;
}): JSX.Element | null {
  if (!list) return <FilesSkeleton />;
  if (note?.tone === 'quiet') return <p className="changes-note">{note.text}</p>;
  if (note?.tone === 'unavailable') return <p className="changes-note unavailable"><Icon icon={Info} size={16} />{note.text}</p>;
  if (!list.ok) return <p className="changes-note error" role="alert"><Icon icon={AlertTriangle} size={16} />{note?.text ?? list.error}</p>;
  const files = list.files.filter((file) => matchesFilter(filter, `${file.repo}/${file.path}`));
  if (list.files.length === 0) return <p className="changes-note">{empty}</p>;
  if (files.length === 0) return null;
  return (
    <>
      {list.note && <p className="changes-note">From the patch it saved: its worktree is gone.</p>}
      <ul className="changes-files">
        {files.map((file) => {
          const name = file.path.slice(file.path.lastIndexOf('/') + 1);
          const dir = file.path.slice(0, file.path.length - name.length - 1);
          const where = file.repo === '.' ? dir : [file.repo, dir].filter(Boolean).join('/');
          return (
            <li key={`${file.repo}\0${file.path}`}>
              <button
                type="button"
                className="changes-file"
                title={`${file.repo === '.' ? '' : `${file.repo}/`}${file.path}`}
                onClick={() => open(file, scope, tag, true)}
                onDoubleClick={() => open(file, scope, tag, false)}
              >
                <span className={`ex-badge ex-badge-${file.status ?? 'M'}`} aria-label={file.status ? LETTER_WORD[file.status] : undefined}>
                  {file.status ?? ''}
                </span>
                <span className="changes-file-name">{name}</span>
                {where && <span className="changes-file-dir muted">{where}</span>}
                <Counts file={file} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Revert what a task landed (ADR-0054): the host shows what the revert takes with it (revert-preview) before it asks. */
function Revert({ host, task, row }: { host: DaemonHost; task: RunTask; row?: boolean }): JSX.Element | null {
  if (task.isolation?.revertible !== true) return null;
  const revert = (): void => { void host.handle({ type: 'sendSystemCommand', command: 'revertTask', taskId: task.id }); };
  // On a task's header the action sits with the status it follows; in the task tab it heads the list's actions.
  if (row) return <button type="button" className="task-row-action" onClick={revert}>Revert…</button>;
  return <Button size="sm" variant="secondary" onClick={revert}>Revert…</Button>;
}

/** Tasks held at a merge gate (ADR-0042): Merge all lets them go on, or one is started past its gate, asked first. */
function Gates({ host, gated, tasks }: { host: DaemonHost; gated: Array<{ task: RunTask; label: string }>; tasks: readonly RunTask[] }): JSX.Element {
  return (
    <section className="changes-gates" aria-label="Waiting for a merge">
      <SectionHeader level={4} title="Waiting for a merge" count={gated.length} />
      <ul className="changes-rows">
        {gated.map(({ task, label }) => (
          <li key={task.id} className="changes-item">
            <div className="changes-item-line">
              <Badge tone="merge" icon={GitPullRequestArrow}>Merge gate</Badge>
              <button type="button" className="changes-link" title="Show the task in the plan" onClick={() => host.revealTask(task.id)}>#{label} {task.title}</button>
            </div>
            <p className="changes-item-text">waits for {titledRefs(task.mergeGate ?? [], tasks).join(', ')} to be merged</p>
            <div className="changes-item-actions">
              <Button size="sm" variant="secondary" onClick={() => { void host.handle({ type: 'sendSystemCommand', command: 'forceStart', taskId: task.id }); }}>
                Start anyway…
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A group with this many files or fewer starts open; a longer one starts closed, and the user's own choice stands from then on. */
const OPEN_UP_TO = 8;

/**
 * A group's open state: the user's choice once made, which a filter does not
 * override, otherwise open while it is short or being searched. `key` names
 * the session as well as the group, so a choice outlives the sidebar being
 * drawn again and never lands on another session's group of the same name.
 */
function useGroupOpen(key: string, list: FileList | undefined, filtering: boolean): [boolean, () => void] {
  const [chosen, setChosen] = useDisclosure(key);
  // Read again on a refresh, a long group stays as long as it was: it does not open while its files are away.
  const known = useRef<boolean>();
  if (list) known.current = !list.ok || list.files.length <= OPEN_UP_TO;
  const open = chosen ?? (filtering || (known.current ?? true));
  return [open, () => setChosen(!open)];
}

/** A group's file count; folded under a filter it says how many of them match, so a match is seen without opening it. */
function FileCount({ list, filter }: { list: FileList | undefined; filter: string }): JSX.Element | null {
  if (!list?.ok) return null;
  const total = list.files.length;
  if (filter === '') return <span className="changes-file-count" aria-label={`${total} ${total === 1 ? 'file' : 'files'}`}>{total}</span>;
  const matching = list.files.filter((file) => matchesFilter(filter, `${file.repo}/${file.path}`)).length;
  return <span className="changes-file-count" aria-label={`${matching} of ${total} ${total === 1 ? 'file matches' : 'files match'}`}>{matching}/{total}</span>;
}

/**
 * The whole header turns the group over, chevron included, so a click lands on
 * the same state wherever it falls. TaskSummary handles a click inside itself,
 * its title button toggling and its actions doing their own work; the chevron
 * stays decoration, as the title button is the one control a keyboard or a
 * screen reader meets.
 */
function GroupHead({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }): JSX.Element {
  const click = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('.task-summary')) return;
    onToggle();
  };
  return (
    <div className="changes-group-head" onClick={click}>
      <Icon icon={open ? ChevronDown : ChevronRight} size={16} className="changes-chevron" />
      {children}
    </div>
  );
}

/** What TaskSummary draws a task from: the run's view of it, the way the graph and the task tab read it. */
function summaryOf(task: RunTask, tasks: readonly RunTask[]): { subject: Task; row: ReturnType<typeof taskRowView> } {
  const subject = { ...task, type: task.type as TaskType, assignedModel: task.assignedModel ?? undefined };
  return { subject: subject as Task, row: taskRowView(subject, { tasks }) };
}

function TaskGroup({ host, task, tasks, label, filter, round, open }: {
  host: DaemonHost;
  task: RunTask;
  tasks: readonly RunTask[];
  label: string;
  filter: string;
  round: number;
  open: Opener;
}): JSX.Element | null {
  const sessionId = host.sessionId;
  const { list, note } = useTaskFiles(host, task, round);
  const [expanded, toggle] = useGroupOpen(`changes:${sessionId}:task:${task.id}`, list, filter !== '');
  const scope: ReviewScope = { kind: 'task', sessionId, taskId: task.id };
  // A filter that names the task shows all its files; one that matches none of them hides the task.
  const named = matchesFilter(filter, task.title, `#${label}`);
  if (!named && list?.ok && !list.files.some((f) => matchesFilter(filter, `${f.repo}/${f.path}`))) return null;
  const { subject, row } = summaryOf(task, tasks);
  return (
    <section className="changes-group" aria-label={`Task #${label}: ${task.title}`}>
      <GroupHead open={expanded} onToggle={toggle}>
        <TaskSummary task={subject} row={row} density="row" expanded={expanded} onToggle={toggle} idleSince={task.idleSince} status={statusOf(row.status)} badges={false}>
          <FileCount list={list} filter={expanded || named ? '' : filter} />
          <Revert host={host} task={task} row />
          <button type="button" className="task-row-action" title="Show the task in the plan" onClick={(event) => { event.stopPropagation(); host.revealTask(task.id); }}>
            Show in plan
          </button>
        </TaskSummary>
      </GroupHead>
      {expanded && (
        <Files
          list={list}
          note={note}
          scope={scope}
          tag={`Task #${label}`}
          filter={named ? '' : filter}
          open={open}
          empty="No changes in this task."
        />
      )}
    </section>
  );
}

/**
 * One task's changed files and its revert, as its tab's Changes view draws
 * them (docs/desktop/design.md, W6): the list this sidebar draws under the
 * task, so the two never disagree on what a task changed.
 */
export function TaskChanges({ api, host, task, label }: { api: FrameApi; host: DaemonHost; task: RunTask; label: string }): JSX.Element {
  const sessionId = host.sessionId;
  const [round, setRound] = useState(0);
  const { list, note } = useTaskFiles(host, task, round);
  return (
    <section className="changes-group" aria-label="Changed files">
      <div className="changes-task-actions">
        <Revert host={host} task={task} />
        <IconButton icon={RefreshCw} label="Refresh changes" onClick={() => setRound((r) => r + 1)} />
      </div>
      <Files list={list} note={note} scope={{ kind: 'task', sessionId, taskId: task.id }} tag={`Task #${label}`} filter="" open={opener(api)} empty="No changes in this task." />
    </section>
  );
}

function RunGroup({ host, repos, filter, round, open }: { host: DaemonHost; repos: string[]; filter: string; round: number; open: Opener }): JSX.Element {
  const sessionId = host.sessionId;
  const { state } = useSession(host);
  const landed = (state.run.handoff ?? state.run.runMerge)?.landed.length ?? 0;
  const { list } = useFiles(() => readRunFiles(host.workspace, sessionId, repos), [sessionId, repos.join('\0')].join('\0'), [landed, round].join('\0'));
  const [expanded, toggle] = useGroupOpen(`changes:${sessionId}:run`, list, filter !== '');
  return (
    <section className="changes-group" aria-label="Whole run vs base">
      <button type="button" className="changes-run-head" aria-expanded={expanded} onClick={toggle}>
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={16} className="changes-chevron" />
        <span className="changes-run-title">Whole run vs base</span>
        <FileCount list={list} filter={expanded ? '' : filter} />
      </button>
      {expanded && <Files list={list} scope={{ kind: 'integration', sessionId }} tag="Integration" filter={filter} open={open} empty="Nothing has landed on the integration branch yet." />}
    </section>
  );
}

function Conflicts({ host, rows }: { host: DaemonHost; rows: ConflictRow[] }): JSX.Element {
  return (
    <section className="changes-conflicts" aria-label="Conflicts">
      <SectionHeader level={4} title="Conflicts" count={rows.length} />
      <ul className="changes-rows">
        {rows.map((row) => {
          const files = `${row.repo === '.' ? '' : `${row.repo}: `}${row.files.length > 0 ? row.files.join(', ') : 'conflicting files'}`;
          return (
            <li key={row.taskId} className="changes-item changes-conflict">
              <div className="changes-item-line">
                <Badge tone="failed" icon={AlertTriangle}>Conflict</Badge>
                <button type="button" className="changes-link" title="Show the task in the plan" onClick={() => host.revealTask(row.taskId)}>#{row.label} {row.title}</button>
              </div>
              <p className="changes-item-text" title={files}>{files}</p>
              <div className="changes-item-actions">
                {row.repairing ? (
                  <span className="changes-note">Being repaired…</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => { void host.handle({ type: 'isolationAction', action: 'resolveConflict', taskId: row.taskId }); }}>
                    Resolve
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Whether the run has anything Merge all would land: nothing landed, it is not offered (design.md, W13). */
function hasLanded(run: RunView): boolean {
  return run.handoff !== null || (run.runMerge !== null && run.runMerge.landed.length > 0);
}

export function ChangesList({ api, host }: { api: FrameApi; host: DaemonHost }): JSX.Element {
  const { sessionId, state } = useSession(host);
  const [filter, setFilter] = useState('');
  const [round, setRound] = useState(0);
  const run = state.run;
  const conflicts = conflictRows(run);
  const tasks = reviewableTasks(run);
  const gated = [...walkPlan(run.tasks)].filter(({ task }) => (task.mergeGate?.length ?? 0) > 0);
  const handoff = run.handoff ?? run.runMerge;
  const repos = handoff ? handoff.repos.map((r) => r.path) : [];
  const mergeable = hasLanded(run);

  const heading = useId();
  const list = useId();
  const [chosen, setReviewing] = useDisclosure('changes:review');
  // Like the frame's own foldable sections: folded while it has no task to show, until the user says otherwise.
  const reviewing = chosen ?? tasks.length > 0;

  const open = opener(api);

  if (tasks.length === 0 && conflicts.length === 0 && gated.length === 0 && !handoff) {
    return (
      <>
        <SectionHead id={heading} title="Review" />
        <EmptyState icon={GitMerge} title="No changes to review yet" body="An isolated run’s tasks list their changes here." />
      </>
    );
  }

  return (
    <div className="changes" key={sessionId}>
      {/* Review folds the task list alone: the whole run, the waits and Merge all are this sidebar's actions, never folded away. */}
      <SectionHead id={heading} title="Review" count={tasks.length} showZero={!reviewing} open={reviewing} onToggle={setReviewing} controls={list} />
      <div className="changes-search">
        <input
          className="frame-input"
          type="search"
          aria-label="Filter changed files"
          placeholder="Filter files or tasks"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <IconButton icon={RefreshCw} label="Refresh changes" onClick={() => setRound((r) => r + 1)} />
      </div>
      {conflicts.length > 0 && <Conflicts host={host} rows={conflicts} />}
      {gated.length > 0 && <Gates host={host} gated={gated} tasks={run.tasks} />}
      {!reviewing && filter !== '' && tasks.length > 0 && <p className="changes-note">Review is folded: open it to see the tasks that match.</p>}
      {reviewing && (
        <div id={list} className="changes-review" role="group" aria-labelledby={heading}>
          {tasks.length === 0 && <p className="changes-note">No task has changes to review yet.</p>}
          {tasks.map(({ task, label }) => (
            <TaskGroup key={task.id} host={host} task={task} tasks={run.tasks} label={label} filter={filter} round={round} open={open} />
          ))}
        </div>
      )}
      {handoff && repos.length > 0 && <RunGroup host={host} repos={repos} filter={filter} round={round} open={open} />}
      {mergeable && (
        <div className="changes-merge">
          <Button variant="primary" icon={GitMerge} onClick={() => { void mergeAll(api, host); }}>Merge all…</Button>
        </div>
      )}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  // Review & Merge all's review step, and every Merge all behind the preflight (ADR-0062 G8).
  host.setReviewer({ open: () => api.showActivity('changes'), mergeAll: () => mergeAll(api, host) });
  return all(
    api.registerSidebar({ activity: 'changes', id: 'review', title: 'Review', order: 10, ownsHeading: true, render: () => <ChangesList api={api} host={host} /> }),
    // A palette entry only: the ⋯ menu's Merge all is the plan's, which follows the run's actions.
    api.registerCommand({
      id: 'changes.mergeAll',
      title: 'Merge all…',
      enabled: () => !api.readOnly && !host.getSnapshot().readOnly && hasLanded(host.getSnapshot().state.run),
      run: () => { void mergeAll(api, host); },
    }),
    () => host.setReviewer(null),
  );
}
