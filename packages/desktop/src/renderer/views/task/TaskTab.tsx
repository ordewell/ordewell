import { useEffect, useState } from 'react';
import type { AttemptUsage, SurfaceTask } from '@ordewell/core';
import { taskStatusKind, titledRefs, titledTaskRefOf, usageText, walkPlan } from '@ordewell/core/plan-utils';
import { checkLabel, TaskHandoff, TaskLogApp, TaskLogBridgeContext, verdictSummary } from '@ordewell/ui';
import { RunnerGlyph, StatusIndicator, statusOf } from '@ordewell/ui/design';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { RUNNER_NAMES } from '../../runners';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { requestTaskView, useTaskViewRequest, type TaskView } from './taskView';

function runnerName(id: string | undefined): string {
  return id ? RUNNER_NAMES[id] ?? id : '';
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

/** One task followed in its own tab (W4): its details, or its chat with the runner. `tab.id` is the task id. */
export function TaskTab({ tab, host }: { tab: Tab; host: DaemonHost }): JSX.Element {
  const session = useSession(host);
  const request = useTaskViewRequest(tab.id);
  const [view, setView] = useState<TaskView>(request?.view ?? 'details');
  useEffect(() => { if (request) setView(request.view); }, [request]);

  // The plan holds what the task was asked and handed over; the run, what it is doing now.
  const tasks = session.state.plan?.tasks ?? [];
  const placed = [...walkPlan(tasks)].find((p) => p.task.id === tab.id);
  const live = [...walkPlan(session.state.run.tasks)].find((p) => p.task.id === tab.id)?.task;
  if (!placed) return <p className="frame-empty">This task is not in the session's plan.</p>;
  const task = placed.task;
  const status = statusOf(taskStatusKind(live ?? task));
  const runner = runnerName(live?.assignedRunner ?? task.assignedRunner);

  return (
    <div className="session-task">
      <header className="session-task-header">
        <StatusIndicator status={status.id} showLabel />
        <h2>#{placed.label} {task.title}</h2>
        <div className="frame-toolbar" role="tablist" aria-label="Task view">
          <button type="button" role="tab" aria-selected={view === 'details'} onClick={() => setView('details')}>Details</button>
          <button type="button" role="tab" aria-selected={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
        </div>
      </header>
      {view === 'details'
        ? <Details task={task} tasks={tasks} onOpenChat={() => setView('chat')} />
        : (
          <div className="session-task-chat">
            <TaskLogBridgeContext.Provider value={host.taskLog(tab.id)}>
              <TaskLogApp composerLabel={`Message #${placed.label}${runner ? ` · ${runner}` : ''}`} />
            </TaskLogBridgeContext.Provider>
          </div>
        )}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  host.setNavigator({
    openTask: (taskId, view) => {
      const title = titledTaskRefOf(host.getSnapshot().state.plan?.tasks ?? [], taskId) ?? taskId;
      requestTaskView(taskId, view);
      api.openTab({ kind: 'task', id: taskId, title, scope: { kind: 'task', sessionId: host.sessionId, taskId } });
    },
    openFile: (path) => {
      api.openTab({ kind: 'file', id: path, title: path.split('/').pop() ?? path, scope: { kind: 'checkout' } }, { preview: true });
    },
  });
  return all(
    api.registerTabKind({ kind: 'task', icon: RunnerGlyph, render: (tab) => <TaskTab tab={tab} host={host} /> }),
    () => host.setNavigator(null),
  );
}
