import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { containerStatus, type ContainerChange, type ContainerChangeResponse, type ContainerProblem, type ContainerStatus } from '@ordewell/core';
import type { ApiClient } from '../../apiClient';
import { handleContainers } from '../containers';

const NOT_READY: ContainerStatus = { on: true, ready: false, problems: [{ code: 'image-unset', message: 'No image has been chosen.', remedy: 'Build one.' }], assumptions: ['Containers on an engine share one kernel.'] };
const READY: ContainerStatus = { on: true, ready: true, image: 'ordewell-task', login: 'your own sign-in', problems: [], assumptions: [] };

function daemon(status: ContainerStatus, refused: ContainerProblem[] = []) {
  const changes: ContainerChange[] = [];
  const proved: boolean[] = [];
  const api = {
    getContainers: async (prove = false) => { proved.push(prove); return status; },
    changeContainers: async (change: ContainerChange): Promise<ContainerChangeResponse> => { changes.push(change); return { refused, status }; },
  } as unknown as ApiClient;
  return { api, changes, proved };
}

describe('ordewell containers', () => {
  let out: string[];
  let err: string[];
  let exits: Array<number | undefined>;

  beforeEach(() => {
    out = [];
    err = [];
    exits = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
    vi.spyOn(console, 'error').mockImplementation((line: string) => { err.push(line); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); throw new Error('exit'); }) as typeof process.exit);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('shows where the setting stands, and starts no container for it', async () => {
    const { api, proved } = daemon(NOT_READY);

    await handleContainers([], api);

    expect(proved).toEqual([false]);
    expect(out.join('\n')).toContain('No image has been chosen. Build one.');
    expect(out.join('\n')).toContain('share one kernel');
  });

  it('asks for a proof by `check`, and exits non-zero where a task could not start', async () => {
    const { api, proved } = daemon(NOT_READY);

    await expect(handleContainers(['check'], api)).rejects.toThrow('exit');

    expect(proved).toEqual([true]);
    expect(exits).toEqual([1]);
  });

  it('exits clean from a check that passes', async () => {
    await handleContainers(['check'], daemon(READY).api);

    expect(exits).toEqual([]);
  });

  it.each<[string[], ContainerChange]>([
    [['on'], { on: true }],
    [['off'], { on: false }],
    [['image', 'ordewell-task'], { image: 'ordewell-task' }],
    [['login', 'own-sign-in'], { login: { kind: 'own-sign-in' } }],
    [['login', 'broker', 'ANTHROPIC_API_KEY', 'AWS_REGION'], { login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'AWS_REGION'] } }],
  ])('sends %j as one change', async (words, change) => {
    const { api, changes } = daemon(READY);

    await handleContainers(words, api);

    expect(changes).toEqual([change]);
  });

  it('prints what stood in the way, exits non-zero, and does not read as having worked', async () => {
    const { api } = daemon({ ...READY, on: false, ready: false }, [{ code: 'docker-missing', message: 'The docker command was not found', remedy: 'Install Docker Engine.' }]);

    await expect(handleContainers(['on'], api)).rejects.toThrow('exit');

    expect(err.join('\n')).toBe('The docker command was not found. Install Docker Engine.');
    expect(out).toEqual([]);
    expect(exits).toEqual([1]);
  });

  it.each([[['image']], [['image', 'a', 'b']], [['login', 'broker']], [['login', 'own-sign-in', 'X']], [['login', 'host']], [['on', 'now']], [['sideways']]])('sends nothing for %j, and shows the usage', async (words) => {
    const { api, changes } = daemon(READY);

    await expect(handleContainers(words, api)).rejects.toThrow('exit');

    expect(changes).toEqual([]);
    expect(err.join('\n')).toContain('Usage: ordewell containers');
  });

  // The two sides of the wire are compiled apart, so this holds the words to what core really builds.
  it('prints the text every surface prints', async () => {
    const status = await containerStatus(undefined, { cli: { call: async () => ({ code: -1, stdout: '', stderr: '' }), entry: async () => { throw new Error('unused'); } }, platform: 'linux' });

    await handleContainers(['status'], daemon(status).api);

    expect(out[0]).toContain('Containers: off');
    expect(out.join('\n')).toContain('Install Docker Engine');
  });
});
