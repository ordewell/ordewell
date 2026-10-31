import { assignmentFlagText } from '../tui/blocks';
import { writeFileSync } from 'fs';
import { flag, hasFlag, readLastSession } from '../utils';
import { iconFor } from '../utils/output';
import { blockedByLabel, handoffBaseLine, holdLabel, isolationViewOfPlan, loopRowParts, planBlocks, repairWaitLabel, scriptTaskText, skippedLabel, flattenTasks, taskOrderLabel, taskRowView, tasksTotalText, usageText, waitsForApproval, walkPlan, type ApprovalRecord, type AssignmentScope, type RunView } from '@ordewell/core';
import { allTasksOf } from '../utils/tasks';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient, type SessionMeta } from '../apiClient';
import { taskHandoffLines } from './taskHandoff';

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
    printOneSession(sessionId, session.meta, session.plan, await assignmentScope(api), session.run);
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

/**
 * The runners and models the user allows, read as the TUI reads them, so a
 * task outside them is flagged here as on every surface (ADR-0043). A daemon
 * that cannot say leaves the rows unflagged rather than the status unprinted.
 */
async function assignmentScope(api: ApiClient): Promise<AssignmentScope | undefined> {
  try {
    const [runners, settings, models] = await Promise.all([api.getRunners(), api.getSettings(), api.getModels()]);
    // With no runners listed, every task would read as on one switched off.
    if (!Array.isArray(runners.runners) || runners.runners.length === 0) return undefined;
    return {
      enabledRunners: runners.runners.filter((r) => r.enabled).map((r) => r.id),
      allowlist: settings.modelAllowlist ?? {},
      models: models.modelsByRunner ?? {},
    };
  } catch {
    return undefined;
  }
}

