import { flag, hasFlag, readLastSession } from '../utils';
import { iconFor } from '../utils/output';
import type { ApiClient } from '../apiClient';
import { handoffBranchName, holdLabel, isRepoGroup, loopBodyLabel, loopBodyRound, loopCheckLabel, loopCheckState, repairWaitLabel, repoResultLines, scriptTaskText, skippedLabel, taskStartedNotice, truncateCheckpointSummary, WAITS_FOR_APPROVAL_LABEL, type SerializedTaskStatus } from '@ordewell/core';
import { allTasksOf } from '../utils/tasks';
import { connect } from './shared';
import { taskHandoffLines } from './taskHandoff';

const inLine = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** A task as the line names it: the stream carries no order, so its id's tail. */
const refOf = (id: string): string => `#${id.slice(-4)}`;

/**
 * What a loop's check or body task says of its place in the loop (ADR-0045),
 * read off the statuses the stream has sent; null for a task in no loop.
 * `repeating` is whether a check between rounds goes on, which a body task
 * that failed or was skipped stops, and so does nothing being left to run it.
 */
function loopNote(task: SerializedTaskStatus, all: readonly SerializedTaskStatus[]): { text: string; repeating: boolean } | null {
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

  const workspace = flag(subArgs, '--workspace') || process.cwd();
  const last = readLastSession(workspace);
  if (!last) {
    console.error(`No session specified. Use --session-id <id> or run \`ordewell plan\` in ${workspace} first.`);
    process.exit(1);
  }
  console.error(`Using last session: ${last.sessionId} ("${last.goal}")`);
  return last.sessionId;
}

/**
 * Follow a session's execution to completion, redrawing one line per task.
 * Shared by `run` and `approve` — both hand the orchestrator work and then
 * watch the same stream, and a second copy of the redraw would drift.
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
): Promise<void> {
  let blocked: string | null = null;
  let dirtyRepos: string[] = [];
  const taskStates = new Map<string, SerializedTaskStatus>();
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

  let pausedAtGate = false;
  let noteBlocked: () => void = () => {};
  const blockedSeen = new Promise<void>((resolve) => { noteBlocked = resolve; });
  let settleReady: (error?: Error) => void = () => {};
  const streamReady = new Promise<void>((resolve, reject) => {
    settleReady = (error) => (error ? reject(error) : resolve());
  });
  const stream = api.streamExecution(sessionId, (event) => {
    if (event.type === 'task_started') {
      process.stderr.write(`· ${taskStartedNotice(event.title, event.runner)}\n`);
    }
    if (event.type === 'checkpoint') {
      process.stderr.write(`· Checkpoint: ${event.taskTitle}: ${truncateCheckpointSummary(event.summary)}: \`ordewell checkpoint <id> approve|reject [reason]\` answers it\n`);
    }
    if (event.type === 'status_update' && event.tasks) {
      printStatus(event.tasks);
      // Said once per pause: the run waits on a merge only the user makes (ADR-0020).
      const paused = event.runMerge?.paused === true;
      if (paused && !pausedAtGate) process.stderr.write('· Paused for Merge all: `ordewell handoff merge` merges what has landed, and the waiting tasks start.\n');
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
    }
    if (event.type === 'execution_stopped') {
      console.log('\nExecution stopped.');
    }
    if (event.type === 'notice') console.error(`· ${event.message}`);
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
      console.log('  `ordewell handoff review|merge|discard|cleanup` to land it.');
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
  const outcome = await Promise.race([stream, blockedSeen]).catch(streamFailed);
  if (outcome === 'lost') {
    console.error('Lost the connection to the daemon: the run is no longer being followed, but the daemon may still be running it. `ordewell status` shows where it stands.');
    process.exit(1);
  }

  if (blocked === null) return;

  // The daemon parked the start and will hold it until it hears a choice, and a
  // parked start swallows a re-run — so without a choice, release it.
  if (!onBlocked) {
    await api.stopExecution(sessionId);
    console.error(blocked);
    const where = dirtyRepos.length > 0 ? ` in ${dirtyRepos.join(', ')}` : '';
    console.error(`Nothing was started. Re-run with \`--stash\` to stash your tracked changes${where} first, or \`--without-isolation\` to run in your working tree this once.`);
    process.exit(1);
  }
  await followExecution(api, sessionId, () => (onBlocked === 'stash' ? api.continueWithStash(sessionId) : api.continueWithoutIsolation(sessionId)));
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
  const workspace = flag(subArgs, '--workspace') || process.cwd();
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
  }, onBlocked);
}
