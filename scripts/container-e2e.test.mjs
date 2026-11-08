import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseImages, pullMissing } from './container-e2e.mjs';

describe('baseImages', () => {
  it('names the image a one-stage Dockerfile builds on', () => {
    assert.deepEqual(baseImages('# syntax note\nFROM node:22-slim\nRUN echo hi\n'), ['node:22-slim']);
  });

  it('leaves out scratch, its own stages, an ARG-named image and repeats', () => {
    const dockerfile = [
      'ARG BASE=node:22',
      'FROM --platform=linux/amd64 node:22-slim AS Build',
      'from alpine:3.20 as tools',
      'FROM build',
      'FROM ${BASE}',
      'FROM scratch',
      '  FROM node:22-slim',
      'COPY --from=tools /x /x',
    ].join('\n');
    assert.deepEqual(baseImages(dockerfile), ['node:22-slim', 'alpine:3.20']);
  });
});

/** A docker that answers each command from `answers`, in order, and records what it was asked. */
function fakeDocker(answers) {
  const asked = [];
  return {
    asked,
    run: (args) => {
      asked.push(args.join(' '));
      const answer = answers[args[0] === 'image' ? 'inspect' : 'pull'];
      return answer.length ? answer.shift() : 1;
    },
  };
}

describe('pullMissing', () => {
  const quiet = { log: () => {} };

  it('pulls nothing the engine already holds', async () => {
    const docker = fakeDocker({ inspect: [0], pull: [] });
    assert.equal(await pullMissing(['node:22-slim'], { ...quiet, run: docker.run, sleep: async () => {} }), undefined);
    assert.deepEqual(docker.asked, ['image inspect --format {{.Id}} node:22-slim']);
  });

  it('tries a missed pull again after a longer wait each time', async () => {
    const docker = fakeDocker({ inspect: [1], pull: [1, 1, 0] });
    const waits = [];
    assert.equal(await pullMissing(['node:22-slim'], { ...quiet, run: docker.run, sleep: async (ms) => { waits.push(ms); } }), undefined);
    assert.equal(docker.asked.filter((ask) => ask.startsWith('pull')).length, 3);
    assert.deepEqual(waits, [15_000, 30_000]);
  });

  it('names the image that never came, and asks for none after it', async () => {
    const docker = fakeDocker({ inspect: [1, 1], pull: [1, 1, 1, 1, 0] });
    const waits = [];
    const missing = await pullMissing(['node:22-slim', 'alpine:3.20'], { ...quiet, run: docker.run, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(missing, 'node:22-slim');
    assert.equal(docker.asked.filter((ask) => ask === 'pull node:22-slim').length, 4);
    assert.ok(!docker.asked.some((ask) => ask.includes('alpine')));
    assert.deepEqual(waits, [15_000, 30_000, 45_000]);
  });
});
