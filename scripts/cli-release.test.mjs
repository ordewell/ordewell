// The standalone CLI binary's place in ci.yml, cli-build.yml, release.yml and
// scripts/ci.mjs (ADR-0065). change-scope.test.mjs already holds every step id
// to the workflow's rules; this pins what is specific to building, signing and
// releasing the binary.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CLI_FIXED_ASSETS, FIXED_ASSETS, INSTALL_SCRIPT } from './desktop-release-assets.mjs';
import { STEPS_BY_CHECK } from './change-scope.mjs';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release.yml', 'utf8');
const cliBuild = readFileSync('.github/workflows/cli-build.yml', 'utf8');
const ciScript = readFileSync('scripts/ci.mjs', 'utf8');

/** The text of one top-level job. */
const job = (workflow, name) => {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.ok(start >= 0, `no job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/^  [\w-]+:$/m);
  return end < 0 ? rest : rest.slice(0, end);
};

/** The text of one step, from its name to the next step. */
const step = (text, name) => {
  const start = text.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `no step ${name}`);
  const rest = text.slice(start + 1);
  const end = rest.search(/^\s+- (?:name|uses):/m);
  return end < 0 ? rest : rest.slice(0, end);
};

const SIGNING_SECRETS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

/** A step's `run: |` script, dedented. */
const script = (stepText) => {
  const lines = stepText.slice(stepText.indexOf('run: |\n') + 'run: |\n'.length).split('\n');
  const indent = lines[0].match(/^ */)[0].length;
  return lines.filter((line) => line.trim() === '' || line.match(/^ */)[0].length >= indent).map((line) => line.slice(indent)).join('\n');
};

/**
 * The subset of GitHub's expression language cli-build.yml uses, with its
 * semantics: `&&` and `||` yield an operand, not a boolean; a missing property
 * is null; strings compare without case; operands of two types compare as
 * numbers. Enough to run the job's conditions for each kind of run.
 */
const evaluate = (source, context) => {
  const tokens = source.match(/'(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|,|[\w.-]+/g) ?? [];
  assert.equal(tokens.join(''), source.replace(/\s+/g, ''), `cannot read: ${source}`);
  let at = 0;
  const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || Number.isNaN(v));
  const number = (v) => (v === null || v === undefined ? 0 : v === true ? 1 : v === false ? 0 : Number(v));
  const equal = (a, b) => {
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if ((a ?? null) === null && (b ?? null) === null) return true;
    return typeof a === typeof b ? a === b : number(a) === number(b);
  };
  const functions = {
    startsWith: (text, prefix) => String(text ?? '').toLowerCase().startsWith(String(prefix ?? '').toLowerCase()),
    always: () => true,
    success: () => true,
  };
  const take = (expected) => {
    const token = tokens[at++];
    if (expected !== undefined) assert.equal(token, expected, `in ${source}`);
    return token;
  };
  const primary = () => {
    const token = take();
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token === '!') return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    if (/^\d/.test(token)) return Number(token);
    if (tokens[at] === '(') {
      take('(');
      const args = [];
      while (tokens[at] !== ')') {
        args.push(or());
        if (tokens[at] === ',') take(',');
      }
      take(')');
      assert.ok(functions[token], `no function ${token}`);
      return functions[token](...args);
    }
    return token.split('.').reduce((value, key) => (value === null || value === undefined ? null : (value[key] ?? null)), context);
  };
  const comparison = () => {
    let value = primary();
    while (tokens[at] === '==' || tokens[at] === '!=') {
      const negate = take() === '!=';
      value = equal(value, primary()) !== negate;
    }
    return value;
  };
  const and = () => {
    let value = comparison();
    while (tokens[at] === '&&') {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[at] === '||') {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  assert.equal(at, tokens.length, `trailing tokens in ${source}`);
  return value;
};

/** `${{ expr }}` as GitHub writes it into a string. */
const interpolate = (text, context) =>
  text.replace(/\$\{\{ (.+?) \}\}/g, (_, expr) => {
    const value = evaluate(expr, context);
    return value === null || value === undefined ? '' : String(value);
  });

describe('the binary check in ci.yml', () => {
  it('builds and drives the linux-x64 binary after the planner loop has let the mock port go', () => {
    assert.deepEqual(STEPS_BY_CHECK.binary, ['build-binary', 'drive-binary']);
    assert.match(ci, /- name: Build the standalone CLI binary\n\s+id: build-binary\n\s+if: needs\.scope\.outputs\.binary != 'false'\n\s+run: node scripts\/sea\/build\.mjs\n/);
    const drive = step(ci, 'CLI binary — offline e2e, no Node on PATH');
    assert.match(drive, /id: drive-binary/);
    assert.match(drive, /dist-sea\/linux-x64\/ordewell --version/);
    assert.match(drive, /node bench\/live\/drive-binary\.mjs --bin dist-sea\/linux-x64\/ordewell/);
    const at = ['id: build-core', 'id: planner-loop', 'id: build-binary', 'id: drive-binary'].map((id) => ci.indexOf(id));
    assert.deepEqual([...at].sort((a, b) => a - b), at);
  });

  it('is run by scripts/ci.mjs on this host, and skipped on Windows with the reason', () => {
    assert.match(ciScript, /'Build the standalone CLI binary': seaStep\(/);
    assert.match(ciScript, /'CLI binary — offline e2e, no Node on PATH': seaStep\(/);
    assert.match(ciScript, /process\.platform === 'win32'[\s\S]{0,200}Windows installs the CLI with npm/);
  });
});

describe('cli-build.yml', () => {
  const builds = job(cliBuild, 'build');
  const attach = job(cliBuild, 'attach');

  it('runs on a release call, by hand and for a pull request to main that touches what the binary holds', () => {
    assert.match(cliBuild, /^ {2}workflow_call:$/m);
    assert.match(cliBuild, /^ {2}workflow_dispatch:$/m);
    assert.match(cliBuild, /^ {2}pull_request:\n {4}branches: \[ "main" \]\n(?: {4}#.*\n)* {4}paths:\n/m);
    const paths = [...cliBuild.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
    for (const path of ['packages/cli/**', 'packages/core/**', 'packages/web/**', 'package.json', 'package-lock.json', 'scripts/sea/**', 'packaging/sea/**', 'bench/live/drive-binary.mjs', 'bench/live/mock-provider.mjs', '.github/workflows/cli-build.yml']) {
      assert.ok(paths.includes(path), `${path} can change the binary but does not trigger a build`);
    }
  });

  it('builds each of the four targets on its own native runner, and lets one fail without cancelling the others', () => {
    const targets = [...builds.matchAll(/- target: (\S+)\n\s+os: (\S+)/g)].map(([, target, os]) => [target, os]);
    assert.deepEqual(targets, [['darwin-arm64', 'macos-15'], ['darwin-x64', 'macos-15-intel'], ['linux-x64', 'ubuntu-24.04'], ['linux-arm64', 'ubuntu-24.04-arm']]);
    assert.deepEqual(targets.map(([target]) => `ordewell-${target}.tar.gz`).sort(), [...CLI_FIXED_ASSETS].sort());
    assert.match(builds, /fail-fast: false/);
    assert.match(builds, /runs-on: \$\{\{ matrix\.os \}\}/);
  });

  it('pins every action to a commit SHA: on the release path its jobs hold the certificate and a token that writes', () => {
    const uses = [...cliBuild.matchAll(/^ {6,8}(?:- )?uses: (\S+)(?: # (\S+))?$/gm)].map(([, ref, version]) => ({ ref, version }));
    assert.ok(uses.length >= 4);
    for (const { ref, version } of uses) {
      assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
      assert.match(version ?? '', /^v\d+$/, `${ref} names no version`);
    }
  });

  it('is read-only everywhere except the job that attaches to the Release', () => {
    assert.match(cliBuild, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(builds, /permissions:/);
    assert.match(attach, /permissions:\n\s+contents: write/);
    assert.equal(cliBuild.match(/contents: write/g).length, 1);
    assert.match(attach, /if: inputs\.attach/);
    assert.match(attach, /needs: build/);
  });

  it('checks the tag only on the release path, before anything is installed', () => {
    assert.match(step(builds, 'Verify tag matches package versions'), /if: inputs\.attach\n/);
    assert.ok(builds.indexOf('verify-release-tag.mjs') < builds.indexOf('npm ci'));
  });

  it('builds core, then the binary, then proves it with no Node on PATH, then uploads it', () => {
    const order = ['npm ci', 'npm run build:core', 'node scripts/sea/build.mjs', '--version', 'node bench/live/drive-binary.mjs --bin "dist-sea/${{ matrix.target }}/ordewell"', 'actions/upload-artifact'];
    const at = order.map((needle) => builds.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] < 0)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    const upload = step(builds, 'Upload the archive');
    assert.match(upload, /name: cli-\$\{\{ matrix\.target \}\}/);
    assert.match(upload, /path: dist-sea\/ordewell-\*-\$\{\{ matrix\.target \}\}\.tar\.gz/);
    assert.match(upload, /if-no-files-found: error/);
  });

  it('keeps the drive off ordewell.ai (ADR-0048)', () => {
    assert.match(builds, /ORDEWELL_NO_VERSION_CHECK: '1'/);
  });

  it('signs with the Developer ID only on a macOS release with the certificate, and ad hoc otherwise (ADR-0065 C4)', () => {
    const imported = step(builds, 'Import the Developer ID certificate');
    assert.match(imported, /if: env\.MAC_SIGNING_SET == 'true'\n/);
    assert.match(imported, /security create-keychain/);
    assert.match(imported, /ORDEWELL_SEA_SIGN_IDENTITY=/);
    assert.ok(builds.indexOf('Import the Developer ID certificate') < builds.indexOf('node scripts/sea/build.mjs'), 'the identity is set before the build signs');
    assert.match(step(builds, 'Verify the macOS signature'), /codesign --verify --strict/);
    assert.match(step(builds, 'Remove the signing keychain'), /if: always\(\) && env\.SEA_KEYCHAIN != ''/);
  });

  it('notarizes only a Developer ID-signed binary, waits for Apple, and passes only "Accepted"', () => {
    const notarize = step(builds, 'Notarize the binary');
    assert.match(notarize, /if: env\.MAC_SIGNING_SET == 'true' && env\.MAC_NOTARIZE_SET == 'true'\n/);
    assert.match(notarize, /xcrun notarytool submit "\$zip" "\$\{auth\[@\]\}" --wait/);
    assert.match(notarize, /if \[ "\$status" != "Accepted" \]; then/);
    assert.match(notarize, /echo "Notarization status: \$status \(submission \$id\)"/);
    assert.match(notarize, /trap 'rm -f "\$key" "\$zip"' EXIT/);
    assert.ok(builds.indexOf('Drive the binary offline') < builds.indexOf('- name: Notarize the binary'), 'only a driven binary goes to Apple');
    assert.ok(builds.indexOf('- name: Notarize the binary') < builds.indexOf('- name: Upload the archive'));
    assert.match(builds, /- name: Say why the macOS binary was not notarized\n\s+if: runner\.os == 'macOS' && !\(env\.MAC_SIGNING_SET == 'true' && env\.MAC_NOTARIZE_SET == 'true'\)/);
  });

  it('hands each secret only to the step that uses it, and declares each as optional', () => {
    const jobEnv = builds.slice(builds.indexOf('    env:\n'), builds.indexOf('    steps:'));
    assert.doesNotMatch(jobEnv, /secrets\.\w+ \}\}/, 'a secret is in the job env');
    for (const name of SIGNING_SECRETS) {
      assert.equal((cliBuild.match(new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, 'g')) ?? []).length, 1, name);
      assert.match(cliBuild, new RegExp(`^ {6}${name}:\\n {8}required: false$`, 'm'), `${name} is not declared`);
    }
    assert.doesNotMatch(cliBuild, /secrets: inherit/);
  });

  it('attaches all four archives or none', () => {
    const upload = step(attach, 'Attach the archives to the GitHub Release');
    assert.match(upload, /if \[ \$\{#files\[@\]\} -ne 4 \]; then/);
    assert.match(upload, /gh release upload "\$TAG" "\$\{files\[@\]\}" --clobber --repo "\$REPO"/);
  });
});

describe('cli-build.yml: who signs, by kind of run (ADR-0065 C4)', () => {
  const builds = job(cliBuild, 'build');
  const jobEnv = builds.slice(builds.indexOf('    env:\n'), builds.indexOf('    steps:'));
  const envExprs = Object.fromEntries([...jobEnv.matchAll(/^ {6}(\w+): (.+)$/gm)].map(([, key, value]) => [key, value.replace(/^'|'$/g, '')]));
  const stepIf = (name) => step(builds, name).match(/^\s+if: (.+)$/m)?.[1] ?? 'success()';
  const retention = step(builds, 'Upload the archive').match(/retention-days: (.+)$/m)[1];
  const attachIf = job(cliBuild, 'attach').match(/^ {4}if: (.+)$/m)[1];
  const SIGNED_STEPS = ['Import the Developer ID certificate', 'Show the signing authority', 'Notarize the binary'];

  // The release path's tests before rehearsals existed, so a release is
  // proved to sign exactly when it did.
  const BEFORE = {
    MAC_SIGNING_SET: "${{ inputs.attach && startsWith(matrix.target, 'darwin-') && secrets.CSC_LINK != '' && secrets.CSC_KEY_PASSWORD != '' }}",
    MAC_NOTARIZE_SET: "${{ inputs.attach && startsWith(matrix.target, 'darwin-') && secrets.APPLE_API_KEY != '' && secrets.APPLE_API_KEY_ID != '' && secrets.APPLE_API_ISSUER != '' }}",
  };

  /** One matrix job of one run: its env, which steps run, whether attach runs. */
  const simulate = ({ event, inputs = {}, ref, target, secrets = SIGNING_SECRETS }) => {
    const context = {
      github: { event_name: event, ref },
      inputs,
      matrix: { target },
      runner: { os: target.startsWith('darwin-') ? 'macOS' : 'Linux' },
      // An unset secret reads as the empty string.
      secrets: Object.fromEntries(SIGNING_SECRETS.map((name) => [name, secrets.includes(name) ? `value-of-${name}` : ''])),
    };
    context.env = Object.fromEntries(Object.entries(envExprs).map(([key, expr]) => [key, interpolate(expr, context)]));
    const truthy = (expr) => {
      const value = evaluate(expr, context);
      return !(value === null || value === false || value === '' || value === 0);
    };
    return {
      env: context.env,
      before: Object.fromEntries(Object.entries(BEFORE).map(([key, expr]) => [key, interpolate(expr, context)])),
      runs: (name) => truthy(stepIf(name)),
      attaches: truthy(attachIf),
      retention: interpolate(retention, context),
    };
  };

  const rehearsal = (target, extra = {}) => simulate({ event: 'workflow_dispatch', inputs: { rehearse_signing: true }, ref: 'refs/heads/main', target, ...extra });
  const release = (target, extra = {}) => simulate({ event: 'push', inputs: { attach: true, tag: 'v0.13.0' }, ref: 'refs/tags/v0.13.0', target, ...extra });
  const pullRequest = (target) => simulate({ event: 'pull_request', ref: 'refs/pull/7/merge', target });

  it('takes rehearse_signing as a manual run\'s boolean input, off by default', () => {
    assert.match(cliBuild, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}rehearse_signing:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n {2}pull_request:/m);
  });

  it('a rehearsal on main signs with the Developer ID and notarizes each macOS binary, and attaches nothing', () => {
    for (const target of ['darwin-arm64', 'darwin-x64']) {
      const run = rehearsal(target);
      assert.deepEqual([run.env.MAC_REHEARSAL, run.env.MAC_SIGNING_SET, run.env.MAC_NOTARIZE_SET], ['true', 'true', 'true'], target);
      assert.ok(run.runs('Check the signing rehearsal can sign and notarize'), target);
      for (const name of SIGNED_STEPS) assert.ok(run.runs(name), `${target}: ${name}`);
      assert.ok(!run.runs('Say why the macOS binary was not notarized'), target);
      assert.ok(!run.runs('Verify tag matches package versions'), target);
      assert.equal(run.attaches, false);
      assert.equal(run.retention, '1', 'a rehearsal keeps its signed archives a day');
    }
    const linux = rehearsal('linux-x64');
    assert.deepEqual([linux.env.MAC_REHEARSAL, linux.env.MAC_SIGNING_SET, linux.env.MAC_NOTARIZE_SET], ['false', 'false', 'false']);
    for (const name of ['Check the signing rehearsal can sign and notarize', ...SIGNED_STEPS]) assert.ok(!linux.runs(name), name);
  });

  it('a rehearsal off main, or missing a credential, reaches the check that fails it, never an ad hoc signature', () => {
    const offMain = rehearsal('darwin-arm64', { ref: 'refs/heads/feat/x' });
    assert.equal(offMain.env.MAC_REHEARSAL, 'true');
    assert.equal(offMain.env.MAC_SIGNING_SET, 'false', 'no Developer ID signature off main');
    assert.ok(offMain.runs('Check the signing rehearsal can sign and notarize'));
    for (const missing of SIGNING_SECRETS) {
      const run = rehearsal('darwin-x64', { secrets: SIGNING_SECRETS.filter((name) => name !== missing) });
      assert.ok(run.runs('Check the signing rehearsal can sign and notarize'), missing);
    }
  });

  it('a release signs and notarizes exactly when it did before rehearsals existed, and attaches', () => {
    const subsets = [SIGNING_SECRETS, [], ['CSC_LINK', 'CSC_KEY_PASSWORD'], ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'], SIGNING_SECRETS.slice(1)];
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
      for (const secrets of subsets) {
        const run = release(target, { secrets });
        assert.equal(run.env.MAC_SIGNING_SET, run.before.MAC_SIGNING_SET, `${target} with ${secrets}`);
        assert.equal(run.env.MAC_NOTARIZE_SET, run.before.MAC_NOTARIZE_SET, `${target} with ${secrets}`);
        assert.equal(run.env.MAC_REHEARSAL, 'false');
        assert.ok(!run.runs('Check the signing rehearsal can sign and notarize'));
        assert.ok(run.runs('Verify tag matches package versions'));
        assert.equal(run.attaches, true);
        assert.equal(run.retention, '7');
      }
    }
    const signed = release('darwin-arm64');
    for (const name of SIGNED_STEPS) assert.ok(signed.runs(name), name);
    const adHoc = release('darwin-arm64', { secrets: [] });
    for (const name of SIGNED_STEPS) assert.ok(!adHoc.runs(name), name);
    assert.ok(adHoc.runs('Say why the macOS binary was not notarized'));
  });

  it('a pull request, even one asking for a rehearsal it cannot have, never signs, never reads a secret and never attaches', () => {
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
      for (const run of [pullRequest(target), simulate({ event: 'pull_request', inputs: { rehearse_signing: true, attach: false }, ref: 'refs/pull/7/merge', target })]) {
        assert.deepEqual([run.env.MAC_REHEARSAL, run.env.MAC_SIGNING_SET, run.env.MAC_NOTARIZE_SET].map((v) => v === 'true'), [false, false, false], target);
        for (const name of ['Check the signing rehearsal can sign and notarize', ...SIGNED_STEPS]) assert.ok(!run.runs(name), `${target}: ${name}`);
        assert.equal(run.attaches, false);
        assert.equal(run.retention, '7');
      }
    }
    // Every step a secret's value reaches is one of the signing steps.
    const holders = [...builds.matchAll(/- name: (.+)\n/g)].map(([, name]) => name).filter((name) => /\$\{\{ secrets\.\w+ \}\}/.test(step(builds, name)));
    assert.deepEqual(holders, ['Import the Developer ID certificate', 'Notarize the binary']);
  });

  it('a plain manual run signs ad hoc, as before', () => {
    const run = simulate({ event: 'workflow_dispatch', inputs: { rehearse_signing: false }, ref: 'refs/heads/main', target: 'darwin-arm64' });
    assert.deepEqual([run.env.MAC_REHEARSAL, run.env.MAC_SIGNING_SET, run.env.MAC_NOTARIZE_SET], ['false', 'false', 'false']);
    for (const name of ['Check the signing rehearsal can sign and notarize', ...SIGNED_STEPS]) assert.ok(!run.runs(name), name);
    assert.equal(run.attaches, false);
    assert.equal(run.retention, '7');
  });

  it('checks the rehearsal first, from whether each secret is set and never its value', () => {
    const check = step(builds, 'Check the signing rehearsal can sign and notarize');
    assert.ok(builds.indexOf('- name: Check the signing rehearsal') < builds.indexOf('actions/checkout'), 'before anything slow');
    assert.doesNotMatch(check, /\$\{\{ secrets\.\w+ \}\}/);
    for (const name of SIGNING_SECRETS) assert.match(check, new RegExp(`HAS_${name}: \\$\\{\\{ secrets\\.${name} != '' \\}\\}`), name);
  });

  const bash = (text, env, prelude = '') => spawnSync('bash', ['-c', `${prelude}\n${text}`], { encoding: 'utf8', env: { ...process.env, ...env } });

  it('the rehearsal check fails naming each missing secret, and off main', () => {
    const check = script(step(builds, 'Check the signing rehearsal can sign and notarize'));
    const has = (set) => Object.fromEntries(SIGNING_SECRETS.map((name) => [`HAS_${name}`, set.includes(name) ? 'true' : 'false']));
    const ok = bash(check, { REF: 'refs/heads/main', ...has(SIGNING_SECRETS) });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.doesNotMatch(ok.stdout, /::error::/);
    const missing = bash(check, { REF: 'refs/heads/main', ...has(['CSC_LINK', 'APPLE_API_KEY', 'APPLE_API_KEY_ID']) });
    assert.equal(missing.status, 1);
    assert.deepEqual([...missing.stdout.matchAll(/^::error::(\w+) is not set/gm)].map(([, name]) => name), ['CSC_KEY_PASSWORD', 'APPLE_API_ISSUER']);
    const offMain = bash(check, { REF: 'refs/heads/feat/x', ...has(SIGNING_SECRETS) });
    assert.equal(offMain.status, 1);
    assert.match(offMain.stdout, /^::error::a signing rehearsal runs on main only, not refs\/heads\/feat\/x$/m);
  });

  it('prints the signing authority and fails unless it is a Developer ID Application', () => {
    const show = step(builds, 'Show the signing authority');
    assert.ok(builds.indexOf('- name: Verify the macOS signature') < builds.indexOf('- name: Show the signing authority'));
    assert.ok(builds.indexOf('- name: Show the signing authority') < builds.indexOf('- name: Notarize the binary'));
    assert.match(show, /codesign -dv --verbose=2 "dist-sea\/\$TARGET\/ordewell"/);
    // codesign is macOS's; a shell function stands in for it, writing to
    // stderr as the real one does.
    const fake = (lines) => `codesign() { printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} >&2; }`;
    const developerId = bash(script(show), { TARGET: 'darwin-arm64' }, fake(['Identifier=ordewell', 'Authority=Developer ID Application: Ordewell (TEAM123456)', 'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA', 'TeamIdentifier=TEAM123456']));
    assert.equal(developerId.status, 0, developerId.stdout + developerId.stderr);
    assert.match(developerId.stdout, /^Authority=Developer ID Application: Ordewell \(TEAM123456\)$/m, 'the details reach the log');
    assert.match(developerId.stdout, /^Signing authority: Developer ID Application: Ordewell \(TEAM123456\)$/m);
    const adHoc = bash(script(show), { TARGET: 'darwin-arm64' }, fake(['Identifier=ordewell', 'Signature=adhoc', 'TeamIdentifier=not set']));
    assert.equal(adHoc.status, 1);
    assert.match(adHoc.stdout, /::error::the darwin-arm64 binary is signed by 'no authority', not a Developer ID Application identity/);
    const development = bash(script(show), { TARGET: 'darwin-x64' }, fake(['Authority=Apple Development: someone (ABC)']));
    assert.equal(development.status, 1);
    assert.match(development.stdout, /signed by 'Apple Development: someone \(ABC\)'/);
  });
});

describe('the cli and release-assets jobs in release.yml', () => {
  const cli = job(release, 'cli');
  const assets = job(release, 'release-assets');

  it('calls cli-build.yml to attach to this tag, after the Release exists', () => {
    assert.match(cli, /needs: github-release/);
    assert.match(cli, /uses: \.\/\.github\/workflows\/cli-build\.yml/);
    assert.match(cli, /attach: true/);
    assert.match(cli, /tag: \$\{\{ github\.ref_name \}\}/);
    assert.match(cli, /permissions:\n\s+contents: write/);
  });

  it('passes the macOS signing secrets by name and nothing else', () => {
    assert.doesNotMatch(cli, /secrets: inherit/);
    const passed = [...cli.slice(cli.indexOf('    secrets:\n')).matchAll(/^ {6}(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)];
    assert.deepEqual(passed.map(([, name, from]) => [name, from]), SIGNING_SECRETS.map((name) => [name, name]));
  });

  it('writes the fixed names, install.sh and SHA256SUMS once both builds have attached, sums last, then marks the Release latest (ADR-0065 C11)', () => {
    assert.match(assets, /needs: \[desktop, cli\]/);
    assert.match(assets, /permissions:\n\s+contents: write/);
    const at = [
      'gh release download "$TAG" --dir release',
      'cp scripts/install/cli.sh release/install.sh',
      'node scripts/desktop-release-assets.mjs release',
      'Ordewell-mac-arm64.dmg',
      'gh release upload "$TAG" release/SHA256SUMS',
      'node scripts/release-latest.mjs "$TAG"',
      'gh release edit "$TAG" --latest',
    ].map((needle) => assets.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), 'download, install.sh, the script, the fixed names, SHA256SUMS, the latest mark');
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    const fixed = step(assets, 'Attach the fixed-name copies and install.sh');
    for (const name of [...FIXED_ASSETS, ...CLI_FIXED_ASSETS, INSTALL_SCRIPT]) assert.ok(fixed.includes(name), `${name} is not uploaded`);
    assert.doesNotMatch(fixed, /SHA256SUMS/);
  });

  it('reads only the versioned files back, so a stale fixed-name copy is rewritten, not listed twice', () => {
    const download = step(assets, 'Download the installers and the CLI archives from the Release');
    const patterns = [...download.matchAll(/--pattern '([^']+)'/g)].map(([, p]) => p);
    assert.deepEqual(patterns, ['Ordewell-*-*-*.dmg', 'Ordewell-*-*-*.zip', 'Ordewell-*-*-*.exe', 'Ordewell-*-*-*.AppImage', 'Ordewell-*-*-*.deb', 'ordewell-*-*-*.tar.gz']);
  });

  it('pins its actions to a commit SHA: it holds a token that writes the Release', () => {
    const uses = [...assets.matchAll(/uses: (\S+)/g)].map(([, ref]) => ref);
    assert.ok(uses.length > 0);
    for (const ref of uses) assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
  });
});
