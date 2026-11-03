import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNNERS, SCENARIOS, makeLab, installOnly, writeShim, removeShim, makeWorkspace, cleanLab } from './lab.mjs';

// The real probe against the real PATH machinery; needs core built first
// (`npm run build:core`), like bench/pipeline.
const here = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(here, '../../packages/core/dist/index.mjs')).href);

function installation() {
  return new core.RunnerInstallation(new core.RunnerRegistry());
}

/** Point the process at a fresh lab for one case and always restore it. */
async function inLab(fn) {
  const lab = makeLab();
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL };
  makeWorkspace(lab);
  Object.assign(process.env, { HOME: lab.home, PATH: lab.bin, SHELL: '/usr/bin/true' });
  core.clearAugmentedPathCache();
  try {
    await fn(lab);
  } finally {
    Object.assign(process.env, saved);
    core.clearAugmentedPathCache();
    cleanLab(lab);
  }
}

for (const [name, installed] of Object.entries(SCENARIOS)) {
  test(`scenario "${name}": the probe finds exactly ${installed.join(', ') || 'nothing'}`, async () => {
    await inLab(async (lab) => {
      installOnly(lab, installed);
      const found = await installation().filterInstalled(RUNNERS);
      assert.deepEqual(found, RUNNERS.filter((r) => installed.includes(r)));
    });
  });
}

test('an absent runner is greyed with a PATH reason a picker can show', async () => {
  await inLab(async (lab) => {
    installOnly(lab, []);
    const result = await installation().plannerUsability('claude-code');
    assert.equal(result.usable, false);
    assert.match(result.reason, /not installed|PATH/);
  });
});

test('a failing shim shadows a real CLI later on PATH', async () => {
  await inLab(async (lab) => {
    installOnly(lab, []);
    const real = join(lab.root, 'real');
    fs.mkdirSync(real, { recursive: true });
    writeShim({ ...lab, bin: real }, 'claude-code', { version: '9.9.9' });
    process.env.PATH = [lab.bin, real].join(delimiter);
    core.clearAugmentedPathCache();

    assert.deepEqual(await installation().filterInstalled(['claude-code']), [], 'the first shim must win');

    removeShim(lab, 'claude-code');
    assert.deepEqual(await installation().filterInstalled(['claude-code']), ['claude-code'], 'without the shim, the real CLI is found');
  });
});

test('a CLI installed while the host runs is seen after a refresh', async () => {
  await inLab(async (lab) => {
    installOnly(lab, []);
    const inst = installation();
    assert.deepEqual(await inst.filterInstalled(['claude-code']), []);

    writeShim(lab, 'claude-code', { version: '9.9.9' }); // the user installs it
    assert.deepEqual(await inst.filterInstalled(['claude-code']), [], 'the cached miss stands until a refresh');

    inst.refresh();
    assert.deepEqual(await inst.filterInstalled(['claude-code']), ['claude-code']);
  });
});
