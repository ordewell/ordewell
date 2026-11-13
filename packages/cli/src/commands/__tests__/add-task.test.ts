import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleAddTask } from '../add-task';

function client(planTasks: unknown[], addTask = vi.fn(async () => ({ ok: true }))) {
  return {
    addTask,
    getSession: vi.fn(async () => ({ meta: { id: 's1' }, plan: { tasks: planTasks } })),
  } as unknown as ApiClient;
}

function captureExit(): { exitCode: () => number | null; restore: () => void } {
  let code: number | null = null;
  const spy = vi.spyOn(process, 'exit').mockImplementation(((value?: number) => {
    code = value ?? 0;
    throw new Error(`exit:${code}`);
  }) as never);
  return { exitCode: () => code, restore: () => spy.mockRestore() };
}

describe('add-task', () => {
  it('leaves the mode for the runner to resolve, since no name holds on every runner', async () => {
    const api = client([]);

    await handleAddTask(['--title', 'New', '--session-id', 's1'], api);

    expect(vi.mocked(api.addTask).mock.calls[0][1]).not.toHaveProperty('taskMode');
  });
});

describe('add-task --depends-on', () => {
  it('reads the plan from the workspace it was told, not the one the daemon started in', async () => {
    const api = client([{ id: 'task-abc', order: 2, title: 'Two', status: 'pending' }]);

    // Absolute as the CLI makes it: a POSIX-looking path is drive-relative on Windows.
    const elsewhere = path.resolve('/elsewhere');

    await handleAddTask(['--title', 'New', '--depends-on', '2', '--session-id', 's1', '--workspace', elsewhere], api);

    expect(api.getSession).toHaveBeenCalledWith('s1', elsewhere);
  });

  it('resolves an order number to the task id before sending it', async () => {
    const api = client([{ id: 'task-abc', order: 2, title: 'Two', status: 'pending' }]);

    await handleAddTask(['--title', 'New', '--depends-on', '2', '--session-id', 's1'], api);

    expect(api.addTask).toHaveBeenCalledWith('s1', expect.objectContaining({ dependencies: ['task-abc'] }));
  });

  it('refuses a reference that names no task instead of dropping it silently', async () => {
    const exit = captureExit();
    const api = client([{ id: 'task-abc', order: 2, title: 'Two', status: 'pending' }]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(handleAddTask(['--title', 'New', '--depends-on', '9', '--session-id', 's1'], api))
        .rejects.toThrow('exit:1');

      expect(api.addTask).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join('\n')).toContain('9');
    } finally {
      error.mockRestore();
      exit.restore();
    }
  });
});

describe('add-task --type', () => {
  it.each(['User', 'usr', 'human', ''])('refuses %j rather than creating an AI task an agent would run', async (type) => {
    const api = client([]);
    const exit = captureExit();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      await expect(handleAddTask(['--title', 'New', '--type', type, '--session-id', 's1'], api)).rejects.toThrow('exit:1');
    } finally {
      exit.restore();
      vi.restoreAllMocks();
    }

    expect(api.addTask).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--type');
  });

  it.each([
    ['last', ['--title', 'Sign the release', '--session-id', 's1', '--type']],
    ['before another option', ['--title', 'Sign the release', '--type', '--session-id', 's1']],
  ])('refuses a --type with no value (%s), as `--type $TYPE` with TYPE empty and unquoted leaves it', async (_where, args) => {
    const api = client([]);
    const exit = captureExit();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      await expect(handleAddTask(args, api)).rejects.toThrow('exit:1');
    } finally {
      exit.restore();
      vi.restoreAllMocks();
    }

    expect(api.addTask).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--type');
  });

  it.each([['user', 'user'], ['ai', 'ai']])('accepts %s', async (given, sent) => {
    const api = client([]);

    await handleAddTask(['--title', 'New', '--type', given, '--session-id', 's1'], api);

    expect(api.addTask).toHaveBeenCalledWith('s1', expect.objectContaining({ type: sent }));
  });
});
