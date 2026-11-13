import { describe, it, expect, vi } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import type { ExecutionActor, ExecutionCommandName, SupervisorLevel } from '../../models/Execution';
import { ExecutionCommands, type ApprovalReads, type Consent, type ExecutionHost, type RunReads } from '../ExecutionCommands';
import type { RunControls } from '../SessionSaves';
import { SURFACE_CONTROLS } from '../surfaceControls';

/**
 * What "a flat run does not change" means (ADR-0056): for each level, each
 * actor and each command, the seam answers what it answered before the mandate
 * took over from `SUPERVISOR_LEVELS`. Every answer here is written out, taken
 * from ADR-0029 and ADR-0035 and from the seam as it stood; none is worked out
 * by the code under test.
 */

const ALLOW: Consent = { kind: 'allow' };
const ASK: Consent = { kind: 'ask' };
const refuse = (reason: string): Consent => ({ kind: 'refuse', reason });

const WATCH = refuse('You are the supervisor at Watch: you read and suggest, and cannot run, stop, retry, skip or message tasks, run scripts, answer approvals or merge. Suggest it to the user instead; their reply is an ordinary message, and you can do it then.');
const OFF = refuse('The supervisor is off for this run, so it cannot act. Suggest it to the user instead.');
// Written for a terminal UI user, whose controls are commands and keys (ADR-0030).
const MERGE_IS_USERS = refuse('Merging the run\'s landed work is the user\'s: they are in this conversation, and merge it themselves (/merge). Tell them the work is ready to merge.');
const SKIP_IS_USERS = refuse('Skipping a task is the user\'s in their own turn: they are in this conversation, and skip it themselves (/skip <id>). Suggest it, with why; only the supervisor at Act skips, in a wake-up turn.');
const CHECKPOINT_CARD = 'The user answers it themselves (/checkpoint <id> approve, or /checkpoint <id> reject <reason>): tell them what the runner asks and what you would answer, with why.';
const CHECKPOINT_IS_USERS = refuse(`A checkpoint is the user's to answer in their own turn: they are in this conversation. ${CHECKPOINT_CARD} Only the supervisor at Act answers one, in a wake-up turn.`);
const CHECKPOINT_AT_WATCH = refuse(`You are the supervisor at Watch: you read and suggest, and cannot answer a checkpoint. ${CHECKPOINT_CARD}`);
const CHECKPOINT_AT_OFF = refuse(`The supervisor is off for this run, so it cannot answer a checkpoint. ${CHECKPOINT_CARD}`);

const usersOwn = (action: string, control: string) => refuse(`Only the user may ${action}: they are in this conversation, and do it themselves (${control}). Suggest it to them, with why.`);

/** Refused to anyone but the user, whoever asks. */
const USERS_CONTROLS: Partial<Record<ExecutionCommandName, Consent>> = {
  force_start: usersOwn('force start a task', '/force-start <id>'),
  mark_complete: refuse('Marking a task complete is the user\'s alone: it lands the work as if someone had checked it, and only they vouch for work. If you think it is done, tell them why; they can mark it complete (/complete <id>).'),
  mark_not_done: usersOwn('mark a task not done', '/uncomplete <id>'),
  revert_task: usersOwn('revert a task', '/revert <id>'),
  interrupt_task: usersOwn('interrupt a running task', 'ctrl-x in the task\'s view (/open <id>)'),
  force_send_queued: usersOwn('force send a queued message', 'ctrl-s on the queued message'),
  remove_queued: usersOwn('take back a queued message', 'ctrl-r on the queued message in the task\'s view (/open <id>)'),
  cancel_resume: usersOwn('cancel a scheduled resume', 'the c key on the task in the plan'),
  approve_review: usersOwn('approve the review', '/approve'),
};

