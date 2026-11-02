import { describeContainers, describeProblems, type ContainerChange, type ContainerStatus } from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { connect, fail } from './shared';

const USAGE = 'Usage: ordewell containers [status|check|on|off|image <name>|login own-sign-in|login broker <VARIABLE>...]';

function changeOf([verb, ...rest]: string[]): ContainerChange | null {
  if (verb === 'on' || verb === 'off') return rest.length === 0 ? { on: verb === 'on' } : null;
  if (verb === 'image') return rest.length === 1 ? { image: rest[0] } : null;
  if (verb !== 'login') return null;
  const [kind, ...variables] = rest;
  if (kind === 'own-sign-in' && variables.length === 0) return { login: { kind } };
  return kind === 'broker' && variables.length > 0 ? { login: { kind, variables } } : null;
}

const show = (status: ContainerStatus): void => {
  for (const line of describeContainers(status)) console.log(line);
};

/**
 * Running tasks in containers (ADR-0059 L5). The daemon holds the Docker that
 * would run them, so all of it is asked there; only a checkout offers this.
 */
export async function handleContainers(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const words = positionals(subArgs);
  const [verb] = words;
  const check = verb === 'check';
  const change = verb === undefined || verb === 'status' || check ? null : changeOf(words);
  if (verb !== undefined && verb !== 'status' && !check && change === null) fail(USAGE);

  const api = await connect(subArgs, injectedApi);
  if (change) {
    const { refused, status } = await api.changeContainers(change);
    if (refused.length > 0) fail(describeProblems(refused));
    show(status);
    return;
  }
  if (check) console.log('Starting a throwaway container to measure it...');
  const status = await api.getContainers(check);
  show(status);
  if (check && !status.ready) process.exit(1);
}
