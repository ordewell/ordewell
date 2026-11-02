#!/usr/bin/env node
// Runs the container suites on whichever engine answers, with all three real
// harnesses in the image and a controlled model behind each, then says what that
// run proved. Exits 0 only when every test ran and passed: `bench/containers/verdict.mjs`
// holds the rule, and a skip or a missing engine is a non-zero "unverified".
//
//   npm run test:containers                       # builds the image first
//   npm run test:containers -- --image <name>     # an image holding all three
//   npm run test:containers -- --out report.json  # keep vitest's report
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEngine, describeVerdict, tally, verdict, withOpenCode } from '../bench/containers/verdict.mjs';

const CHECK_IMAGE = 'ordewell-e2e-harness:check';
const SUITE_FILES = ['dockerLease', 'codexContainer', 'containersSetting', 'pushGate'].map((suite) => `${suite}.e2e.test.ts`);

/** A harness counts as proven by these tests by name, so a rename reads as unproven rather than as a pass. */
const PROOFS = [
  { harness: 'claude-code', file: 'dockerLease.e2e.test.ts', test: /takes the real harness through a model turn by the gateway/ },
  { harness: 'claude-code', file: 'dockerLease.e2e.test.ts', test: /runs a whole task on the sign-in/ },
  { harness: 'codex', file: 'codexContainer.e2e.test.ts', test: /takes two real Codex tasks at once/ },
  { harness: 'opencode', file: 'dockerLease.e2e.test.ts', test: /runs a real OpenCode task in a container against a controlled model/ },
];

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

function finish(run) {
  const result = verdict({ proofs: PROOFS, suites: SUITE_FILES, ...run });
  const lines = describeVerdict(result);
  console.log(`\n${lines.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Real engine\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  }
  process.exit(result.exitCode);
}

function askEngine() {
  const info = spawnSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 30_000 });
  if (info.error) return { reason: `docker cannot be run: ${info.error.message}` };
  const facts = (() => { try { return JSON.parse(info.stdout); } catch { return undefined; } })();
  if (info.status !== 0 || !facts?.ServerVersion) {
    return { reason: `no engine answered: ${(facts?.ServerErrors?.[0] ?? info.stderr).trim()}` };
  }
  const context = spawnSync('docker', ['context', 'show'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const endpoint = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  return {
    engine: {
      kind: classifyEngine({ context, name: facts.Name, operatingSystem: facts.OperatingSystem, platform: process.platform, endpoint }),
      context,
      os: facts.OperatingSystem,
      arch: facts.Architecture,
      kernel: facts.KernelVersion,
      cgroup: facts.CgroupVersion,
      server: facts.ServerVersion,
    },
  };
}

function buildImage() {
  const dockerfile = withOpenCode(readFileSync('packages/core/docker/task.Dockerfile', 'utf8'));
  console.log(`Building ${CHECK_IMAGE} from task.Dockerfile, with OpenCode. The first build downloads all three harnesses.`);
  const built = spawnSync('docker', ['build', '-t', CHECK_IMAGE, '-'], { input: dockerfile, stdio: ['pipe', 'inherit', 'inherit'] });
  return built.status === 0;
}

const { engine, reason } = askEngine();
if (!engine) finish({ engine: null, counts: null, reason });

const image = option('--image') ?? CHECK_IMAGE;
if (!option('--image') && !buildImage()) {
  finish({ engine, counts: null, reason: `${CHECK_IMAGE} did not build, so no suite ran` });
}

const scratch = mkdtempSync(join(tmpdir(), 'ordewell-container-e2e-'));
const reportFile = join(scratch, 'report.json');

// A key or window from this shell would change what the suites prove: the model
// they talk to is the controlled one, and only by the settings they give it.
const env = { ...process.env, ORDEWELL_REQUIRE_DOCKER: '1', ORDEWELL_E2E_HARNESS_IMAGE: image, ORDEWELL_E2E_CODEX_IMAGE: image, ORDEWELL_E2E_OPENCODE_IMAGE: image };
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']) delete env[name];

const suitePaths = SUITE_FILES.map((suite) => `src/services/container/__tests__/${suite}`);
const { status: vitestStatus } = spawnSync('npx', ['vitest', 'run', ...suitePaths, '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], {
  cwd: 'packages/core', env, stdio: 'inherit',
});

let report;
try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
} catch (error) {
  finish({ engine, counts: null, reason: `the suites left no report, and vitest ended with status ${vitestStatus}: ${error.message}` });
}
const out = option('--out');
if (out) copyFileSync(reportFile, out);
rmSync(scratch, { recursive: true, force: true });

finish({ engine, counts: tally(report), vitestStatus });
