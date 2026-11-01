import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { containerExecution } from '../dockerLease';
import { delegated, DONE, removeRepos, SUBMIT, childTask, tree, writingRunner } from '../../__tests__/delegationTestKit';
import type { ExecutionBackend, LeaseRequest } from '../../executionLease';

/*
 * The setting is session-wide (ADR-0059 L5): a root reads it once, and a child
 * opened later takes what that decided. The settings readers are live, so a child
 * that read it again after a change would run its tasks on this host, or a root
 * on it would hold a child in a container nobody asked for.
 */

vi.mock('../dockerLease', async (actual) => {
  const real = await actual<typeof import('../dockerLease')>();
  return { ...real, containerExecution: vi.fn() };
});

const CONTAINERS = { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } };

describe('a child opened after the containers setting changed', () => {
  const inContainer: string[] = [];

  /** Stands for a Docker backend: a task of its Session is refused, as one with no engine here would be, and never reaches a runner. */
  const boxing = (local: ExecutionBackend): ExecutionBackend => ({
    probe: () => local.probe(),
    refusal: (request) => local.refusal(request),
    letGo: (taskId, how) => local.letGo(taskId, how),
    list: () => local.list(),
    reserve: (request: LeaseRequest) => {
      const reserved = local.reserve(request);
      if ('refused' in reserved) return reserved;
      const { lease } = reserved;
      return {
        lease: {
          id: lease.id,
          holdsSlot: lease.holdsSlot,
          release: (reason) => lease.release(reason),
          open: (spec, signal) => {
            if (request.role !== 'task') return lease.open(spec, signal);
            inContainer.push(request.node.taskId ?? '');
            return Promise.reject(new Error('This session runs tasks in containers.'));
          },
        },
      };
    },
  });

  beforeEach(() => {
    inContainer.length = 0;
    vi.mocked(containerExecution).mockReset();
    vi.mocked(containerExecution).mockReturnValue(boxing);
  });
  afterEach(() => removeRepos());

  const parts = (settings: Record<string, unknown>) => {
    const runner = writingRunner({ a: ['a.txt'] });
    return { runner, made: tree([SUBMIT([childTask('a', 1)]), DONE], { runner, settings, tasks: [delegated()] }) };
  };

  it('keeps it in a container, though the setting has gone: it never drops to this host', async () => {
    const settings: Record<string, unknown> = { containers: CONTAINERS };
    const { runner, made } = parts(settings);
    delete settings.containers;

    await made.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(inContainer).toContain('a'));
    expect(runner.spawned).toEqual([]);
    expect(containerExecution).toHaveBeenCalledTimes(1);
    made.parent.destroy();
    await made.parent.gone;
  });

  it('leaves it where its root runs, though the setting has come: a tree has one answer', async () => {
    const settings: Record<string, unknown> = {};
    const { runner, made } = parts(settings);
    settings.containers = CONTAINERS;

    await made.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    expect(containerExecution).not.toHaveBeenCalled();
    made.parent.destroy();
    await made.parent.gone;
  });
});
