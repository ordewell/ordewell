import { flag, flags, readLastSession } from '../utils';
import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

export async function handleAddTask(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const title = flag(subArgs, '--title');
  if (!title) {
    console.error('Usage: ordewell add-task --title "..." [--description "..."] [--prompt "..."] [--type ai|user] [--depends-on <task-id> ...] [--session-id <id>] [--workspace /path]');
    process.exit(1);
  }

  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    const workspace = flag(subArgs, '--workspace') || process.cwd();
    const last = readLastSession(workspace);
    if (!last) {
      console.error(`No session specified. Use --session-id <id> or run \`ordewell plan\` in ${workspace} first.`);
      process.exit(1);
    }
    sessionId = last.sessionId;
  }

  const type = flag(subArgs, '--type') === 'user' ? 'user' : 'ai';
  const description = flag(subArgs, '--description') || title;
  const dependencies = flags(subArgs, '--depends-on').filter(Boolean) as string[];

  const api = injectedApi || new ApiClient(await ensureDaemon(resolvePort(subArgs)));

  try {
    await api.addTask(sessionId, {
      title,
      description,
      type,
      prompt: type === 'ai' ? (flag(subArgs, '--prompt') || description) : undefined,
      taskMode: 'build',
      dependencies: dependencies.length ? dependencies : undefined,
      userSteps: type === 'user' ? [{ order: 1, instruction: description, completed: false }] : undefined,
    });
    console.log(`Added task: ${title}`);
  } catch (err) {
    console.error(`Failed to add task: ${(err as Error).message}`);
    process.exit(1);
  }
}
