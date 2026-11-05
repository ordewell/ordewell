import { describe, expect, it } from 'vitest';
import { envArgs, parseContainerSettings } from '../containerSettings';

const WELL_FORMED = { image: 'ordewell-task', memory: '2g', login: { kind: 'own-sign-in' } };

describe('parseContainerSettings', () => {
  it('reads an allowed host as the sidecar compares it: a capital would never match, and would look like a list that works', () => {
    const settings = parseContainerSettings({ ...WELL_FORMED, allow: ['Registry.NPMjs.org', '*.Example.com'] });

    expect(settings).toMatchObject({ allow: ['registry.npmjs.org', '*.example.com'] });
  });

  it.each(['0g', '0'])('refuses a memory limit of %s, which no task could start under', (memory) => {
    expect(parseContainerSettings({ ...WELL_FORMED, memory })).toEqual({ refused: expect.stringContaining('containers.memory') });
  });

  it.each(['  ', 'two words', '--privileged', '-v'])('refuses %j as an image: it sits in a docker command, where a dash makes it an option', (image) => {
    expect(parseContainerSettings({ ...WELL_FORMED, image })).toEqual({ refused: expect.stringContaining('containers.image') });
  });

  it.each(['ordewell-task', 'ordewell-task:1.2', 'ghcr.io/me/task:Latest', 'task@sha256:abc123'])('takes %s as an image', (image) => {
    expect(parseContainerSettings({ ...WELL_FORMED, image })).toMatchObject({ image });
  });
});

/** `ps` shows a command line to every user of the host, and the docker CLI reads `-e NAME`'s value from its own environment (ADR-0022 A5). */
describe('envArgs', () => {
  it('puts each variable on the command line by name, and its value in the CLI\'s environment', () => {
    expect(envArgs({ ANTHROPIC_API_KEY: 'sk-secret', ORDEWELL_PROBE: '{"a":1}' })).toEqual({
      args: ['-e', 'ANTHROPIC_API_KEY', '-e', 'ORDEWELL_PROBE'],
      env: { ANTHROPIC_API_KEY: 'sk-secret', ORDEWELL_PROBE: '{"a":1}' },
    });
  });

  it('gives HOME by value, as the CLI finds its own config by the HOME it holds, and only the task\'s home', () => {
    expect(envArgs({ HOME: '/task/home' })).toEqual({ args: ['-e', 'HOME=/task/home'], env: {} });
    expect(() => envArgs({ HOME: '/Users/someone' })).toThrow(/HOME/);
  });

  it('refuses a variable the CLI reads for itself, which would steer the CLI rather than reach the container', () => {
    for (const variable of ['PATH', 'PWD', 'DOCKER_HOST', 'DOCKER_CONFIG']) expect(() => envArgs({ [variable]: 'x' })).toThrow(variable);
  });
});
