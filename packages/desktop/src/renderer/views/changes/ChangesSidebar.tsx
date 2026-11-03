import { useEffect, useState } from 'react';
import { GitMerge, RefreshCw } from 'lucide-react';
import { taskStatusKind, titledRefs, walkPlan } from '@ordewell/core/plan-utils';
import type { RunTask } from '@ordewell/core';
import { IconButton, StatusIndicator, statusOf } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { fileTabId } from '../explorer/fileTabs';
import { readRunFiles, readTaskFiles, type FileList, type ReviewScope } from './changesData';
import { conflictRows, matchesFilter, reviewableTasks, type ChangedFile, type ConflictRow } from './changesModel';
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

/** One read of a file list, again whenever `key` changes: a task that moved on has other files. */
function useFiles(read: () => Promise<FileList>, key: string): FileList | undefined {
  const [list, setList] = useState<FileList>();
  useEffect(() => {
    let live = true;
    setList(undefined);
    void read().then((next) => { if (live) setList(next); });
    return () => { live = false; };
    // `read` is rebuilt each render; `key` names everything it reads.
  }, [key]);
  return list;
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

function Files({ list, scope, tag, filter, open, empty }: {
  list: FileList | undefined;
  scope: ReviewScope;
  tag: string;
  filter: string;
  open: Opener;
  empty: string;
}): JSX.Element | null {
  if (!list) return <p className="changes-note">Loading…</p>;
  if (!list.ok) return <p className="changes-note error" role="alert">{list.error}</p>;
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
function Revert({ host, task }: { host: DaemonHost; task: RunTask }): JSX.Element | null {
  if (task.isolation?.revertible !== true) return null;
  return (
    <div className="changes-task-actions">
      <button type="button" className="ft-button" onClick={() => { void host.handle({ type: 'sendSystemCommand', command: 'revertTask', taskId: task.id }); }}>
        Revert…
      </button>
    </div>
  );
}

/** Tasks held at a merge gate (ADR-0042): Merge all lets them go on, or one is started past its gate, asked first. */
function Gates({ host, gated, tasks }: { host: DaemonHost; gated: Array<{ task: RunTask; label: string }>; tasks: readonly RunTask[] }): JSX.Element {
  return (
    <section className="changes-gates" aria-label="Waiting for a merge">
      <h3 className="changes-heading">Waiting for a merge</h3>
      <ul>
        {gated.map(({ task, label }) => (
          <li key={task.id} className="changes-gate">
            <button type="button" className="changes-link" onClick={() => host.openTask(task.id, 'details')}>#{label} {task.title}</button>
            <span className="muted">waits for {titledRefs(task.mergeGate ?? [], tasks).join(', ')} to be merged</span>
            <button type="button" className="ft-button" onClick={() => { void host.handle({ type: 'sendSystemCommand', command: 'forceStart', taskId: task.id }); }}>
              Start anyway…
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TaskGroup({ host, task, label, filter, round, open }: {
  host: DaemonHost;
  task: RunTask;
  label: string;
  filter: string;
  round: number;
  open: Opener;
}): JSX.Element | null {
  const sessionId = host.sessionId;
  const list = useFiles(
    () => readTaskFiles(host.workspace, sessionId, task.id),
    [sessionId, task.id, task.status, task.isolation?.state, round].join('\0'),
  );
  const scope: ReviewScope = { kind: 'task', sessionId, taskId: task.id };
  // A filter that names the task shows all its files; one that matches none of them hides the task.
  const named = matchesFilter(filter, task.title, `#${label}`);
  if (!named && list?.ok && !list.files.some((f) => matchesFilter(filter, `${f.repo}/${f.path}`))) return null;
  const status = statusOf(taskStatusKind(task));
  return (
    <section className="changes-group" aria-label={`Task #${label}: ${task.title}`}>
      <button type="button" className="changes-group-head" title="Open the task" onClick={() => host.openTask(task.id, 'details')}>
        <StatusIndicator status={status.id} size={12} />
        <span className="changes-group-label">#{label}</span>
        <span className="changes-group-title">{task.title}</span>
      </button>
      <Revert host={host} task={task} />
      <Files
        list={list}
        scope={scope}
        tag={`Task #${label}`}
        filter={named ? '' : filter}
        open={open}
        empty="No changes in this task."
      />
    </section>
  );
}

function RunGroup({ host, repos, filter, round, open }: { host: DaemonHost; repos: string[]; filter: string; round: number; open: Opener }): JSX.Element {
  const sessionId = host.sessionId;
  const { state } = useSession(host);
  const landed = (state.run.handoff ?? state.run.runMerge)?.landed.length ?? 0;
  const list = useFiles(() => readRunFiles(host.workspace, sessionId, repos), [sessionId, repos.join('\0'), landed, round].join('\0'));
  return (
    <section className="changes-group" aria-label="Whole run vs base">
      <div className="changes-group-head changes-group-static">
        <span className="changes-group-title">Whole run vs base</span>
      </div>
      <Files list={list} scope={{ kind: 'integration', sessionId }} tag="Integration" filter={filter} open={open} empty="Nothing has landed on the integration branch yet." />
    </section>
  );
}

function Conflicts({ host, rows }: { host: DaemonHost; rows: ConflictRow[] }): JSX.Element {
  return (
    <section className="changes-conflicts" aria-label="Conflicts">
      <h3 className="changes-heading">Conflicts</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.taskId} className="changes-conflict">
            <button type="button" className="changes-link" onClick={() => host.openTask(row.taskId, 'details')}>#{row.label} {row.title}</button>
            <span className="muted">
              {row.repo === '.' ? '' : `${row.repo}: `}
              {row.files.length > 0 ? row.files.join(', ') : 'conflicting files'}
            </span>
            {row.repairing ? (
              <span className="changes-note">Being repaired…</span>
            ) : (
              <button type="button" className="ft-button" onClick={() => { void host.handle({ type: 'isolationAction', action: 'resolveConflict', taskId: row.taskId }); }}>
                Resolve
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
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
  const mergeable = run.handoff !== null || (run.runMerge !== null && run.runMerge.landed.length > 0);

  const open: Opener = (file, scope, tag, preview) => {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    api.openTab({ kind: 'diff', id: fileTabId(file.repo, file.path), title: `${name} (${tag})`, scope }, { preview });
  };

  if (tasks.length === 0 && conflicts.length === 0 && gated.length === 0 && !handoff) {
    return <p className="frame-empty">No task has changes to review yet: an isolated run’s tasks list theirs here.</p>;
  }

  return (
    <div className="changes" key={sessionId}>
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
      {tasks.map(({ task, label }) => (
        <TaskGroup key={task.id} host={host} task={task} label={label} filter={filter} round={round} open={open} />
      ))}
      {handoff && repos.length > 0 && <RunGroup host={host} repos={repos} filter={filter} round={round} open={open} />}
      {mergeable && (
        <div className="changes-merge">
          <button type="button" className="ft-button ft-primary" onClick={() => { void mergeAll(api, host); }}>
            <GitMerge size={14} aria-hidden="true" /> Merge all…
          </button>
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
    api.registerSidebar({ activity: 'changes', id: 'review', title: 'Review', order: 10, render: () => <ChangesList api={api} host={host} /> }),
    api.registerCommand({ id: 'changes.mergeAll', title: 'Merge all…', more: true, run: () => { void mergeAll(api, host); } }),
    () => host.setReviewer(null),
  );
}
