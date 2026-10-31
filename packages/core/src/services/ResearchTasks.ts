import type { LegacyPlanState, Task, TaskReportTo } from '../models/Task';
import type { ExecutionActor } from '../models/Execution';

/**
 * What starting a research task owes the planner: a report, addressed to the
 * turn that started it. How many start is the planner's judgement, bounded by
 * the run's Parallel limit like any task (ADR-0037 R4).
 */
export class ResearchTasks {
  constructor(private readonly host: {
    plan(): LegacyPlanState | null;
    owe(taskId: string, to: TaskReportTo): void;
  }) {}

  started(task: Readonly<Task>): void {
    if (!task.research) return;
    if (!task.reportTo) this.host.owe(task.id, task.researchOrigin ?? researchReportTo(task.addedBy === 'supervisor'
      ? { kind: 'supervisor', level: this.host.plan()?.runSettings?.supervisorLevel ?? 'off' } : { kind: 'planner-turn' }));
  }
}

/** The same authority record as run_script, without inventing consent to a script (ADR-0037 R3). */
export function researchReportTo(actor: ExecutionActor): TaskReportTo {
  switch (actor.kind) {
    case 'supervisor': return { research: true, actor: 'supervisor', level: actor.level };
    case 'subplanner': return { research: true, actor: 'subplanner', depth: actor.depth };
    default: return { research: true, actor: 'planner-turn' };
  }
}
