import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleRun } from '../run';
import { EMPTY_RUN, type RunView } from '@ordewell/core';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

/** A daemon with no task in its plan: these tests feed the status stream directly. */
const noPlan = () => ({ getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }) });

const handoff = {
  summary: 'The cache key omits the tenant.',
  findings: [
    { id: 'F1', severity: 'blocker' as const, title: 'Cache key leaks across tenants' },
    { id: 'F2', severity: 'major' as const, title: 'No regression test' },
  ],
  findingCount: 2,
  artifacts: [{ kind: 'file' as const, path: 'src/cache.ts', line: 42 }],
};

async function run(script: Event[]): Promise<string> {
  const api = {
    ...noPlan(),
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
  return written.join('');
}

describe('ordewell run joining a run', () => {
  it('keeps every task on its lines, though an update carries only the task that moved', async () => {
    const task = (id: string, status: 'completed' | 'pending') => ({ id, order: 1, title: id, description: '', prompt: '', type: 'task' as const, status, verdict: null, subtasks: [] });
    const view = { ...EMPTY_RUN, tasks: [task('task-0001', 'completed'), task('task-0002', 'pending')] } as unknown as RunView;

    const out = await run([
      { type: 'run_snapshot', sessionId: 's1', view },
      { type: 'status_update', tasks: [{ id: 'task-0002', status: 'completed', verdict: null }] },
    ]);

    expect(out).toContain('#0001 completed');
    expect(out).toContain('#0002 completed');
  });
});

describe('ordewell run prints a task\'s handoff when it ends (ADR-0047)', () => {
  it('puts the summary, finding titles and artifacts under the task, before the next task\'s line', async () => {
    const out = await run([
      { type: 'status_update', tasks: [
        { id: 'task-0001', status: 'completed', verdict: null, handoff },
        { id: 'task-0002', status: 'pending', verdict: null },
      ] },
      { type: 'execution_complete', summary: { total: 2, completed: 1, failed: 0, blocked: 0, skipped: 0 } },
    ]);

    const lines = out.split('\n');
    const row = lines.findIndex((l) => l.includes('#0001'));
    expect(lines.slice(row + 1, row + 5)).toEqual([
      '      ↳ Handoff: The cache key omits the tenant.',
      '      F1 [blocker] Cache key leaks across tenants',
      '      F2 [major] No regression test',
      '      Artifacts: src/cache.ts:42 (unresolved)',
    ]);
    expect(lines[row + 5]).toContain('#0002');
    expect(lines[row + 5]).toContain('pending');
  });

  it('prints a script task\'s derived summary and keeps its [SCR] tag', async () => {
    const out = await run([
      { type: 'status_update', tasks: [
        { id: 'task-0002', type: 'script', status: 'failed', verdict: null, handoff: { summary: 'exited 1 in 0.4 s', findings: [{ id: 'F1', severity: 'blocker', title: 'Script exited 1' }], findingCount: 1 } },
      ] },
      { type: 'execution_complete', summary: { total: 1, completed: 0, failed: 1, blocked: 0, skipped: 0 } },
    ]);

    const lines = out.split('\n');
    const row = lines.findIndex((l) => l.includes('#0002'));
    expect(lines[row]).toContain('[SCR]');
    expect(lines.slice(row + 1, row + 3)).toEqual([
      '      ↳ Handoff: exited 1 in 0.4 s',
      '      F1 [blocker] Script exited 1',
    ]);
  });
});
