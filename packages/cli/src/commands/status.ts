import { writeFileSync } from 'fs';
import { flag, hasFlag, readLastSession } from '../utils';
import { iconFor } from '../utils/output';
import { taskOrderLabel } from '@ordewell/core';
import { ensureDaemon, ApiClient, resolvePort, type SessionMeta } from '../daemonClient';

export async function handleStatus(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const sessionId = flag(subArgs, '--session-id');
  const workspace = flag(subArgs, '--workspace') || process.cwd();
  const outputPath = flag(subArgs, '--output');
  // --output implies JSON: writing the human table to a file helps nobody.
  const asJson = hasFlag(subArgs, '--json') || Boolean(outputPath);

  const port = injectedApi ? resolvePort(subArgs) : await ensureDaemon(resolvePort(subArgs));
  const api = injectedApi || new ApiClient(port);

  if (sessionId) {
    const session = await api.getSession(sessionId, workspace);
    if (asJson) {
      emitJson(session, outputPath);
      return;
    }
    printOneSession(sessionId, session.meta, session.plan);
  } else {
    const sessions = await api.getSessions(workspace);
    if (asJson) {
      emitJson(sessions, outputPath);
      return;
    }
    if (sessions.length === 0) {
      console.log(`No sessions found in ${workspace}.`);
      return;
    }
    console.log(`${sessions.length} session(s):\n`);
    for (const s of sessions) {
      console.log(`  ${s.id.slice(-8)}  ${s.status.padEnd(10)}  ${s.taskCount} tasks  ${(s.runners || []).join(',').padEnd(12)}  ${s.goal.slice(0, 60)}`);
    }
    const last = readLastSession(workspace);
    if (last) {
      console.log(`\n  Last active: ${last.sessionId.slice(-8)} ("${last.goal.slice(0, 50)}")`);
    }
    console.log(`\n  API server: http://127.0.0.1:${port}`);
  }
}

function emitJson(payload: unknown, outputPath?: string): void {
  const json = JSON.stringify(payload, null, 2);
  if (!outputPath) {
    console.log(json);
    return;
  }
  try {
    writeFileSync(outputPath, json + '\n');
    console.log(`Wrote ${outputPath}`);
  } catch (err) {
    console.error(`Failed to write ${outputPath}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printOneSession(
  sessionId: string,
  meta: SessionMeta,
  plan: Record<string, unknown>,
): void {
  const tasks = (plan?.pendingTasks || plan?.tasks || []) as Array<import("@ordewell/core").Task>;
  const executionLog = (plan?.executionLog || []) as Array<import("@ordewell/core").Task>;
  const completed = tasks.filter((t: import("@ordewell/core").Task) => t.status === 'completed').length + executionLog.filter((t: import("@ordewell/core").Task) => t.status === 'completed').length;
  const failed = tasks.filter((t: import("@ordewell/core").Task) => t.status === 'failed').length + executionLog.filter((t: import("@ordewell/core").Task) => t.status === 'failed').length;
  const running = tasks.filter((t: import("@ordewell/core").Task) => t.status === 'in_progress').length;
  const blocked = tasks.filter((t: import("@ordewell/core").Task) => t.status === 'blocked').length;

  const allTasks = [...executionLog, ...tasks];

  console.log(`Session:  ${sessionId}`);
  console.log(`Goal:     ${meta.goal}`);
  console.log(`Runner:   ${(meta.runners || []).join(', ')}  |  Status: ${meta.status}`);
  console.log(`Phase:    ${plan?.phase || 'unknown'}  |  Created: ${meta.createdAt}`);
  console.log(`Tasks:    ${allTasks.length} total  |  ${completed} done  |  ${failed} failed  |  ${running} running  |  ${blocked} blocked\n`);

  for (const t of allTasks) {
    const icon = iconFor(t.status);
    const model = t.assignedModel ? ` (${t.assignedModel.modelLabel})` : '';
    const shortId = (t.id ?? '').slice(-8);
    console.log(`  ${taskOrderLabel(t).padStart(2)}. ${icon} [${shortId}] ${t.title}${model}`);
    for (const sub of t.subtasks || []) {
      const subIcon = iconFor(sub.status);
      const subModel = sub.assignedModel ? ` (${sub.assignedModel.modelLabel})` : '';
      const subShortId = (sub.id ?? '').slice(-8);
      console.log(`    ${taskOrderLabel(sub, t)}. ${subIcon} [${subShortId}] ${sub.title}${subModel}`);
    }
  }
}
