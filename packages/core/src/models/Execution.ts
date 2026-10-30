/**
 * How far a plan's supervisor may act in its wake-up turns (ADR-0029): a plan
 * setting, saved on the run as it starts. Off: it never wakes. Watch: it
 * wakes, reads and suggests. Act: Watch, and acting within its loop guards
 * without asking.
 */
export type SupervisorLevel = 'off' | 'watch' | 'act';

export function isSupervisorLevel(value: unknown): value is SupervisorLevel {
  return value === 'off' || value === 'watch' || value === 'act';
}

/**
 * Who asked the command seam for an action (ADR-0029): the user, a planner
 * turn the user started, or the supervisor at its level.
 */
export type ExecutionActor =
  | { kind: 'user' }
  | { kind: 'planner-turn' }
  | { kind: 'supervisor'; level: SupervisorLevel }
  /** The user's standing instruction to start each plan the planner submits (ADR-0030). */
  | { kind: 'autorun' };

export type ExecutionCommandName =
  | 'run_plan'
  | 'run_task'
  | 'stop_task'
  | 'stop_run'
  | 'retry_task'
  | 'message_task'
  | 'answer_approval'
  | 'merge_all'
  | 'skip_task'
  | 'force_start'
  | 'mark_complete'
  | 'mark_not_done'
  | 'revert_task'
  | 'interrupt_task'
  | 'force_send_queued'
  | 'remove_queued'
  | 'cancel_resume'
  | 'answer_checkpoint'
  | 'approve_review'
  | 'run_script';

/**
 * How the user consented to the script a `run_script` call ran (ADR-0035):
 * on the approval card, by an effect allowlist rule (by name), by autorun in
 * Full, or by choosing Act for the supervisor.
 */
export type ScriptConsent =
  | { by: 'card' }
  | { by: 'allowlist'; rule: string }
  | { by: 'autorun' }
  | { by: 'act' };

/**
 * Where a `run_script` call's task stood as the call answered, or as it ended
 * later: `passed` and `failed` are its verdict, `changed-files` a pass that left
 * a tracked change waiting on the user, `stopped` an attempt ended with no
 * verdict, `running` one still under way after a minute, and `gated` one
 * waiting at its merge gate.
 */
export type ScriptResult = 'passed' | 'failed' | 'changed-files' | 'stopped' | 'running' | 'gated';

/**
 * One call at the command seam as the timeline keeps it: what was asked, by
 * whom, about which task, and how it ended — done, refused by the seam, or
 * declined by the user it asked.
 */
export interface ExecutionRecord {
  command: ExecutionCommandName;
  actor: ExecutionActor['kind'];
  /** Present when the supervisor asked. */
  level?: SupervisorLevel;
  /** `ref` is how the plan numbers it: "#4", or "#4.1" for a subtask. */
  task?: { id: string; ref: string; title: string };
  outcome: 'done' | 'refused' | 'declined';
  /** The refusal, the message sent, or the note a denial carried. */
  detail?: string;
  /** `run_script`: how the script was consented to, once it was. */
  consent?: ScriptConsent;
  /** `run_script`: where its task stood; one that answered before its end gets a record of that end too. */
  result?: ScriptResult;
  /** `run_script`: the record of that end, kept once the task ended after the call answered. */
  ended?: true;
  at: string;
}
