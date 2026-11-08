import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { localRuns, readWorkspaces } from './change-scope.mjs';
import { benchStep, requiredTools, sandboxStep, toolOnHost, workflowSteps } from './ci.mjs';
import { platformKey } from './shellcheck.mjs';
import { execute, localChecks, runChecks } from './test-changed.mjs';

const plan = (...paths) => localRuns(paths, readWorkspaces());
const ciStep = (id) => workflowSteps().find((step) => step.id === id);

describe('the local CI proof', () => {
  it('runs the bench command CI uses for an installer change (#66 F5)', () => {
    for (const path of ['scripts/install/cli.sh', 'scripts/install/desktop.sh', 'bench/scale/ops.mjs', 'packages/core/src/services/Session.ts']) {
      const checks = localChecks(plan(path));
      assert.ok(checks.some((step) => step.id === 'bench' && !step.reason), path);
    }
  });

  it('lists display and network checks, containers and Windows as unverified', () => {
    const checks = localChecks(plan('packages/core/src/index.ts'));
    for (const id of ['vscode-integration', 'desktop-e2e', 'package-desktop', 'verify-artifacts', 'real-engine', 'windows', 'windows-harness']) {
      assert.ok(checks.some((step) => step.id === id && step.reason), id);
    }
    assert.match(localChecks(plan('packages/desktop/src/main/index.ts')).find((step) => step.id === 'desktop-tour').reason, /display/);
  });

  it('fails on a failed owed check and still prints what remains unverified', async () => {
    const messages = [];
    const visited = [];
    const status = await runChecks([
      { id: 'bench', name: 'Bench harness tests (offline, against the built core)' },
      { id: 'vscode-integration', name: 'VS Code integration', reason: 'needs a display' },
      { id: 'lint', name: 'Lint' },
    ], {}, async (step) => { visited.push(step.id); return 1; }, (message) => messages.push(message));
    assert.equal(status, 1);
    assert.deepEqual(visited, ['bench']);
    assert.match(messages.join('\n'), /UNVERIFIED[\s\S]*vscode-integration[\s\S]*needs a display/);
    assert.match(messages.join('\n'), /lint.*earlier check failed/);
  });

  it('owes the sandbox regressions (#66 F4) and reports a host that cannot run bubblewrap', () => {
    for (const path of [
      'packages/core/src/services/sandbox/__tests__/sealedRuns.e2e.test.ts',
      'packages/core/src/services/sandbox/plannerSandbox.ts',
      'packages/core/src/services/__tests__/PatchCapture.e2e.test.ts',
      'scripts/linux-sandbox-e2e.sh',
    ]) {
      const checks = localChecks(plan(path), undefined, { platform: 'linux', sandbox: 'bubblewrap cannot start' });
      assert.equal(checks.find((step) => step.id === 'sandbox')?.reason, 'bubblewrap cannot start', path);
    }
  });

  it('runs a ready Linux sandbox, and reports Linux sandbox and standalone binary limits on Windows', () => {
    const selected = plan('packages/core/src/index.ts');
    const linux = localChecks(selected, undefined, { platform: 'linux', sandbox: undefined });
    assert.equal(linux.find((step) => step.id === 'sandbox').reason, undefined);
    const windows = localChecks(selected, undefined, { platform: 'win32' });
    for (const id of ['sandbox', 'build-binary', 'drive-binary']) {
      assert.ok(windows.find((step) => step.id === id).reason, id);
    }
  });

  it('refuses a newly owed step with no local implementation or explicit reason', () => {
    const selected = plan('docs/a.md');
    selected.steps = [{ job: 'build-and-test', id: 'new-proof' }];
    assert.throws(() => localChecks(selected, [{ job: 'build-and-test', id: 'new-proof', name: 'A new proof' }]), /new-proof.*local/);
  });

  it('refuses an owed step missing from the workflow', () => {
    assert.throws(() => localChecks(plan('docs/a.md'), []), /build-core.*missing/);
  });

  it('runs every verify script and guards for AUTHORS drift and even prose-only changes (#66 F6)', () => {
    for (const path of ['AUTHORS.md', 'packages/core/AUTHORS.md', 'packages/cli/AUTHORS.md', 'packages/web/AUTHORS.md', 'packages/cli-alias/AUTHORS.md', 'packages/vscode/AUTHORS.md', 'docs/a.md']) {
      const checks = localChecks(plan(path));
      assert.ok(checks.some((step) => step.id === 'verify-scripts' && !step.reason), path);
      assert.ok(checks.some((step) => step.id === 'repo-guards' && !step.reason), path);
    }
  });

  it('runs the offline planner when its driver or mock changes and omits checks not owed', () => {
    for (const path of ['bench/live/mock-provider.mjs', 'bench/live/drive-conversation.mjs', 'bench/live/drive-taskops.mjs']) {
      assert.ok(localChecks(plan(path)).some((step) => step.id === 'planner-loop' && !step.reason), path);
    }
    const docs = localChecks(plan('docs/a.md'));
    assert.deepEqual(docs.map((step) => step.id), ['build-core', 'verify-scripts', 'repo-guards', 'build-rest']);
    assert.deepEqual(localChecks(plan()), []);
  });

  it('uses whole full suites for coverage floors, quick dependents and no duplicate coverage merge', () => {
    const selected = plan('packages/web/server/main.ts');
    assert.deepEqual(selected.runs, [
      { dir: 'packages/cli', script: 'test:quick' },
      { dir: 'packages/web', script: 'test:coverage' },
      { dir: 'packages/desktop', script: 'test:quick' },
    ]);
    assert.equal(localChecks(selected).filter((step) => step.id === 'coverage').length, 1);
    assert.ok(!localChecks(plan('packages/core/src/index.ts')).some((step) => step.id === 'merge-coverage'));
  });

  it('fails when a workspace lacks the suite CI owes, instead of silently skipping it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-local-proof-'));
    try {
      mkdirSync(join(root, 'leaf'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['leaf'] }));
      writeFileSync(join(root, 'leaf', 'package.json'), JSON.stringify({ name: 'leaf', version: '1.0.0' }));
      const module = new URL('./ci.mjs', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { testWithCoverage } from ${JSON.stringify(module)}; process.exitCode = testWithCoverage([{ dir: 'leaf', script: 'test:coverage' }]);`], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Missing script: "test:coverage"/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fetches the pinned shellcheck before the bench tests, which require it (#71 F1)', () => {
    const calls = [];
    const fetch = () => { calls.push('fetch'); return 0; };
    const run = (args, env) => { calls.push(['run', args, env]); return 0; };
    assert.equal(benchStep(ciStep('bench'), { fetch, run, has: () => true }), 0);
    if (platformKey()) {
      assert.equal(calls[0], 'fetch');
      assert.equal(benchStep(ciStep('bench'), { fetch: () => 1, run, has: () => true }), 1);
      assert.equal(calls.length, 2, 'a failed fetch runs no bench tests');
    }
    const [, args, env] = calls.at(-1);
    assert.deepEqual(args, ['run', 'test:bench']);
    assert.match(env.ORDEWELL_REQUIRE_TOOLS, /\bshellcheck\b/);
  });

  it('requires what CI requires and the host has, and names what it lacks as unverified (#71 F2, F3, F5)', () => {
    assert.deepEqual(requiredTools(ciStep('bench')).sort(), ['dash', 'pwsh', 'ruby', 'shasum', 'shellcheck', 'tar']);
    assert.deepEqual(requiredTools(ciStep('sandbox')).sort(), ['rg', 'zsh']);
    const run = (args, env) => env.ORDEWELL_REQUIRE_TOOLS;
    assert.doesNotMatch(benchStep(ciStep('bench'), { fetch: () => 0, run, has: (tool) => tool !== 'pwsh' }), /pwsh/);

    const lacking = { platform: 'linux', sandbox: undefined, has: (tool) => !['pwsh', 'rg'].includes(tool) };
    const checks = localChecks(plan('scripts/install/desktop.ps1', 'packages/core/src/services/sandbox/plannerSandbox.ts'), undefined, lacking);
    assert.match(checks.find((step) => step.id === 'bench-tools')?.name ?? '', /pwsh/);
    assert.match(checks.find((step) => step.id === 'sandbox-tools')?.name ?? '', /\brg\b/);
    for (const id of ['bench-tools', 'sandbox-tools']) assert.ok(checks.find((step) => step.id === id).reason, id);
    const equipped = localChecks(plan('scripts/install/desktop.ps1'), undefined, { platform: 'linux', sandbox: undefined, has: () => true });
    assert.ok(!equipped.some((step) => step.id.endsWith('-tools')));
  });

  it("runs CI's sandbox script with its setup off, and names that setup when the script changed (#71 F4)", () => {
    let call;
    const status = execute(ciStep('sandbox'), plan('scripts/linux-sandbox-e2e.sh'), (...args) => { call = args; return 0; });
    assert.equal(status, 0);
    assert.equal(call[0], 'bash');
    assert.deepEqual(call[1], ['scripts/linux-sandbox-e2e.sh', '--maxWorkers=2', '--minWorkers=1']);
    assert.equal(call[2].ORDEWELL_SANDBOX_SETUP, 'none');

    const ready = { platform: 'linux', sandbox: undefined, has: () => true };
    assert.ok(localChecks(plan('scripts/linux-sandbox-e2e.sh'), undefined, ready).find((step) => step.id === 'sandbox-setup')?.reason);
    assert.ok(!localChecks(plan('packages/core/src/services/sandbox/plannerSandbox.ts'), undefined, ready).some((step) => step.id === 'sandbox-setup'));
  });

  it("hands CI's sandbox script the tools CI requires and the host has, as the inner loop does (#72 F2)", () => {
    let call;
    const run = (...args) => { call = args; return 0; };
    assert.equal(sandboxStep(ciStep('sandbox'), { ready: () => true, run, has: (tool) => tool !== 'zsh' }), 0);
    assert.deepEqual(call.slice(0, 2), ['bash', ['scripts/linux-sandbox-e2e.sh']]);
    assert.equal(call[2].ORDEWELL_REQUIRE_TOOLS, 'rg');
    call = undefined;
    assert.equal(sandboxStep(ciStep('sandbox'), { ready: () => false, run, has: () => true }), 0);
    assert.equal(call, undefined, 'a host that cannot run the sandbox skips it');
  });

  it('counts zsh present only where a sealed run starts it, not anywhere on PATH (#72 F3)', () => {
    const everywhereOnPath = { path: () => true };
    assert.equal(toolOnHost({ ...everywhereOnPath, exists: () => false })('zsh'), false);
    assert.equal(toolOnHost({ ...everywhereOnPath, exists: (p) => p === '/usr/bin/zsh' })('zsh'), true);
    assert.equal(toolOnHost({ ...everywhereOnPath, exists: (p) => p === '/bin/zsh' })('zsh'), true);
    assert.equal(toolOnHost({ path: () => false, exists: () => true })('zsh'), true);
    assert.equal(toolOnHost({ path: (tool) => tool === 'rg', exists: () => false })('rg'), true);
  });

  it('installs and requires the tools the sandbox tests would otherwise skip without in CI (#71 F3)', () => {
    const steps = workflowSteps();
    const install = steps.find((step) => /Install bubblewrap/.test(step.name));
    assert.match(install.run, /missing\+=\(ripgrep\)/);
    assert.match(install.run, /missing\+=\(zsh\)/);
  });
});
