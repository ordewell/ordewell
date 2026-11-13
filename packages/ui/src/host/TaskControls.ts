import type { ExecutionCommand, OverrideDirection, Task, TaskAction, TaskRevertPreview } from '@ordewell/core';
// The browser-safe entry: the desktop renderer runs this too.
import {
  confirmedOverride, manualOverrideStopFirst, overrideNeedsConfirmation, taskActionCommand, titledRefs, titledTaskRefOf, walkPlan,
} from '@ordewell/core/plan-utils';
import { overrideConfirmation, revertConfirmation, startPastGateConfirmation, type ConfirmationRequest } from './confirmations';

/**
 * What a task's by-hand actions need of a surface: what it knows of the plan,
 * the command seam, a place to ask, and a place to say no. Everything a surface
 * does differently (a modal or a dialog, an in-process session or a daemon's
 * routes) is behind one of these.
 */
export interface TaskActionPort {
  /** The plan's tasks as the chat's cards were drawn from them. */
  tasks(): readonly Task[];
  /** Whether a run could advance a task by itself, which the seam refuses a manual override against (ADR-0029). */
  advancesOnItsOwn(): boolean;
  /** The ids of the tasks whose work is not merged into the branch yet and gates this one (ADR-0020). */
  mergeGate(taskId: string): Promise<readonly string[]>;
  revertPreview(taskId: string): Promise<TaskRevertPreview>;
  /** One command at the seam as the user (ADR-0029). The seam's refusal is thrown, in its own words. */
  execute(command: ExecutionCommand): Promise<void>;
  /**
   * Ask in the surface's real dialog (a webview's `confirm()` is inert). A
   * dismissal answers none of the choices, `null` or `undefined` by surface,
   * and is read as no.
   */
  ask<C extends string>(request: ConfirmationRequest<C>): Promise<C | null | undefined>;
  /**
   * A start, wrapped in what the surface does about the last run's cards. When
   * it clears them is the surface's call: it knows when its run's first status
   * can reach it.
   */
  starting(start: () => Promise<void>): Promise<void>;
  /** A control's refusal, said as the surface says them. Not thrown: the control has nothing left to do. */
  refuse(error: unknown): void;
}

/** The run-wide controls the planner chat's cards and bars send besides a task's own actions. */
export interface TaskControlPort extends TaskActionPort {
  /**
   * Approve and run the plan, or with a run under way approve what waits for
   * approval (#95). The surfaces adopt a plan differently before that, so the
   * whole step is theirs.
   */
  executePlan(requestId?: number): Promise<void>;
  /** The seam has stopped the run: the surface stops what it holds of it and draws the plan as a draft again. */
  stopped(): void;
  cancelPlannerResend(): Promise<void>;
  /** A planner turn the chat did not send: it fails as one does, and the surface reports that itself. */
  retryPlannerCompaction(): Promise<void>;
  /** A system command is over, however it ended: the plan is drawn from what the session holds now. */
  settled(): void;
}

/** The webview's names for the task controls that are one command each; Force start and Run go through the merge gate instead. */
const ONE_COMMAND_ACTIONS = {
  cancel: 'cancel',
  cancelResume: 'cancel-resume',
  resumeNow: 'resume-now',
  retry: 'retry',
  skip: 'skip',
} as const satisfies Record<string, TaskAction>;

/**
 * A task's actions that ask first or look first: Mark complete / Mark not done,
 * Revert, Force start and Run. The plan pane and the command palette share
 * these, so a start clears a handoff, and a refusal reads, the same from either.
 */
export class TaskActions {
  constructor(private readonly port: TaskActionPort) {}

  /**
   * Mark complete and Mark not done (ADR-0029). An AI or script task's override
   * vouches for work no verdict passed, so a real modal explains it first and
   * the seam gets the user's yes on the command; the core refuses it anyway
   * while a run could advance the task, and the modal is not offered then. A
   * manual task's is the user's own sign-off and asks nothing. The task is named
   * by id and the status the user was asked about travels with the yes, so a
   * task that moved on while the modal was open is refused, not overridden.
   */
  async markByHand(direction: OverrideDirection, taskId: string): Promise<void> {
    const { port } = this;
    const tasks = port.tasks();
    const task = [...walkPlan(tasks)].find((placed) => placed.task.id === taskId)?.task;
    const command = taskActionCommand(direction, taskId);
    if (!task || !overrideNeedsConfirmation(task)) {
      await port.execute(command);
      return;
    }
    const label = `task ${titledTaskRefOf(tasks, taskId) ?? taskId}`;
    // The seam's own guard, not a narrower reading of it: a queued force start or
    // a usage-limit hold refuses an override too, though nothing is starting,
    // running or scheduled (ADR-0029).
    if (port.advancesOnItsOwn()) {
      port.refuse(new Error(manualOverrideStopFirst(direction, label)));
      return;
    }
    if (await port.ask(overrideConfirmation(direction, label)) !== 'override') return;
    await port.execute(confirmedOverride(command, task.status));
  }

