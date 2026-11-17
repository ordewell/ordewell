import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupervisorLevel } from '../../models/Execution';
import type { SessionMessage } from '../SessionMessage';
import { ctx, NOW, prose, settled, supervised, task, until, type Env } from './supervisorTestKit';

/**
 * `run_concluded` (ADR-0029): the run's end as a follower that cannot answer
 * it reads it. `execution_complete` says the run ended; at Act the
 * supervisor's closing turn may continue it, so the end stands only once that
 * turn is over.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const ends = (env: Env) => env.messages.filter((m) => m.type === 'execution_complete' || m.type === 'run_concluded').map((m) => m.type);
const concluded = (env: Env) => env.messages.filter((m): m is Extract<SessionMessage, { type: 'run_concluded' }> => m.type === 'run_concluded');

async function failedRun(level: SupervisorLevel): Promise<Env> {
  const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: level } });
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.messages.some((m) => m.type === 'execution_complete'));
  return env;
}

describe('a run concluded at Act', () => {
  it('waits for the closing turn, and follows the run it continued to its next end', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);
    expect(ends(env)).toEqual(['execution_complete']);

    expect((await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    await settled();
    expect(ends(env)).toEqual(['execution_complete']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Task 1 passed; the run is done.'));
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'execution_complete', 'run_concluded']);
    expect(concluded(env)[0].summary).toMatchObject({ total: 1, completed: 1, failed: 0, blocked: 0 });
  });

  it('concludes after a closing turn that changed nothing, with the failure standing', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);

    env.planner.calls[0].finish(prose('Task 1 needs you: the import is wrong.'));
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].summary).toMatchObject({ total: 1, completed: 0, failed: 1 });
  });
});

describe.each(['watch', 'off'] as const)('a run concluded at %s', (level) => {
  it('concludes as the run ends: no turn may continue it', async () => {
    const env = await failedRun(level);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });
});
