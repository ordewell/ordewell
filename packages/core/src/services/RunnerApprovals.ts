import { isRunnerApproval, type ApprovalRequest } from '../interfaces/IApproval';
import type { IRunner, IRunnerSession, StructuredEvent } from '../interfaces/IRunner';
import { runnerToolSubject } from '../conversation/taskLog';
import type { PendingApprovals } from './PendingApprovals';

type PermissionRequest = Extract<StructuredEvent, { type: 'permission_request' }>;

function runnerRequest(taskId: string, event: PermissionRequest): ApprovalRequest {
  return {
    kind: 'runner_tool',
    subject: runnerToolSubject(event.name, event.detail),
    scope: event.name,
    detail: event.detail,
    taskId,
    allowForTask: (event.suggestions?.length ?? 0) > 0,
  };
}

/**
 * Carries a structured task's tool requests to the session's one approval
 * seam (ADR-0018, A1), so a runner's request is answered through
 * `resolveApproval` like any other — by a person on any surface, or by the
 * supervisor (#28), with nothing here assuming which.
 *
 * Like the task log, it sits around the runner rather than inside the
 * orchestrator: every way an attempt ends reaches the runner as a `stop`, and
 * that is where a task's open requests are denied, before the session goes,
 * so nothing is left waiting on a process that no longer exists.
 */
export class RunnerApprovals {
  /** The open request ids of each live structured session. */
  private readonly open = new Map<string, Set<string>>();

  constructor(private readonly approvals: PendingApprovals) {}

  wrap(runner: IRunner): IRunner {
    return {
      spawn: async (opts) => {
        const session = await runner.spawn(opts);
        // Before returning, as the task log does: the first turn's events are
        // emitted on the next macrotask.
        this.watch(opts.taskId, session);
        return session;
      },
      stop: (sessionId) => {
        this.denySession(sessionId);
        runner.stop(sessionId);
      },
      stopAll: () => {
        this.approvals.clear(isRunnerApproval);
        runner.stopAll();
      },
      get activeCount() { return runner.activeCount; },
    };
  }

  /** How many of a task's runner requests wait for an answer — what "waiting for approval" is derived from. */
  waiting(taskId: string): number {
    return this.approvals.outstanding().filter((p) => isRunnerApproval(p.request) && p.request.taskId === taskId).length;
  }

  private watch(taskId: string, session: IRunnerSession): void {
    const open = new Set<string>();
    this.open.set(session.id, open);
    session.onEvent((event) => {
      // One the task's mode already answered has nothing left to ask.
      if (event.type === 'permission_request' && !event.decided) {
        open.add(event.id);
        void this.approvals.decide(runnerRequest(taskId, event), {
          id: event.id,
          noTimeout: true,
          onDecision: (decision) => {
            open.delete(event.id);
            session.answerPermission(event.id, decision);
          },
        });
      } else if (event.type === 'permission_withdrawn' && open.has(event.id)) {
        // Nothing left to answer; settling it takes it off every surface.
        this.approvals.resolve(event.id, { decision: 'deny' });
      }
    });
    session.onExit(() => {
      this.denySession(session.id);
      this.open.delete(session.id);
    });
  }

  private denySession(sessionId: string): void {
    for (const id of [...this.open.get(sessionId) ?? []]) this.approvals.resolve(id, { decision: 'deny' });
  }
}