  /**
   * Revert a task's landed work (ADR-0054). Core's preview says what goes with
   * it, or why nothing does, and the dialog shows that list. The yes carries the
   * ids the user was shown, so a plan that changed meanwhile is refused, not
   * reverted. A refusal at any point is core's own words.
   */
  async revert(taskId: string): Promise<void> {
    const { port } = this;
    const preview = await port.revertPreview(taskId);
    if (!preview.revertible) {
      port.refuse(new Error(preview.message));
      return;
    }
    if (await port.ask(revertConfirmation(preview, taskId)) !== 'revert') return;
    await port.execute({ command: 'revert_task', task: taskId, confirmed: true, seen: preview.tasks.map((t) => t.taskId) });
  }

  /**
   * A force start passes a merge gate (ADR-0020) once the user has seen, in a
   * real dialog, which work the task would act without. `gate` is a read the
   * caller already made, so the dialog and the start answer one gate.
   */
  async forceStart(taskId: string, gate?: readonly string[]): Promise<void> {
    const { port } = this;
    const unmerged = gate ?? await port.mergeGate(taskId);
    if (unmerged.length > 0 && await port.ask(startPastGateConfirmation(titledRefs(unmerged, port.tasks()))) !== 'start') return;
    await port.starting(() => port.execute(taskActionCommand('force-start', taskId)));
  }

  async run(taskId: string): Promise<void> {
    const gate = await this.port.mergeGate(taskId);
    // The seam's run_task refuses a gated task: a start past the gate is a force start, confirmed first.
    if (gate.length > 0) {
      await this.forceStart(taskId, gate);
      return;
    }
    await this.port.starting(() => this.port.execute(taskActionCommand('run', taskId)));
  }
}

/**
 * The planner chat's system commands (`sendSystemCommand`): what the plan's
 * cards and the run bars ask besides a prompt, answered the same on every
 * surface (ADR-0017 Q2, ADR-0063 H7). Nothing here decides a verdict; each
 * command is one call at the seam, after the question the ADRs say it needs.
 */
export class TaskControls {
  private readonly actions: TaskActions;

  constructor(private readonly port: TaskControlPort) {
    this.actions = new TaskActions(port);
  }

  /**
   * Whatever a command throws, the surface tells the user once, and the plan is
   * drawn from what the session holds either way. A command this does not know
   * is ignored: a newer webview may send one an older host has not learnt.
   */
  async systemCommand(command: string, taskId: string, requestId?: number): Promise<void> {
    try {
      await this.dispatch(command, taskId, requestId);
    } catch (err) {
      this.port.refuse(err);
    }
    this.port.settled();
  }

  private async dispatch(command: string, taskId: string, requestId: number | undefined): Promise<void> {
    const { port, actions } = this;
    switch (command) {
      case 'cancelPlannerResend':
        await port.cancelPlannerResend();
        return;
      case 'retryPlannerCompaction':
        await port.retryPlannerCompaction();
        return;
      // Skip lands nothing, so it is never a mark: only Mark complete vouches for work.
      case 'cancel':
      case 'cancelResume':
      case 'resumeNow':
      case 'retry':
      case 'skip':
        await port.execute(taskActionCommand(ONE_COMMAND_ACTIONS[command], taskId));
        return;
      case 'markComplete':
        await actions.markByHand('complete', taskId);
        return;
      case 'markIncomplete':
        await actions.markByHand('uncomplete', taskId);
        return;
      case 'revertTask':
        await actions.revert(taskId);
        return;
      case 'forceStart':
        await actions.forceStart(taskId);
        return;
      case 'runTask':
        await actions.run(taskId);
        return;
      case 'executePlan':
        await port.executePlan(requestId);
        return;
      case 'stopExecution':
        // The seam answers a stop with nothing running, and nothing about to start, as an ok no-op; a refusal is a stop that could not be kept.
        await port.execute({ command: 'stop_run' });
        port.stopped();
        return;
    }
  }
}
