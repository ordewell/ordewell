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
  const last = readLastSession();
  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    if (!last) {
      console.error('No session specified. Use --session-id <id> or run `ordewell plan` first.');
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

  // Sessions are stored per workspace. The daemon's own cwd is rarely the right
  // one, so fall back to the workspace `ordewell plan` last used.
  const explicitWorkspace = flag(subArgs, '--workspace');
  let plan;
  try {
    plan = (await api.getSession(sessionId, explicitWorkspace || process.cwd())).plan;
  } catch (err) {
    if (!explicitWorkspace && last?.workspace && last.workspace !== process.cwd()) {
      try {
        plan = (await api.getSession(sessionId, last.workspace)).plan;
      } catch {
        console.error(`Failed to load session: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error(`Failed to load session: ${(err as Error).message}`);
      process.exit(1);
    }
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
      `Usage: ordewell ${command} <task-id-or-order> [--session-id <id>]`,
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