function printOneSession(
  sessionId: string,
  meta: SessionMeta,
  plan: Record<string, unknown>,
  runnerScope: AssignmentScope | undefined,
  run: RunView | undefined,
): void {
  const allTasks = allTasksOf(plan);
  const everyTask = flattenTasks(allTasks);
  const { blocked, repeating } = planBlocks(everyTask.map((t) => ({ ...t, subtasks: [], dependencies: t.dependencies ?? [] })));
  // A hold is live session state; a saved plan has none, and a surface does not rebuild one from it.
  const holds = new Map<string, string>();
  const repairs = new Map<string, string>();
  const stranded = new Set<string>();
  for (const { task } of walkPlan(run?.tasks ?? [])) {
    if (task.holdReason) holds.set(task.id, task.holdReason);
    if (task.loopStranded) stranded.add(task.id);
    if (task.isolation?.state === 'conflict' && task.isolation.repairWaits) repairs.set(task.id, repairWaitLabel(task.isolation.repairWaits));
  }
  // A session the daemon does not hold has no run, so nothing will run a check between rounds (ADR-0053).
  if (!run) for (const id of repeating) stranded.add(id);
  // A check between rounds is stored failed, and no failure while its loop goes on (ADR-0045 L3).
  const goesOn = (id: string) => repeating.has(id) && !stranded.has(id);
  const count = (status: string) => everyTask.filter((t) => (t.status === status && !(status === 'failed' && goesOn(t.id))) || (status === 'blocked' && blocked.has(t.id))).length;

  console.log(`Session:  ${sessionId}`);
  console.log(`Goal:     ${meta.goal}`);
  console.log(`Runner:   ${(meta.runners || []).join(', ')}  |  Status: ${meta.status}`);
  console.log(`Phase:    ${plan?.phase || 'unknown'}  |  Created: ${meta.createdAt}`);
  const isolation = isolationViewOfPlan(plan);
  if (isolation) console.log(`Base:     ${handoffBaseLine(isolation.handoff, 8)}`);
  console.log(`Tasks:    ${everyTask.length} total  |  ${count('completed')} done  |  ${count('failed')} failed  |  ${count('in_progress')} running  |  ${count('blocked')} blocked  |  ${count('skipped')} skipped\n`);

  const total = tasksTotalText(allTasks);
  if (total) console.log(total);
  const record = servedApprovalRecord(plan);
  const approval = (row: { waitsForApproval: string | null }, ref: string) => (row.waitsForApproval
    ? `${row.waitsForApproval}: \`ordewell force-start ${ref}\` approves it, \`ordewell run\` approves all`
    : null);
  for (const t of allTasks) {
    const model = t.assignedModel ? ` (${t.assignedModel.modelLabel})` : '';
    const shortId = (t.id ?? '').slice(-8);
    const row = taskRowView({ ...t, dependencies: t.dependencies ?? [], waitsForApproval: waitsForApproval(t, record), holdReason: holds.get(t.id), loopStranded: stranded.has(t.id) }, { tasks: allTasks, runnerScope });
    const icon = iconFor(blocked.has(t.id) ? 'blocked' : goesOn(t.id) ? 'pending' : t.status);
    console.log(`  ${taskOrderLabel(t).padStart(2)}. ${icon} [${shortId}]${row.kind === 'script' ? ' [SCR]' : row.research ? ' [RES]' : ''} ${t.title}${model}`);
    // What the user approves and what runs: the body as the plan holds it, not a summary (ADR-0035).
    if (t.type === 'script') {
      for (const line of scriptTaskText(t).split('\n')) console.log(line ? `      ${line.replace(/\t/g, '    ')}` : '');
    }
    const waiting = approval(row, taskOrderLabel(t));
    if (waiting) console.log(`      ${waiting}`);
    if (row.holdReason) console.log(`      ${holdLabel(row.holdReason)}`);
    if (repairs.has(t.id)) console.log(`      ${repairs.get(t.id)}`);
    if (row.assignmentFlag) console.log(`      ⚠ ${assignmentFlagText(row)}`);
    if (row.blockedBy) console.log(`      ${blockedByLabel(row.blockedBy)}`);
    if (row.loop) console.log(`      ↻ ${loopRowParts(row.loop).join(' · ')}`);
    if (row.status === 'skipped') console.log(`      ${skippedLabel(row.skipReason)}`);
    const usage = row.usage && usageText(row.usage);
    if (usage) console.log(`      ${usage}`);
    if (t.handoff && (t.status === 'completed' || t.status === 'failed')) {
      for (const line of taskHandoffLines(t.handoff, '      ')) console.log(line);
    }
    for (const sub of t.subtasks || []) {
      const subIcon = iconFor(blocked.has(sub.id) ? 'blocked' : sub.status);
      const subModel = sub.assignedModel ? ` (${sub.assignedModel.modelLabel})` : '';
      const subShortId = (sub.id ?? '').slice(-8);
      console.log(`    ${taskOrderLabel(sub, t)}. ${subIcon} [${subShortId}] ${sub.title}${subModel}`);
      const subRow = taskRowView({ ...sub, dependencies: sub.dependencies ?? [], waitsForApproval: waitsForApproval(sub, record), holdReason: holds.get(sub.id) }, { parent: t, tasks: allTasks, runnerScope });
      const subWaiting = approval(subRow, taskOrderLabel(sub, t));
      if (subWaiting) console.log(`        ${subWaiting}`);
      if (subRow.holdReason) console.log(`        ${holdLabel(subRow.holdReason)}`);
      if (repairs.has(sub.id)) console.log(`        ${repairs.get(sub.id)}`);
      if (subRow.assignmentFlag) console.log(`        ⚠ ${assignmentFlagText(subRow)}`);
      if (subRow.blockedBy) console.log(`        ${blockedByLabel(subRow.blockedBy)}`);
      if (subRow.status === 'skipped') console.log(`        ${skippedLabel(subRow.skipReason)}`);
      const subUsage = subRow.usage && usageText(subRow.usage);
      if (subUsage) console.log(`        ${subUsage}`);
      if (sub.handoff && (sub.status === 'completed' || sub.status === 'failed')) {
        for (const line of taskHandoffLines(sub.handoff, '        ')) console.log(line);
      }
    }
  }
}

/** The approval record the daemon serves with the plan; one it lacks reads as no approval, which singles nothing out. */
function servedApprovalRecord(plan: Record<string, unknown>): ApprovalRecord {
  const approvedTasks = Array.isArray(plan?.approvedTasks) ? plan.approvedTasks.filter((id): id is string => typeof id === 'string') : undefined;
  return { approved: plan?.approved === true, ...(approvedTasks ? { approvedTasks } : {}) };
}
