#!/usr/bin/env node
// ci.yml's hands on scripts/change-scope.mjs, which holds the decisions.
//   select   what this event needs, as job outputs
//   confirm  the job it runs in (JOB) ran what it owed
//   gate     the required status: every job did what the change owed it
//   coverage-merge    merge a sharded suite's coverage (WORKSPACE, SHARDS) and judge its floors
//   coverage-summary  each workspace's coverage summary in coverage.log, for the job summary
//   windows-tests  this windows shard's part of every suite the scope owes Windows
// and the setup action's (.github/actions/setup/action.yml):
//   setup-plan          what this call installs and builds, and each cache's key
//   setup-build         build what the plan names and no cache restored
//   electron-checksums  seed electron's checksums where electron-builder looks
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blobProblems, CHECKS, coverageLegs, coverageMerges, coverageSummaries, electronCacheDir, gateFailures, missedSteps, parseScope, readWorkspaces, scopeForEvent, setupPlan, shasumsText, windowsRuns } from './change-scope.mjs';
import { packFiles, parseShard, suiteFiles } from './windows-shards.mjs';
import { npm } from './npm.mjs';

const {
  BUILD, ELECTRON, ELECTRON_BUILDER, EVENT, GITHUB_ENV, GITHUB_OUTPUT, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_STEP_SUMMARY,
  JOB, NEEDS, ORDEWELL_SETUP_BUILT, ORDEWELL_SETUP_INSTALLED, REUSE_MAIN_PROOF, SCOPE, SHARD, SHARDS, STEPS, WORKSPACE,
} = process.env;

// ci.yml's workflow_call input, which only release.yml sets; every other event leaves it empty.
const reuseMainProof = REUSE_MAIN_PROOF === 'true';

