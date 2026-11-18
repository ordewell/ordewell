import { flag, hasFlag, readLastSession, workspaceOf } from '../utils';
import { iconFor } from '../utils/output';
import type { ApiClient } from '../apiClient';
import { CLOSING_TURN_BOUND_MS, handoffBranchName, holdLabel, isRepoGroup, loopBodyLabel, loopBodyRound, loopCheckLabel, loopCheckState, repairWaitLabel, repoResultLines, scriptTaskText, skippedLabel, SUPERVISOR_LEVEL_LABEL, taskStartedNotice, truncateCheckpointSummary, WAITS_FOR_APPROVAL_LABEL, walkPlan, type Escalation, type ExecutionSummary, type SerializedTaskStatus, type SupervisorLevel } from '@ordewell/core';
import { allTasksOf } from '../utils/tasks';
import { connect, headlessSignedOut } from './shared';
import { taskHandoffLines } from './taskHandoff';

const inLine = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** A task's status; a run joined midway holds the plan's looser `type` and `research`. */
type TaskLine = Omit<SerializedTaskStatus, 'type' | 'research'> & { type?: string; research?: boolean };

/** A task as the line names it: the stream carries no order, so its id's tail. */
const refOf = (id: string): string => `#${id.slice(-4)}`;

/**
 * What a loop's check or body task says of its place in the loop (ADR-0045),
 * read off the statuses the stream has sent; null for a task in no loop.
 * `repeating` is whether a check between rounds goes on, which a body task
 * that failed or was skipped stops, and so does nothing being left to run it.
 */
function loopNote(task: TaskLine, all: readonly TaskLine[]): { text: string; repeating: boolean } | null {
  if (task.loop) {
    const check = { id: task.id, status: task.status, loop: task.loop, loopRound: task.loopRound, ...(task.verdict ? { verdict: task.verdict } : {}) };
    const halted = task.loop.body.some((id) => ['failed', 'skipped'].includes(all.find((t) => t.id === id)?.status ?? ''));
    const state = loopCheckState(check, !halted && !task.loopStranded);
    return { text: loopCheckLabel(check, state), repeating: state === 'repeating' };
  }
  const check = all.find((t) => t.loop?.body.includes(task.id));
  if (!check?.loop) return null;
  return { text: loopBodyLabel(refOf(check.id), loopBodyRound({ status: check.status, loopRound: check.loopRound }, task.status), check.loop.maxRounds), repeating: false };
}

/**
 * Resolve the session every execution command acts on: `--session-id`, else the
 * one `ordewell plan` last created.
 */
export function resolveSessionId(subArgs: string[]): string {
  const explicit = flag(subArgs, '--session-id');
  if (explicit) return explicit;

  const workspace = workspaceOf(subArgs);
  const last = readLastSession(workspace);
  if (!last) {
    console.error(`No session specified. Use --session-id <id> or run \`ordewell plan\` in ${workspace} first.`);
    process.exit(1);
  }
  console.error(`Using last session: ${last.sessionId} ("${last.goal}")`);
  return last.sessionId;
}

/**
 * The exit status of a run that ended with a task failed or blocked. 1 stays
 * the command's own failure (no daemon, a refused start), so a script tells
 * "the work failed" from "the command did".
 */
export const RUN_FAILED_EXIT = 2;

/**
 * The exit status of `ordewell run --unattended` when the run waits on a
 * person nobody unattended will answer: it is left in the daemon as it stands.
 */
export const RUN_WAITS_EXIT = 3;

/** The waits on a person `--unattended` returns on: what a script would otherwise follow for good. */
const PERSON_WAITS: ReadonlySet<Escalation['kind']> = new Set<Escalation['kind']>(['checkpoint', 'input', 'approval', 'on-hold']);

/**
 * How long a wait has to stand before `--unattended` returns on it: the status
 * update that drops an answered wait may trail the answer by a second.
 */
const WAIT_STANDS_MS = 2_000;

/** A run's own settings, as a plan or a run view carries them. */
type RunSettingsOf = { supervisorLevel?: SupervisorLevel; unsupervised?: string } | undefined;

