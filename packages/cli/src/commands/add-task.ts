import { resolveUserTaskRef } from '@ordewell/core/plan-utils';
import { flag, flags, readLastSession, workspaceOf } from '../utils';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient } from '../apiClient';
import { taskViews } from './shared';

export async function handleAddTask(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const title = flag(subArgs, '--title');
  if (!title) {
    console.error('Usage: ordewell add-task --title "..." [--description "..."] [--prompt "..."] [--type ai|user] [--depends-on <task-id> ...] [--session-id <id>] [--workspace /path]');
    process.exit(1);
  }

  const workspace = workspaceOf(subArgs);
  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    const last = readLastSession(workspace);
    if (!last) {
      console.error(`No session specified. Use --session-id <id> or run \`ordewell plan\` in ${workspace} first.`);
      process.exit(1);
    }
    sessionId = last.sessionId;
  }

  // An unrecognised value must not fall back to 'ai': that task is one an
  // agent will go on to run.
  const typeFlag = flag(subArgs, '--type');
  if (typeFlag !== undefined && typeFlag !== 'ai' && typeFlag !== 'user') {
    console.error(`Invalid --type "${typeFlag}". Use ai or user.`);
    process.exit(1);
    return;
  }
  const type = typeFlag === 'user' ? 'user' : 'ai';
  const description = flag(subArgs, '--description') || title;
  const dependencyRefs = flags(subArgs, '--depends-on').filter(Boolean) as string[];

  const api = injectedApi || new ApiClient(await ensureDaemon(resolvePort(subArgs)), workspaceOf(subArgs));

  // Core silently drops a dependency id it does not know. Resolve order
  // numbers and id prefixes as every other task command does, and refuse what
  // names nothing rather than adding a task that can start alongside the one
  // it was meant to wait for.
  let dependencies: string[] | undefined;
  if (dependencyRefs.length > 0) {
    let tasks;
    try {
      tasks = taskViews((await api.getSession(sessionId, workspace)).plan);
    } catch (err) {
      console.error(`Failed to read the plan: ${(err as Error).message}`);
      process.exit(1);
      return;
    }
    const unresolved: string[] = [];
    dependencies = dependencyRefs.map((ref) => {
      const found = resolveUserTaskRef(tasks, ref);
      if (!found) unresolved.push(ref);
      return found?.id ?? ref;
    });
    if (unresolved.length > 0) {
      console.error(`No task matches --depends-on ${unresolved.map((ref) => `"${ref}"`).join(', ')}.`);
      process.exit(1);
      return;
    }
  }

  try {
    await api.addTask(sessionId, {
      title,
      description,
      type,
      prompt: type === 'ai' ? (flag(subArgs, '--prompt') || description) : undefined,
      dependencies: dependencies && dependencies.length ? dependencies : undefined,
      userSteps: type === 'user' ? [{ order: 1, instruction: description, completed: false }] : undefined,
    });
    console.log(`Added task: ${title}`);
  } catch (err) {
    console.error(`Failed to add task: ${(err as Error).message}`);
    process.exit(1);
  }
}
