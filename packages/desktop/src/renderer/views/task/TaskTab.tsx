import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { AttemptUsage, SurfaceTask, TaskType } from '@ordewell/core';
import { taskRowView, titledRefs, titledTaskRefOf, usageText, walkPlan } from '@ordewell/core/plan-utils';
import { checkLabel, TaskHandoff, TaskLogApp, TaskLogBridgeContext, verdictSummary } from '@ordewell/ui';
import {
  Button, IconButton, RunnerBadge, RunnerGlyph, StatusIndicator, Tabs, runnerName as nameOf, statusLineOf, statusOf,
} from '@ordewell/ui/design';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { TaskChanges } from '../changes/ChangesSidebar';
import { NodeMenu, type MenuAnchor } from '../graph/NodeMenu';
import { taskTabActions, type TaskTabAction } from './taskActions';
import { requestTaskView, useTaskViewRequest, type TaskView } from './taskView';

function runnerName(id: string | undefined): string {
  return id ? nameOf(id) : '';
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function VerdictSection({ verdict }: { verdict: SurfaceTask['verdict'] }): JSX.Element {
  if (!verdict) return <p className="muted">No verdict yet.</p>;
  return (
    <div className={`task-review ${verdict.outcome === 'pass' ? 'review-pass' : 'review-neutral'}`}>
      <div className="task-review-summary">{verdictSummary(verdict)}</div>
      {verdict.checks.length > 0 && (
        <ul className="task-review-checks">
          {verdict.checks.map((check) => (
            <li key={check.name} className={`check-item ${check.skipped ? 'check-skipped' : check.passed ? 'check-passed' : 'check-failed'}`}>
              <span className="check-name">{checkLabel(check.name)}</span>
              <span className="check-status">{check.skipped ? 'skipped' : check.passed ? 'passed' : 'failed'}</span>
              {check.detail && <span className="check-detail">{check.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Attempts({ attempts }: { attempts: readonly AttemptUsage[] }): JSX.Element {
  if (attempts.length === 0) return <p className="muted">Not run yet.</p>;
  return (
    <ol className="session-attempts">
      {attempts.map((a) => {
        const usage = usageText({ totals: a.totals });
        return (
          <li key={a.attempt}>
            Attempt {a.attempt} · {runnerName(a.runner)} · {new Date(a.startedAt).toLocaleString()}
            {a.endedAt ? ` · ${duration(a.wallTimeMs)}` : ' · running'}
            {usage && ` · ${usage}`}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Everything the plan holds about one task, in the order a reader asks it:
 * did it pass and on what evidence, what it was asked, who ran it, what it
 * waited on, what it handed over, and each attempt. The cards' own pieces draw
 * the verdict and the handoff, so the tab says what a card says.
 */
function Details({ task, tasks, onOpenChat }: { task: SurfaceTask; tasks: readonly SurfaceTask[]; onOpenChat(): void }): JSX.Element {
  const model = task.assignedModel?.modelLabel || task.assignedModel?.modelId;
  const assignment = task.type === 'ai'
    ? [runnerName(task.assignedRunner), model ?? 'default model', task.assignedModel?.thinkingEffort, task.taskMode].filter(Boolean).join(' · ')
    : task.type === 'script' ? 'A script: it runs no agent' : task.type === 'user' ? 'You do this one' : 'Delegated';
  return (
    <div className="session-task-details">
      <section aria-label="Verdict">
        <h3>Verdict</h3>
        <VerdictSection verdict={task.verdict} />
      </section>
      <section aria-label="Prompt">
        <h3>Prompt</h3>
        <pre className="session-prompt">{task.type === 'script' ? task.script ?? '' : task.prompt || task.description}</pre>
      </section>
      <section aria-label="Assignment">
        <h3>Assignment</h3>
        <p>{assignment}</p>
      </section>
      <section aria-label="Depends on">
        <h3>Depends on</h3>
        {task.dependencies.length === 0
          ? <p className="muted">Nothing: it can start at once.</p>
          : <ul>{titledRefs(task.dependencies, tasks).map((ref) => <li key={ref}>{ref}</li>)}</ul>}
      </section>
      <section aria-label="Handoff section">
        <h3>Handoff</h3>
        {task.handoff
          ? <TaskHandoff handoff={task.handoff} taskName={(id) => titledTaskRefOf(tasks, id)} onReadFull={onOpenChat} />
          : <p className="muted">Nothing handed over yet.</p>}
      </section>
      <section aria-label="Attempts">
        <h3>Attempts</h3>
        <Attempts attempts={task.attemptUsage ?? []} />
      </section>
    </div>
  );
}

/** A task's place in the header: its order, as a link that opens its own tab. */
function TaskLinks({ label, ids, labels, host }: { label: string; ids: readonly string[]; labels: ReadonlyMap<string, { label: string; title: string }>; host: DaemonHost }): JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <span className="session-task-links" aria-label={label}>
      <span aria-hidden="true">{label === 'Depends on' ? '⇠' : '⇢'}</span>
      {ids.map((id) => {
        const placed = labels.get(id);
        return placed && (
          <button key={id} type="button" className="session-task-link" title={`#${placed.label} ${placed.title}`}
            onClick={() => host.revealTask(id)}>
            #{placed.label}
          </button>
        );
      })}
    </span>
  );
}

const VIEWS: readonly { id: TaskView; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'chat', label: 'Chat' },
  { id: 'changes', label: 'Changes' },
];

/**
 * One task followed in its own tab (docs/desktop/design.md, W6): a header
 * that says where it stands and what can be done to it, over its details, its
 * chat with the runner, or the files it changed. `tab.id` is the task id.
 */
export function TaskTab({ tab, host, api }: { tab: Tab; host: DaemonHost; api: FrameApi }): JSX.Element {
  const session = useSession(host);
  const request = useTaskViewRequest(tab.id);
  const [view, setView] = useState<TaskView>(request?.view ?? 'details');
  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (request) setView(request.view); }, [request]);

  // The plan holds what the task was asked and handed over; the run, what it is doing now.
  const tasks = session.state.plan?.tasks ?? [];
  const placed = [...walkPlan(tasks)].find((p) => p.task.id === tab.id);
  const live = [...walkPlan(session.state.run.tasks)].find((p) => p.task.id === tab.id)?.task;
  if (!placed) return <p className="frame-empty">This task is not in the session's plan.</p>;
  const task = placed.task;
  const subject = { ...(live ?? task), type: task.type as TaskType, assignedModel: (live ?? task).assignedModel ?? undefined };
  const row = taskRowView(subject, { tasks: session.state.run.tasks.length > 0 ? session.state.run.tasks : tasks });
  const status = statusOf(row.status);
  const statusLine = statusLineOf(row, status, live?.idleSince);
  const runnerId = live?.assignedRunner ?? task.assignedRunner;
  const runner = runnerName(runnerId);
  const model = task.assignedModel?.modelLabel || task.assignedModel?.modelId;
  const assignment = task.type === 'ai'
    ? [model ?? 'default model', task.assignedModel?.thinkingEffort, task.taskMode].filter(Boolean).join(' · ')
    : task.type === 'script' ? 'Script' : task.type === 'user' ? 'Yours to do' : 'Delegated';
  const labels = new Map([...walkPlan(tasks)].map((p) => [p.task.id, { label: p.label, title: p.task.title }]));
  const dependents = [...walkPlan(tasks)].filter((p) => p.task.dependencies.includes(task.id)).map((p) => p.task.id);
  const isolation = live?.isolation;
  const branch = isolation && isolation.state !== 'none' ? isolation.branch : undefined;
  const actions = taskTabActions({ id: task.id, type: task.type, status: (live ?? task).status }, row, session.state.isExecuting);
  const [first, ...rest] = actions;
  const ref = `#${placed.label} ${task.title}`;
  const act = (action: TaskTabAction): void => { void host.handle(action.message); };
  const panelId = `task-view-${tab.id}`;

  return (
    <div className="session-task">
      <header className="session-task-header">
        <div className="session-task-line">
          <StatusIndicator status={status.id} />
          <h2 title={ref}>#{placed.label} {task.title}</h2>
          <span className="session-task-status" title={statusLine}>{statusLine}</span>
          <Tabs className="session-task-views" label="Task view" tabs={VIEWS} active={view} panelId={panelId}
            onSelect={(id) => setView(id as TaskView)} />
        </div>
        <div className="session-task-line session-task-meta">
          {task.type === 'ai' && runnerId && <RunnerBadge runner={runnerId} />}
          <span className="session-task-assignment">{assignment}</span>
          <TaskLinks label="Depends on" ids={task.dependencies} labels={labels} host={host} />
          <TaskLinks label="Needed by" ids={dependents} labels={labels} host={host} />
          {branch && <code className="session-task-branch" title={branch}>{branch}</code>}
          <span className="session-task-actions">
            {branch && <Button size="sm" variant="ghost" onClick={() => setView('changes')}>Diff</Button>}
            {first && <Button size="sm" onClick={() => act(first)}>{first.label}</Button>}
            {rest.length > 0 && (
              <IconButton ref={more} icon={MoreHorizontal} label={`More for ${ref}`} aria-haspopup="menu" aria-expanded={menuAt !== null}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenuAt(menuAt ? null : { x: rect.right - 180, y: rect.bottom + 4 });
                }} />
            )}
          </span>
        </div>
      </header>
      {menuAt && (
        <NodeMenu commands={rest.map((action, index) => ({ id: String(index), label: action.label }))} at={menuAt} label={`Commands for ${ref}`} anchor={more}
          onPick={(id) => { setMenuAt(null); more.current?.focus(); act(rest[Number(id)]); }}
          onClose={() => { setMenuAt(null); more.current?.focus(); }} />
      )}
      <div id={panelId} role="tabpanel" className="session-task-view" aria-label={VIEWS.find((v) => v.id === view)?.label}>
        {view === 'details' && <Details task={task} tasks={tasks} onOpenChat={() => setView('chat')} />}
        {view === 'chat' && (
          <div className="session-task-chat">
            <TaskLogBridgeContext.Provider value={host.taskLog(tab.id)}>
              <TaskLogApp composerLabel={`Message #${placed.label}${runner ? ` · ${runner}` : ''}`} />
            </TaskLogBridgeContext.Provider>
          </div>
        )}
        {view === 'changes' && (
          <div className="session-task-changes">
            {live
              ? <TaskChanges api={api} host={host} task={live} label={placed.label} />
              : <p className="muted">Not run yet: it has changed nothing.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  host.setNavigator({
    openTask: (taskId, view, options) => {
      const title = titledTaskRefOf(host.getSnapshot().state.plan?.tasks ?? [], taskId) ?? taskId;
      requestTaskView(taskId, view);
      api.openTab({ kind: 'task', id: taskId, title, scope: { kind: 'task', sessionId: host.sessionId, taskId } }, options);
    },
    openFile: (path) => {
      api.openTab({ kind: 'file', id: path, title: path.split('/').pop() ?? path, scope: { kind: 'checkout' } }, { preview: true });
    },
    showPlan: () => api.showPlan(),
  });
  const follow = (): void => api.showSession(host.sessionId);
  follow();
  return all(
    api.registerTabKind({ kind: 'task', icon: RunnerGlyph, render: (tab) => <TaskTab tab={tab} host={host} api={api} /> }),
    () => host.setNavigator(null),
    // A task tab reads the open session's plan: another session's would show its task as missing.
    host.subscribe(follow),
  );
}
