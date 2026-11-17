import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleRun } from '../run';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

describe('ordewell run when a task asks a checkpoint', () => {
  it('names the task, its question, and the command that answers it', async () => {
    const script: Event[] = [
      { type: 'checkpoint', taskId: 't1', taskTitle: 'Migrate the schema', summary: 'Drop the users table?\nIt holds 40k rows.' },
      { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0, blocked: 0, skipped: 0 } },
    ];
    const api = {
      getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }),
      streamExecution: vi.fn((_id: string, onEvent: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
        setTimeout(() => onReady?.(), 0);
        setTimeout(() => { script.forEach(onEvent); resolve(); }, 5);
      })),
      executePlan: vi.fn().mockResolvedValue({ status: 'running' }),
    } as unknown as ApiClient;
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRun(['--session-id', 's1'], api);
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }

    // A daemon that cannot say the level or the plan: the task's id stands in for its reference.
    expect(written.join('')).toContain('· Checkpoint: t1 Migrate the schema: Drop the users table?: `ordewell checkpoint t1 approve|reject [reason]` answers it.\n');
  });
});

describe('ordewell run when the daemon drops mid-run', () => {
  it('reports the lost connection and exits non-zero', async () => {
    const api = {
      getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }),
      streamExecution: vi.fn((_id: string, _onEvent: unknown, onReady?: (error?: Error) => void) => new Promise<'lost'>((resolve) => {
        setTimeout(() => onReady?.(), 0);
        setTimeout(() => resolve('lost'), 5);
      })),
      executePlan: vi.fn().mockResolvedValue({ status: 'running' }),
    } as unknown as ApiClient;
    const errors: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);

    try {
      await expect(handleRun(['--session-id', 's1'], api)).rejects.toThrow('exit 1');
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }

    expect(errors.join('\n')).toContain('Lost the connection to the daemon');
  });
});
