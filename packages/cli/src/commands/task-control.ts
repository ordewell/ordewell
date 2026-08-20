import { flag, positionals, readLastSession, resolveTaskId } from '../utils';
import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';
import type { SerializedPlan } from '@ordewell/core';

type Action = 'run' | 'force-start' | 'retry' | 'cancel';

const PAST_TENSE: Record<Action, string> = {
  run: 'Task started.',
  'force-start': 'Task force-started.',
  retry: 'Task retried.',
  cancel: 'Task cancelled.',
};

/**
 * Resolve `--session-id` (falling back to the last planned session) and turn a
 * task identifier into a real task ID. Shared by every task-scoped command.
 */
export async function withResolvedTask(
  subArgs: string[],
  usage: string,
  injectedApi: ApiClient | undefined,
  run: (api: ApiClient, sessionId: string, taskId: string, plan: SerializedPlan) => Promise<void>,
): Promise<void> {
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

  const identifier = positionals(subArgs)[0];
  if (!identifier) {
    console.error(usage);
    process.exit(1);
  }

  const api = injectedApi || new ApiClient(await ensureDaemon(resolvePort(subArgs)));

  let plan;
  try {
    plan = (await api.getSession(sessionId, workspace)).plan;
  } catch (err) {
    console.error(`Failed to load session: ${(err as Error).message}`);
    process.exit(1);
  }

  const taskId = resolveTaskId(plan, identifier);
  if (!taskId) {
    console.error(`Task not found: "${identifier}"`);
    process.exit(1);
  }

  await run(api, sessionId, taskId, plan as SerializedPlan);
}

function makeHandler(action: Action, command: string = action) {
  return async function handle(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
    await withResolvedTask(
      subArgs,
      `Usage: ordewell ${command} <task-id-or-order> [--session-id <id>] [--workspace /path]`,
      injectedApi,
      async (api, sessionId, taskId) => {
        try {
          await api.taskControl(sessionId, taskId, action);
          console.log(PAST_TENSE[action]);
        } catch (err) {
          console.error(`Failed to ${action} task: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
  };
}

export const handleRunTask = makeHandler('run', 'run-task');
export const handleForceStart = makeHandler('force-start');
export const handleRetry = makeHandler('retry');
export const handleCancel = makeHandler('cancel');
