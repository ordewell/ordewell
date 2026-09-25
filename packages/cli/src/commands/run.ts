import { flag, hasFlag, readLastSession } from '../utils';
import { handoffBranch, isRepoGroup, repoResultLines } from '../isolation';
import { iconFor } from '../utils/output';
import type { ApiClient, TaskStatus } from '../daemonClient';
import { truncateCheckpointSummary } from '@ordewell/core';
import { connect } from './shared';

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
  const taskStates = new Map<string, TaskStatus>();
  let lastPrinted = '';

  function printStatus(tasks: TaskStatus[]): void {
    for (const t of tasks) {
      taskStates.set(t.id, t);
    }
    const entries = Array.from(taskStates.values());
    const lines: string[] = [];
    for (const t of entries) {
      const icon = iconFor(t.status);
      const verdict = t.verdict
        ? ` — ${t.verdict.outcome.toUpperCase()}: ${t.verdict.reason.slice(0, 60)}`
        : '';
      lines.push(`  ${icon} #${t.id.slice(-4)} ${t.status}${verdict}`);
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

  let settleReady: (error?: Error) => void = () => {};
  const streamReady = new Promise<void>((resolve, reject) => {
    settleReady = (error) => (error ? reject(error) : resolve());
  });
  const stream = api.streamExecution(sessionId, (event) => {
    if (event.type === 'task_started') {
      process.stderr.write(`[${event.order}/${event.title}] Started: ${event.runner} / ${event.modelId}\n`);
    }
    if (event.type === 'checkpoint') {
      process.stderr.write(`· Checkpoint — ${event.taskTitle}: ${truncateCheckpointSummary(event.summary)}\n`);
    }
    if (event.type === 'status_update' && event.tasks) {
      printStatus(event.tasks as TaskStatus[]);
    }
    if (event.type === 'review_needed') {
      console.log('\nPlan needs your sign-off — run `ordewell approve` to continue.');
    }
    if (event.type === 'execution_complete') {
      const s = event as { summary?: { completed?: number; failed?: number; blocked?: number; total: number } };
      const summary = s.summary || { total: 0 };
      console.log(
        `\nDone. ${summary.completed || 0} completed, ${summary.failed || 0} failed, ${summary.blocked ?? (summary.total - (summary.completed || 0) - (summary.failed || 0))} blocked.`,
      );
    }
    if (event.type === 'execution_stopped') {
      console.log('\nExecution stopped.');
    }
    if (event.type === 'notice') console.error(`· ${event.message}`);
    if (event.type === 'isolation_blocked') {
      blocked = event.message;
      dirtyRepos = event.repos ?? [];
    }
    if (event.type === 'isolation_handoff') {
      const n = event.landed.length;
      const where = isRepoGroup(event) ? ` in ${event.repos.map((r) => r.path).join(', ')}` : '';
      console.log(`\nRun finished on ${handoffBranch(event)}${where} — ${n} task${n === 1 ? '' : 's'} landed.`);
      if (isRepoGroup(event)) for (const line of repoResultLines(event)) console.log(`  ${line}`);
      console.log('  `ordewell handoff review|merge|discard|cleanup` to land it.');
    }
  }, settleReady);

  const streamFailed = (err: unknown): never => {
    console.error(`Execution stream error: ${(err as Error).message}`);
    process.exit(1);
  };
  void stream.catch(settleReady);
  await streamReady.catch(streamFailed);
  await start();
  await stream.catch(streamFailed);

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

export async function handleRun(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const sessionId = resolveSessionId(subArgs);
  const api = await connect(subArgs, injectedApi);

  console.error(`Executing plan...`);
  const onBlocked = hasFlag(subArgs, '--stash') ? 'stash' : hasFlag(subArgs, '--without-isolation') ? 'shared' : undefined;
  await followExecution(api, sessionId, async () => {
    try {
      await api.executePlan(sessionId);
    } catch (err) {
      console.error(`Failed to start execution: ${(err as Error).message}`);
      process.exit(1);
    }
  }, onBlocked);
}
