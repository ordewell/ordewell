import { flag, hasFlag, positionals, readLastSession, resolveTaskId } from '../utils';
import { askYesNo, fail } from './shared';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient, type PlanBody } from '../apiClient';
import { DELEGATION_OFFERED, parseCount, pastGateConfirmation, taskActionCommand, titledTaskRef, type TaskAction } from '@ordewell/core';

type Action = Extract<TaskAction, 'run' | 'force-start' | 'retry' | 'cancel'>;

/**
 * Resolve `--session-id` (falling back to the last planned session) and the
 * task as the user typed it, with the client to send it by. The reference is
 * resolved by whoever acts on it: the command seam, for a control.
 */
async function sessionAndRef(
  subArgs: string[],
  usage: string,
  injectedApi: ApiClient | undefined,
): Promise<{ api: ApiClient; sessionId: string; ref: string; workspace: string }> {
  const workspace = flag(subArgs, '--workspace') || process.cwd();
  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    const last = readLastSession(workspace);
    if (!last) {
      console.error(`No session specified. Use --session-id <id> or run \`ordewell plan\` in ${workspace} first.`);
      process.exit(1);
    }
    sessionId = last.sessionId;
  }

  const ref = positionals(subArgs)[0];
  if (!ref) {
    console.error(usage);
    process.exit(1);
  }

  const api = injectedApi || new ApiClient(await ensureDaemon(resolvePort(subArgs)));
  return { api, sessionId, ref, workspace };
}

/**
 * A task-scoped control: the task is sent as typed (an id, "#order" or title)
 * and the daemon's command seam resolves it, so there is no plan to fetch first.
 */
export async function withTaskRef(
  subArgs: string[],
  usage: string,
  injectedApi: ApiClient | undefined,
  run: (api: ApiClient, sessionId: string, ref: string) => Promise<void>,
): Promise<void> {
  const { api, sessionId, ref } = await sessionAndRef(subArgs, usage, injectedApi);
  await run(api, sessionId, ref);
}

/**
 * A plan edit that names a task: not a control, so no seam resolves the name
 * and the task's id is looked up in the plan here.
 */
export async function withResolvedTask(
  subArgs: string[],
  usage: string,
  injectedApi: ApiClient | undefined,
  run: (api: ApiClient, sessionId: string, taskId: string, plan: PlanBody) => Promise<void>,
): Promise<void> {
  const { api, sessionId, ref, workspace } = await sessionAndRef(subArgs, usage, injectedApi);

  let plan;
  try {
    plan = (await api.getSession(sessionId, workspace)).plan;
  } catch (err) {
    console.error(`Failed to load session: ${(err as Error).message}`);
    process.exit(1);
  }

  const taskId = resolveTaskId(plan, ref);
  if (!taskId) {
    console.error(`Task not found: "${ref}"`);
    process.exit(1);
  }

  await run(api, sessionId, taskId, plan);
}

/** Starting a task outside the scheduler, which is what can pass a merge gate. */
const PASSES_GATE: ReadonlySet<Action> = new Set<Action>(['run', 'force-start']);

/**
 * Whether a start passes a merge gate (ADR-0020): asks first, naming the work
 * the task would act without; `--yes` is the scriptable way to have asked
 * already. A start the user confirmed past a gate is the force start that
 * passes it — the seam refuses `run_task` for a gated task.
 */
async function confirmPastGate(subArgs: string[], api: ApiClient, sessionId: string, ref: string, confirm: (question: string) => Promise<boolean>): Promise<boolean> {
  // A daemon that cannot say (an older one, or a session it does not hold) is
  // left to answer the start itself.
  const unmerged = await api.getMergeGate(sessionId, ref).catch(() => []);
  if (unmerged.length === 0) return false;
  if (hasFlag(subArgs, '--yes')) return true;
  const question = `${pastGateConfirmation(unmerged.map((d) => titledTaskRef(d)))} Start it anyway?`;
  if (!(await confirm(question))) fail('Not started: nothing was changed. Pass --yes to start it without a prompt.');
  return true;
}