/** The level the run acts at now, when the settings say: a supervisor that stood down leaves it unsupervised, which is Off. */
const levelOf = (settings: RunSettingsOf): SupervisorLevel | null => (settings?.unsupervised ? 'off' : settings?.supervisorLevel ?? null);

/**
 * Who answers a task waiting on a person, unattended (ADR-0029): at Act the
 * supervisor is woken to it; below Act nobody is, so the run waits for good.
 */
function whoAnswers(level: SupervisorLevel | null): string {
  if (level === null) return '';
  return level === 'act'
    ? ' The supervisor has been woken to answer it.'
    : ' Nobody answers it unattended: it waits until someone does. `ordewell supervisor act` lets the supervisor answer in new sessions.';
}

/**
 * Who releases a task on hold, unattended: at Act the supervisor is woken to
 * it when a turn of its ends leaving it held, or once the run is idle behind it
 * (ADR-0057 R4); below Act nobody is.
 */
function whoReleases(level: SupervisorLevel | null): string {
  if (level === null) return '';
  return level === 'act'
    ? ' The supervisor is woken to it when a turn of its ends with it still held, or once nothing else can run.'
    : ' Nobody releases it unattended: it waits until someone does. `ordewell supervisor act` lets the supervisor act in new sessions.';
}

/** The commands that start a task on hold again, by what its wait offers, and the skip that lets what needs it go ahead. */
function releasing(wait: Escalation, ref: string): string {
  const commands = wait.options.flatMap((o) => (o.id === 'retry' ? ['retry'] : o.id === 'force-start' ? ['force-start'] : o.id === 'complete' ? ['complete'] : []));
  const all = [...commands, 'skip'].map((c) => `\`ordewell ${c} ${ref}\``);
  return `${all.slice(0, -1).join(', ')} or ${all[all.length - 1]}`;
}

/** The run's level, as the session holds it; null when the daemon cannot say. */
async function sessionLevel(api: ApiClient, sessionId: string): Promise<SupervisorLevel | null> {
  try {
    return (await api.getSettings(sessionId)).run.supervisorLevel ?? null;
  } catch {
    return null;
  }
}