/** gh's own list of successful push runs of ci.yml on main at `sha`; change-scope.mjs checks every field. */
function findMainRuns(sha) {
  try {
    return execFileSync('gh', [
      'run', 'list', '--repo', GITHUB_REPOSITORY ?? '', '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push',
      '--commit', sha, '--status', 'success', '--json', 'databaseId,url,headSha,event,headBranch,conclusion',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim() || error.message);
  }
}

function report(problems, passed) {
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log(passed);
}

const output = (lines) => appendFileSync(GITHUB_OUTPUT, lines.map((line) => `${line}\n`).join(''));

/** A value of several lines, as GITHUB_OUTPUT takes one, behind a delimiter no path holds. */
function multiline(name, values) {
  const end = `END_${randomBytes(8).toString('hex')}`;
  return [`${name}<<${end}`, ...values, end];
}

const words = (text) => (text ?? '').split(/\s+/).filter(Boolean);

const commands = {
  select() {
    const scope = scopeForEvent(EVENT, '.', readWorkspaces(), { reuseMainProof, sha: GITHUB_SHA, findMainRuns });
    console.log(`${scope.mode}: ${scope.reason}`);
    output([
      `scope=${JSON.stringify(scope)}`,
      // build-and-test runs unless this names the run that proved the commit.
      `proof=${scope.proof?.url ?? ''}`,
      ...CHECKS.map((check) => `${check}=${scope.checks[check]}`),
      // The coverage job's matrix: one leg per workspace the scope reaches, or per shard of one.
      `coverage=${JSON.stringify(coverageLegs(scope))}`,
      // coverage-merge's: one leg per sharded workspace.
      `merges=${JSON.stringify(coverageMerges(scope))}`,
    ]);
    const off = CHECKS.filter((check) => !scope.checks[check]);
    if (GITHUB_STEP_SUMMARY) {
      const reused = scope.proof ? `\n\nReused: [main's CI run](${scope.proof.url}) proved \`${scope.proof.sha}\`; nothing ran again.` : '';
      appendFileSync(GITHUB_STEP_SUMMARY, `**${scope.mode}**: ${scope.reason}\n\nLeft out: ${off.join(', ') || 'nothing'}${reused}\n`);
    }
  },
  confirm() {
    // No default job: a confirm step that names none would prove build-and-test's steps in another job.
    report(missedSteps(parseScope(SCOPE), JSON.parse(STEPS), JOB ?? ''), `Every step this change owed ${JOB} ran and passed.`);
    output(['confirmed=true']);
  },
  gate() {
    report(gateFailures(EVENT, JSON.parse(NEEDS), { reuseMainProof }), 'Every job did what this change owed it.');
  },
  'coverage-merge'() {
    // The matrix's fallback, when the scope job gave no scope, names no
    // workspace: the coverage job's own fallback then ran every suite whole,
    // under its floors, and left no shard to merge.
    if (!WORKSPACE) {
      console.log('No scope, so the coverage job ran every suite whole and judged its floors there: nothing to merge.');
      return;
    }
    const reports = join(WORKSPACE, '.vitest-reports');
    report(blobProblems(existsSync(reports) ? readdirSync(reports) : [], Number(SHARDS)), `Every one of ${WORKSPACE}'s ${SHARDS} shards left its blob.`);
    // The merge fails on any shard's failed test and on any floor its merged coverage breaches.
    const status = npm(['run', 'test:coverage:merge', '-w', WORKSPACE]);
    report(status === 0 ? [] : [`${WORKSPACE}'s shards failed a test or a coverage floor, merged`], `${WORKSPACE}'s shards passed, merged, and met every floor.`);
  },
  'coverage-summary'() {
    if (existsSync('coverage.log')) appendFileSync(GITHUB_STEP_SUMMARY, coverageSummaries(readFileSync('coverage.log', 'utf8')));
  },
  async 'windows-tests'() {
    const { index, count } = parseShard(SHARD);
    const suites = await suiteFiles(windowsRuns(parseScope(SCOPE ?? '')));
    const shards = packFiles(suites.flatMap(({ files }) => files), count);
    const assigned = new Set(shards[index - 1].files);
    console.log(`Shard ${SHARD}: ${assigned.size} files, ${Math.round(shards[index - 1].milliseconds / 1000)}s recorded file time (before worker parallelism)`);
    const scratch = mkdtempSync(join(tmpdir(), 'ordewell-windows-'));
    const assignment = join(scratch, 'files.json');
    const config = join(scratch, 'vitest.config.mjs');
    const failed = [];
    try {
      // Every owed suite runs even after another fails, so a red run names them all.
      for (const { dir, script, files, config: originalConfig } of suites) {
        const selected = files.filter((file) => assigned.has(file));
        if (!selected.length) continue;
        // Keep longest-first order within each suite as well as between shards.
        writeFileSync(assignment, JSON.stringify(shards[index - 1].files.filter((file) => selected.includes(file)).map((file) => resolve(...file.split('/')))));
        // Vitest 2 accepts a sequencer constructor in config, not a CLI path.
        // Import the suite's own config so plugins, setup and limits stay intact.
        writeFileSync(config, [
          `import { mergeConfig } from ${JSON.stringify(fileURLToPath(import.meta.resolve('vitest/config')))};`,
          originalConfig ? `import original from ${JSON.stringify(originalConfig)};` : 'const original = {};',
          `import sequencer from ${JSON.stringify(fileURLToPath(new URL('./windows-sequencer.mjs', import.meta.url)))};`,
          'export default async (env) => mergeConfig(await (typeof original === "function" ? original(env) : original), { test: { sequence: { sequencer } } });',
        ].join('\n'));
        console.log(`::group::${script} in ${dir} (shard ${SHARD}, ${selected.length} files)`);
        const status = npm(['run', script, '-w', dir, '--', `--shard=${SHARD}`, `--config=${config}`, `--root=${resolve(dir)}`, '--maxWorkers=2', '--minWorkers=1'], { ORDEWELL_WINDOWS_FILES: assignment });
        console.log('::endgroup::');
        if (status !== 0) failed.push(`${script} failed in ${dir}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    report(failed, `Every suite this change owed Windows passed on shard ${SHARD}.`);
  },
  'setup-plan'() {
    // A second call in the same job finds what the first did in these, and leaves it be.
    const plan = setupPlan({
      build: BUILD ?? '',
      installed: ORDEWELL_SETUP_INSTALLED === 'true',
      built: words(ORDEWELL_SETUP_BUILT),
      electron: ELECTRON === 'true',
      electronBuilder: ELECTRON_BUILDER === 'true',
    });
    const planned = new Map(plan.builds.map((build) => [build.name, build]));
    console.log(plan.install ? `Install: ${plan.modulesKey || 'npm ci, no node_modules cache on this OS'}` : 'Install: done earlier in this job');
    for (const { name, key } of plan.builds) console.log(`Build ${name}: ${key}`);
    output([
      `install=${plan.install}`,
      `modules-key=${plan.modulesKey}`,
      `build=${plan.builds.map(({ name }) => name).join(' ')}`,
      // Every workspace gets both outputs, so a step that names one never reads a missing output.
      ...readWorkspaces().flatMap(({ dir }) => {
        const name = dir.split('/').at(-1);
        return [`${name}-key=${planned.get(name)?.key ?? ''}`, ...multiline(`${name}-paths`, planned.get(name)?.paths ?? [])];
      }),
      `electron-key=${plan.electron?.key ?? ''}`,
      `electron-path=${plan.electron?.path ?? ''}`,
      `builder-key=${plan.electronBuilder?.key ?? ''}`,
      ...multiline('builder-paths', plan.electronBuilder?.paths ?? []),
    ]);
  },
  'setup-build'() {
    const steps = JSON.parse(STEPS ?? '{}');
    const dirs = new Map(readWorkspaces().map(({ dir }) => [dir.split('/').at(-1), dir]));
    const restored = [];
    const built = [];
    // The plan lists dependencies first, so each build finds the dist/ it compiles against.
    for (const name of words(BUILD)) {
      if (steps[`restore-${name}`]?.outputs?.['cache-hit'] === 'true') {
        console.log(`${name}: restored from the build cache`);
        restored.push(name);
        continue;
      }
      console.log(`::group::Build ${name}`);
      const status = npm(['run', 'build', '-w', dirs.get(name)]);
      console.log('::endgroup::');
      report(status === 0 ? [] : [`the ${name} build failed`], `${name}: built`);
      built.push(name);
    }
    appendFileSync(GITHUB_ENV, `ORDEWELL_SETUP_INSTALLED=true\nORDEWELL_SETUP_BUILT=${[...words(ORDEWELL_SETUP_BUILT), ...restored, ...built].join(' ')}\n`);
    output([`restored=${restored.join(' ')}`, `built=${built.join(' ')}`]);
  },
  'electron-checksums'() {
    const { version } = JSON.parse(readFileSync(join('node_modules', 'electron', 'package.json'), 'utf8'));
    const checksums = JSON.parse(readFileSync(join('node_modules', 'electron', 'checksums.json'), 'utf8'));
    const dir = electronCacheDir({ platform: process.platform, env: process.env, home: homedir() });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `SHASUMS256.txt-${version}`), shasumsText(checksums));
    console.log(`Seeded ${join(dir, `SHASUMS256.txt-${version}`)}, so packaging checks the Electron zip offline.`);
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: ci-scope.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
await command();