function makeHandler(action: Action, command: string = action) {
  const yes = PASSES_GATE.has(action) ? ' [--yes]' : '';
  return async function handle(subArgs: string[], injectedApi?: ApiClient, confirm: (question: string) => Promise<boolean> = askYesNo): Promise<void> {
    await withTaskRef(
      subArgs,
      `Usage: ordewell ${command} <task-id-or-order> [--session-id <id>] [--workspace /path]${yes}`,
      injectedApi,
      async (api, sessionId, ref) => {
        const pastGate = PASSES_GATE.has(action) ? await confirmPastGate(subArgs, api, sessionId, ref, confirm) : false;
        const control: Action = pastGate && action === 'run' ? 'force-start' : action;
        try {
          const { message } = await api.execute(sessionId, taskActionCommand(control, ref));
          console.log(message);
        } catch (err) {
          console.error(`Failed to ${control} task: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
  };
}

/**
 * Continue a finished structured task in its saved runner session, with the
 * rest of the line as its next turn (ADR-0018, K1). The daemon starts the new
 * attempt; its progress is followed like any run (`ordewell status`).
 */
export async function handleContinue(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const usage = 'Usage: ordewell continue <task-id-or-order> <message> [--session-id <id>] [--workspace /path]';
  const message = positionals(subArgs).slice(1).join(' ').trim();
  if (!message) {
    console.error(usage);
    process.exit(1);
  }
  await withTaskRef(subArgs, usage, injectedApi, async (api, sessionId, ref) => {
    try {
      const sent = await api.execute(sessionId, { command: 'retry_task', task: ref, from: 'session', message });
      console.log(sent.message);
    } catch (err) {
      console.error(`Failed to continue task: ${(err as Error).message}`);
      process.exit(1);
    }
  });
}

/**
 * Answer the checkpoint a task waits at. Approving carries no note — what the
 * runner is told is only that it was approved — so one given is refused rather than
 * dropped; a rejection's reason is the rest of the line.
 */
export async function handleCheckpoint(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const usage = `Usage: ordewell checkpoint <task-id-or-order> approve|reject [reason]${DELEGATION_OFFERED ? ' [--raise <tokens>] [--answer <words>]' : ''} [--session-id <id>] [--workspace /path]`;
  const [, answer, ...words] = positionals(subArgs);
  const reason = words.join(' ').trim();
  if (answer !== 'approve' && answer !== 'reject') {
    console.error(usage);
    process.exit(1);
  }
  const said = flag(subArgs, '--answer')?.trim();
  const raiseText = flag(subArgs, '--raise');
  const raiseTokens = raiseText === undefined ? undefined : parseCount(raiseText, 1);
  if (raiseTokens === null || (answer === 'reject' && (raiseTokens !== undefined || said !== undefined))) {
    console.error(`A raise is a whole number of tokens, and it and --answer go with approve.\n${usage}`);
    process.exit(1);
  }
  if (answer === 'approve' && reason) {
    console.error(`Approving takes no note: reject with a reason to tell the task something.\n${usage}`);
    process.exit(1);
  }
  await withTaskRef(subArgs, usage, injectedApi, async (api, sessionId, ref) => {
    try {
      const sent = answer === 'approve'
        ? await api.approveTaskCheckpoint(sessionId, ref, { ...(said ? { reason: said } : {}), ...(raiseTokens !== undefined ? { raiseTokens } : {}) })
        : await api.rejectTaskCheckpoint(sessionId, ref, reason || undefined);
      console.log(sent.message ?? (answer === 'approve' ? 'Checkpoint approved.' : 'Checkpoint rejected.'));
    } catch (err) {
      console.error(`Failed to ${answer} checkpoint: ${(err as Error).message}`);
      process.exit(1);
    }
  });
}

export const handleRunTask = makeHandler('run', 'run-task');
export const handleForceStart = makeHandler('force-start');
export const handleRetry = makeHandler('retry');
export const handleCancel = makeHandler('cancel');