const SHARED: readonly ExecutionCommandName[] = ['run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'message_task', 'answer_approval', 'merge_all', 'skip_task', 'answer_checkpoint', 'run_script'];

const every = (consent: Consent): Record<string, Consent> => Object.fromEntries(SHARED.map((command) => [command, consent]));

/** The answers of one actor: `guarded` where Full and Guarded differ. */
const TABLE: { name: string; actor: ExecutionActor; full: Record<string, Consent>; guarded?: Record<string, Consent> }[] = [
  { name: 'the user', actor: { kind: 'user' }, full: { ...every(ALLOW), ...Object.fromEntries(Object.keys(USERS_CONTROLS).map((command) => [command, ALLOW])) } },
  {
    name: 'a planner turn',
    actor: { kind: 'planner-turn' },
    full: { ...USERS_CONTROLS, ...every(ALLOW), merge_all: MERGE_IS_USERS, skip_task: SKIP_IS_USERS, answer_checkpoint: CHECKPOINT_IS_USERS },
    guarded: { ...USERS_CONTROLS, ...every(ALLOW), merge_all: MERGE_IS_USERS, skip_task: SKIP_IS_USERS, answer_checkpoint: CHECKPOINT_IS_USERS, run_plan: ASK, run_task: ASK, retry_task: ASK, run_script: ASK },
  },
  { name: 'autorun', actor: { kind: 'autorun' }, full: { ...USERS_CONTROLS, ...every(ALLOW), answer_checkpoint: CHECKPOINT_IS_USERS } },
  { name: 'the supervisor at Act', actor: { kind: 'supervisor', level: 'act' }, full: { ...USERS_CONTROLS, ...every(ALLOW) } },
  { name: 'the supervisor at Watch', actor: { kind: 'supervisor', level: 'watch' }, full: { ...USERS_CONTROLS, ...every(WATCH), answer_checkpoint: CHECKPOINT_AT_WATCH } },
  { name: 'the supervisor at Off', actor: { kind: 'supervisor', level: 'off' }, full: { ...USERS_CONTROLS, ...every(OFF), answer_checkpoint: CHECKPOINT_AT_OFF } },
];

const COMMANDS: readonly ExecutionCommandName[] = [...SHARED, ...Object.keys(USERS_CONTROLS) as ExecutionCommandName[]];

function seam(settings: { autonomous: boolean; autorun: boolean }, covered = false): ExecutionCommands {
  const host = { autonomous: () => settings.autonomous, autorun: () => settings.autorun, userControls: () => SURFACE_CONTROLS.tui, mergesByThemselves: () => false } as unknown as ExecutionHost;
  return new ExecutionCommands({ orchestrator: {} as RunReads, controls: {} as RunControls, approvals: {} as ApprovalReads, host, consent: { request: vi.fn() }, effects: () => (covered ? 'git push origin *' : null) });
}

describe('a flat run answers what it always answered (ADR-0056)', () => {
  it('names every command the seam takes', () => {
    const named: Record<ExecutionCommandName, true> = {
      run_plan: true, run_task: true, stop_task: true, stop_run: true, retry_task: true, message_task: true, answer_approval: true, merge_all: true, skip_task: true,
      force_start: true, mark_complete: true, mark_not_done: true, revert_task: true, interrupt_task: true, force_send_queued: true, remove_queued: true, cancel_resume: true,
      answer_checkpoint: true, approve_review: true, run_script: true,
    };
    expect([...COMMANDS].sort()).toEqual(Object.keys(named).sort());
  });

  for (const { name, actor, full, guarded } of TABLE) {
    for (const autonomous of [true, false]) {
      for (const autorun of [false, true]) {
        for (const command of COMMANDS) {
          it(`${name}, ${command}, ${autonomous ? 'Full' : 'Guarded'}, autorun ${autorun ? 'on' : 'off'}`, () => {
            const expected = (autonomous ? full : guarded ?? full)[command];
            expect(seam({ autonomous, autorun }).consent(actor, command)).toEqual(expected);
          });
        }
      }
    }
  }
});

describe('what autorun approves as a planner edit lands, in a flat run (ADR-0030, ADR-0035)', () => {
  const aiTask: Task = createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedRunner: 'claude-code', taskMode: 'acceptEdits' });
  const scriptTask: Task = createTask({ id: 's', order: 2, title: 'S', type: 'script', commands: [['git', 'push', 'origin', 'x']], assignedRunner: 'claude-code' });
  const written = [aiTask, scriptTask];
  const supervisor = (level: SupervisorLevel): ExecutionActor => ({ kind: 'supervisor', level });

  const CASES: { name: string; actor: ExecutionActor; autonomous: boolean; autorun: boolean; covered?: boolean; approves: string[] }[] = [
    { name: 'a planner turn with autorun off', actor: { kind: 'planner-turn' }, autonomous: true, autorun: false, approves: [] },
    { name: 'a planner turn in Full with autorun', actor: { kind: 'planner-turn' }, autonomous: true, autorun: true, approves: ['a', 's'] },
    { name: 'a planner turn in Guarded with autorun', actor: { kind: 'planner-turn' }, autonomous: false, autorun: true, approves: ['a'] },
    { name: 'a planner turn in Guarded with autorun and a rule that covers the script', actor: { kind: 'planner-turn' }, autonomous: false, autorun: true, covered: true, approves: ['a', 's'] },
    { name: 'the supervisor at Act in Full with autorun', actor: supervisor('act'), autonomous: true, autorun: true, approves: ['a', 's'] },
    { name: 'the supervisor at Act in Guarded with autorun', actor: supervisor('act'), autonomous: false, autorun: true, approves: [] },
    { name: 'the supervisor at Watch in Full with autorun', actor: supervisor('watch'), autonomous: true, autorun: true, approves: [] },
    { name: 'the supervisor at Off in Full with autorun', actor: supervisor('off'), autonomous: true, autorun: true, approves: [] },
    { name: 'the user in Full with autorun', actor: { kind: 'user' }, autonomous: true, autorun: true, approves: [] },
    { name: 'autorun in Full', actor: { kind: 'autorun' }, autonomous: true, autorun: true, approves: [] },
  ];

  for (const { name, actor, autonomous, autorun, covered, approves } of CASES) {
    it(name, () => {
      expect(seam({ autonomous, autorun }, covered).autorunApproves(actor, written)).toEqual(approves);
    });
  }
});
