import { flag, readLastSession } from '../utils';
import { iconFor } from '../utils/output';
import { ensureDaemon, ApiClient, resolvePort, type TaskStatus } from '../daemonClient';

/**
 * Resolve the session every execution command acts on: `--session-id`, else the
 * one `ordewell plan` last created.
 */
export function resolveSessionId(subArgs: string[]): string {
  const explicit = flag(subArgs, '--session-id');
  if (explicit) return explicit;

  const last = readLastSession();
  if (!last) {
    console.error('No session specified. Use --session-id <id> or run `ordewell plan` first.');
    process.exit(1);
  }
  console.error(`Using last session: ${last.sessionId} ("${last.goal}")`);
  return last.sessionId;
}

/**
 * Follow a session's execution to completion, redrawing one line per task.
 * Shared by `run` and `approve` — both hand the orchestrator work and then
 * watch the same stream, and a second copy of the redraw would drift.
 */
export async function followExecution(api: ApiClient, sessionId: string): Promise<void> {
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

  try {
    await api.streamExecution(sessionId, (event) => {
      if (event.type === 'task_started') {
        process.stderr.write(`[${event.order}/${event.title}] Started: ${event.runner} / ${event.modelId}\n`);
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
    });
  } catch (err) {
    console.error(`Execution stream error: ${(err as Error).message}`);
    process.exit(1);
  }
}

export async function handleRun(subArgs: string[]): Promise<void> {
  const sessionId = resolveSessionId(subArgs);
  const api = new ApiClient(await ensureDaemon(resolvePort(subArgs)));

  console.error(`Executing plan...`);
  try {
    await api.executePlan(sessionId);
  } catch (err) {
    console.error(`Failed to start execution: ${(err as Error).message}`);
    process.exit(1);
  }

  await followExecution(api, sessionId);
}
