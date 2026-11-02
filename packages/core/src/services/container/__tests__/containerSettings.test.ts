import { describe, expect, it } from 'vitest';
import { parseContainerSettings } from '../containerSettings';

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