/** A task's reference with no `#`, which a shell would read as a comment. */
const bare = (ref: string): string => ref.replace(/^#/, '');

/**
 * Follow a session's execution to completion, redrawing one line per task.
 * Shared by `run` and `approve` — both hand the orchestrator work and then
 * watch the same stream, and a second copy of the redraw would drift.
 *
 * It returns when the daemon says the run's end stands (`run_concluded`):
 * at Act, after the supervisor's closing turn, which may continue the run
 * (ADR-0029). A run that ended with a task failed or blocked sets
 * {@link RUN_FAILED_EXIT}; a stopped run leaves the status alone.
 *
 * `unattended` returns, with {@link RUN_WAITS_EXIT}, once a wait on a person
 * stands that nobody unattended answers: at Act, after a supervisor turn that
 * began once it stood and left it standing; below Act, as soon as it stands.
 * The run is left as it is, nothing answered: it is the follower that stops
 * waiting, so it is neither a deadline nor a default answer (ADR-0053).
 *
 * `start` is the call that hands over the work, made only once the stream is
 * open: what it starts can answer before the call returns — a dirty tree's
 * block is broadcast from inside it — and a stream opened afterwards waited
 * for a run that never began.
 */
export async function followExecution(
  api: ApiClient,
  sessionId: string,
  start: () => Promise<unknown>,
  onBlocked?: 'stash' | 'shared',
  unattended = false,
): Promise<void> {
  const level = await sessionLevel(api, sessionId);
  if (level) {
    process.stderr.write(`· Supervisor: ${SUPERVISOR_LEVEL_LABEL[level]}.\n`);
    if (level !== 'act') process.stderr.write('· A task waiting on a person (a checkpoint, input or an approval) waits until someone answers it.\n');
  }
  const summary = await followRun(api, sessionId, start, onBlocked, level, unattended);
  if (summary === 'waits') process.exitCode = RUN_WAITS_EXIT;
  else if (summary && (summary.failed > 0 || blockedOf(summary) > 0)) process.exitCode = RUN_FAILED_EXIT;
}

/** Older summaries left blocked out: what neither completed nor failed nor was skipped. */
const blockedOf = (summary: ExecutionSummary): number => summary.blocked ?? (summary.total - (summary.completed || 0) - (summary.failed || 0) - (summary.skipped || 0));

/**
 * {@link followExecution}'s stream, through a dirty tree's block; the run's
 * last summary, null when it was stopped, or `waits` when `unattended` left
 * it waiting on a person.
 */
async function followRun(
  api: ApiClient,
  sessionId: string,
  start: () => Promise<unknown>,
  onBlocked: 'stash' | 'shared' | undefined,
  startLevel: SupervisorLevel | null,
  unattended: boolean,
): Promise<ExecutionSummary | null | 'waits'> {
  let level = startLevel;
  let concluded: ExecutionSummary | null = null;
  // At Act the follower waits on the supervisor's closing turn, never past
  // the longest that turn may run once it can (ADR-0029): a daemon that never
  // says so leaves the tasks' outcomes as the answer. A user's planner turn
  // holds the closing turn back for as long as it lasts, so the bound counts
  // from when none is open, and afresh at each supervisor turn's start.
  let ended: ExecutionSummary | null = null;
  let closingBound: ReturnType<typeof setTimeout> | undefined;
  let awaitingClose = false;
  const userTurns = new Set<string>();
  const rearm = (): void => {
    clearTimeout(closingBound);
    if (awaitingClose && userTurns.size === 0) closingBound = setTimeout(noteOverdue, CLOSING_TURN_BOUND_MS);
  };
  const stopBound = (): void => {
    awaitingClose = false;
    clearTimeout(closingBound);
  };
  let noteOverdue: () => void = () => {};
  const overdue = new Promise<'overdue'>((resolve) => { noteOverdue = () => resolve('overdue'); });
  const refs = new Map<string, string>();
  const supervisorTurns = new Set<string>();
  const waitsSaid = new Set<string>();
  /** When the planner's context pause began, once it is said: the plan goes out again and again while it lasts. */
  let pauseSaid: string | null = null;
  let blocked: string | null = null;
  let dirtyRepos: string[] = [];
  const taskStates = new Map<string, TaskLine>();
  let lastPrinted = '';

  function printStatus(tasks: SerializedTaskStatus[]): void {
    for (const t of tasks) {
      taskStates.set(t.id, t);
    }
    const entries = Array.from(taskStates.values());
    const lines: string[] = [];
    for (const t of entries) {
      const loop = loopNote(t, entries);
      // Between rounds a check is stored failed, and no failure while its fix runs.
      const icon = iconFor(loop?.repeating ? 'pending' : t.status);
      const verdict = t.verdict
        ? `: ${t.verdict.outcome.toUpperCase()}: ${t.verdict.reason.slice(0, 60)}`
        : '';
      // Nothing starts it on its own (ADR-0035), so a line that only said "pending" would read as next in line.
      const waits = t.waitsForApproval ? `: ${inLine(WAITS_FOR_APPROVAL_LABEL)}: \`ordewell force-start <id>\` approves it, \`ordewell run\` approves all` : '';
      lines.push(`  ${icon} ${refOf(t.id)}${t.type === 'script' ? ' [SCR]' : t.research ? ' [RES]' : ''} ${t.status}${verdict}${waits}${loop ? ` · ↻ ${inLine(loop.text)}` : ''}`);
      if (t.holdReason) lines.push(`      ${holdLabel(t.holdReason)}`);
      if (t.isolation?.state === 'conflict' && t.isolation.repairWaits) lines.push(`      ${repairWaitLabel(t.isolation.repairWaits)}`);
      if (t.status === 'skipped') lines.push(`      ${skippedLabel(t.skipReason ?? null)}`);
      // How it ended, before the next task's line: the same block `status` prints (ADR-0047).
      if (t.handoff && (t.status === 'completed' || t.status === 'failed')) lines.push(...taskHandoffLines(t.handoff, '      '));
    }
    const output = lines.join('\n');
    if (output !== lastPrinted && output.trim()) {
      if (lastPrinted) {
        const prevLines = lastPrinted.split('\n').length;
        for (let i = 0; i < prevLines; i++) process.stderr.write('\x1b[1A\x1b[2K');
      }
      process.stderr.write(output + '\n');
      lastPrinted = output;
    }
  }

  // `--unattended`: each wait on a person standing, with the count of supervisor
  // turns begun when it was first seen, so a turn that began after it is its turn.
  let standing = new Map<string, { wait: Escalation; turnsBefore: number }>();
  let turnsBegun = 0;
  let turnsEnded = 0;
  let standsCheck: ReturnType<typeof setTimeout> | undefined;
  let noteWaits: () => void = () => {};
  const waitsOnPerson = new Promise<'waits'>((resolve) => { noteWaits = () => resolve('waits'); });
  const unanswered = (): Escalation[] => [...standing.values()]
    .filter(({ turnsBefore }) => level !== 'act' || (turnsEnded > turnsBefore && turnsBegun === turnsEnded))
    .map(({ wait }) => wait);
  const judgeWaits = (): void => {
    if (!unattended) return;
    clearTimeout(standsCheck);
    if (unanswered().length > 0) standsCheck = setTimeout(() => { if (unanswered().length > 0) noteWaits(); }, WAIT_STANDS_MS);
  };
  const noteEscalations = (list: readonly Escalation[]): void => {
    standing = new Map(list.filter((w) => PERSON_WAITS.has(w.kind) && w.task).map((w) => [w.id, standing.get(w.id) ?? { wait: w, turnsBefore: turnsBegun }]));
    judgeWaits();
  };

  let pausedAtGate = false;
  let noteBlocked: () => void = () => {};
  const blockedSeen = new Promise<void>((resolve) => { noteBlocked = resolve; });
  let settleReady: (error?: Error) => void = () => {};
  const streamReady = new Promise<void>((resolve, reject) => {
    settleReady = (error) => (error ? reject(error) : resolve());
  });
  const stream = api.streamExecution(sessionId, (event) => {
    // An update leaves out what has not moved, so joining a run starts from the whole of it.
    if (event.type === 'run_snapshot') {
      for (const { task, label } of walkPlan(event.view.tasks)) {
        taskStates.set(task.id, { ...task, verdict: task.verdict ?? null });
        refs.set(task.id, `#${label}`);
      }
      level = levelOf(event.view.runSettings) ?? level;
      if (event.view.escalations) noteEscalations(event.view.escalations);
    }
    if (event.type === 'plan_generated' && 'tasks' in event.plan) {
      for (const { task, label } of walkPlan(event.plan.tasks)) refs.set(task.id, `#${label}`);
      level = levelOf(event.plan.runSettings) ?? level;
      // A supervisor that stood down leaves its waits to nobody.
      judgeWaits();
      if (event.turnId && supervisorTurns.has(event.turnId)) process.stderr.write('· The supervisor edited the plan.\n');
      // A wait on a person like any other: the turn on it, the closing turn at Act among them, goes on only on a Retry.
      const pause = event.plan.plannerContextPause;
      if (pause && pause.at !== pauseSaid) process.stderr.write('· The planner is paused on its context, and its turn waits: `ordewell compact retry` carries it on. Nobody does that unattended: it waits until someone does.\n');
      pauseSaid = pause?.at ?? null;
    }
    if (event.type === 'planner_turn_started') {
      (event.supervisor ? supervisorTurns : userTurns).add(event.turnId);
      if (event.supervisor) turnsBegun++;
      rearm();
      judgeWaits();
    }
    if (event.type === 'planner_turn_ended') {
      userTurns.delete(event.turnId);
      if (supervisorTurns.has(event.turnId)) turnsEnded++;
      rearm();
      judgeWaits();
    }
    if (event.type === 'planner_message' && event.supervisor && event.content.trim()) {
      process.stderr.write(`· Supervisor: ${event.content.trim().replace(/\n/g, '\n  ')}\n`);
    }
    if (event.type === 'execution_action' && event.record.actor === 'supervisor' && event.record.outcome === 'done') {
      process.stderr.write(`· ${event.text}\n`);
    }
    if (event.type === 'task_started') {
      // The closing turn continued the run: its next end starts the bound afresh.
      stopBound();
      process.stderr.write(`· ${taskStartedNotice(event.title, event.runner)}\n`);
    }
    if (event.type === 'checkpoint') {
      const ref = refs.get(String(event.taskId)) ?? String(event.taskId);
      process.stderr.write(`· Checkpoint: ${ref} ${event.taskTitle}: ${truncateCheckpointSummary(event.summary)}: \`ordewell checkpoint ${bare(ref)} approve|reject [reason]\` answers it.${whoAnswers(level)}\n`);
    }
    if (event.type === 'status_update' && event.escalations) {
      for (const wait of event.escalations) {
        if (wait.task) refs.set(wait.task.id, wait.task.ref);
        // A checkpoint has its own line, with the question; the other waits on a person are said once each.
        if (!wait.task || waitsSaid.has(wait.id)) continue;
        if (wait.kind === 'on-hold') {
          waitsSaid.add(wait.id);
          process.stderr.write(`· On hold: ${wait.task.ref} ${wait.task.title}: ${wait.reason.replace(/^On hold: /, '').replace(/[.\s]+$/, '')}: ${releasing(wait, bare(wait.task.ref))} releases it and what needs it.${whoReleases(level)}\n`);
          continue;
        }
        if (wait.kind !== 'input' && wait.kind !== 'approval') continue;
        waitsSaid.add(wait.id);
        const what = wait.kind === 'input' ? 'Waiting for input' : 'Waiting for approval';
        process.stderr.write(`· ${what}: ${wait.task.ref} ${wait.task.title}: ${wait.reason.replace(/[.\s]+$/, '')}: \`ordewell tui\`, then \`/open ${bare(wait.task.ref)}\`, answers it.${whoAnswers(level)}\n`);
      }
      noteEscalations(event.escalations);
    }
    if (event.type === 'status_update' && event.tasks) {
      printStatus(event.tasks);
      // Said once per pause: the run waits on a merge only the user makes (ADR-0020).
      const paused = event.runMerge?.paused === true;
      if (paused && !pausedAtGate) process.stderr.write('· Paused for Merge all: `ordewell merge` merges what has landed, and the waiting tasks start.\n');
      pausedAtGate = paused;
    }
    if (event.type === 'review_needed') {
      console.log('\nPlan needs your sign-off: run `ordewell approve` to continue.');
    }
    if (event.type === 'execution_complete') {
      const summary = event.summary;
      const skipped = summary.skipped ? `, ${summary.skipped} skipped` : '';
      console.log(
        `\nDone. ${summary.completed || 0} completed, ${summary.failed || 0} failed, ${summary.blocked ?? (summary.total - (summary.completed || 0) - (summary.failed || 0))} blocked${skipped}.`,
      );
      // The stream goes on to `run_concluded`, which at Act follows the turn this waits for.
      if (level === 'act') process.stderr.write('· The run ended: waiting for the supervisor\'s closing turn, which may continue it.\n');
      ended = summary;
      awaitingClose = level === 'act';
      rearm();
    }
    if (event.type === 'run_concluded') {
      stopBound();
      concluded = event.summary;
      if (event.supervisorHeld) process.stderr.write(`· The supervisor could not take its closing turn: ${event.supervisorHeld}.\n`);
    }
    if (event.type === 'execution_stopped') {
      stopBound();
      console.log('\nExecution stopped.');
    }
    if (event.type === 'notice') console.error(`· ${headlessSignedOut(event.message)}`);
    if (event.type === 'isolation_blocked') {
      blocked = event.message;
      dirtyRepos = event.repos ?? [];
      noteBlocked();
    }
    if (event.type === 'isolation_handoff') {
      const n = event.landed.length;
      const where = isRepoGroup(event) ? ` in ${event.repos.map((r) => r.path).join(', ')}` : '';
      console.log(`\nRun finished on ${handoffBranchName(event)}${where}: ${n} task${n === 1 ? '' : 's'} landed.`);
      if (isRepoGroup(event)) for (const line of repoResultLines(event)) console.log(`  ${line}`);
      if (event.deferredTo === 'supervisor') console.log('  The supervisor may merge it.');
      console.log('  `ordewell merge [review|discard|cleanup]` to land it.');
    }
    if (event.type === 'isolation_merge' && event.trigger?.kind === 'run_end' && event.result.outcome === 'merged') {
      console.log('\nRun finished, and merged into your branch automatically.');
    }
  }, settleReady);

  const streamFailed = (err: unknown): never => {
    console.error(`Execution stream error: ${(err as Error).message}`);
    process.exit(1);
  };
  void stream.catch(settleReady);
  await streamReady.catch(streamFailed);
  await start();
  // The stream outlives a block, which has no completion coming; the choice
  // below opens the next one, and that ends this.
  const outcome = await Promise.race([stream, blockedSeen, overdue, waitsOnPerson]).catch(streamFailed);
  clearTimeout(closingBound);
  clearTimeout(standsCheck);
  if (outcome === 'waits') {
    api.endExecutionStream(sessionId);
    for (const wait of unanswered()) process.stderr.write(`· Waits on a person: ${wait.task?.ref ?? ''} ${wait.task?.title ?? ''}: ${wait.reason.replace(/[.\s]+$/, '')}.\n`);
    process.stderr.write('· The run waits on a person, and stays as it is in the daemon: nothing was answered, stopped or skipped. `ordewell status` shows where it stands.\n');
    return 'waits';
  }
  if (outcome === 'overdue') {
    api.endExecutionStream(sessionId);
    process.stderr.write('· The supervisor\'s closing turn did not conclude in time: the run is no longer followed, and its tasks\' outcomes stand as they ended. `ordewell status` shows where it stands.\n');
    return ended;
  }
  if (outcome === 'lost') {
    console.error('Lost the connection to the daemon: the run is no longer being followed, but the daemon may still be running it. `ordewell status` shows where it stands.');
    process.exit(1);
  }

  if (blocked === null) return concluded;

  // The daemon parked the start and will hold it until it hears a choice, and a
  // parked start swallows a re-run — so without a choice, release it.
  if (!onBlocked) {
    await api.stopExecution(sessionId);
    console.error(blocked);
    const where = dirtyRepos.length > 0 ? ` in ${dirtyRepos.join(', ')}` : '';
    console.error(`Nothing was started. Re-run with \`--stash\` to stash your tracked changes${where} first, or \`--without-isolation\` to run in your working tree this once.`);
    process.exit(1);
  }
  return followRun(api, sessionId, () => (onBlocked === 'stash' ? api.continueWithStash(sessionId) : api.continueWithoutIsolation(sessionId)), undefined, level, unattended);
}

/**
 * A script task's body as `ordewell plan` shows it, printed before `run`
 * hands the plan over: `executePlan` approves every waiting task (ADR-0035),
 * so a headless user reads what they are approving before it can run.
 */
function printScriptBodies(plan: Record<string, unknown>): void {
  for (const t of allTasksOf(plan)) {
    if (t.type !== 'script' || t.status === 'completed' || t.status === 'skipped') continue;
    console.log(`  Script ${refOf(t.id)} "${t.title}":`);
    for (const line of scriptTaskText(t).split('\n')) console.log(line ? `        ${line.replace(/\t/g, '    ')}` : '');
  }
}

export async function handleRun(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const sessionId = resolveSessionId(subArgs);
  const workspace = workspaceOf(subArgs);
  const api = await connect(subArgs, injectedApi);

  let plan: Record<string, unknown>;
  try {
    plan = (await api.getSession(sessionId, workspace)).plan as unknown as Record<string, unknown>;
  } catch (err) {
    console.error(`Failed to read the plan: ${(err as Error).message}`);
    process.exit(1);
  }
  printScriptBodies(plan);

  console.error(`Executing plan...`);
  const onBlocked = hasFlag(subArgs, '--stash') ? 'stash' : hasFlag(subArgs, '--without-isolation') ? 'shared' : undefined;
  await followExecution(api, sessionId, async () => {
    try {
      const started = await api.executePlan(sessionId);
      if (started.message) console.error(started.message);
    } catch (err) {
      console.error(`Failed to start execution: ${(err as Error).message}`);
      process.exit(1);
    }
  }, onBlocked, hasFlag(subArgs, '--unattended'));
}
