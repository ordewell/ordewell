// The desktop app's place in ci.yml, desktop-build.yml, release.yml and the
// scripts that mirror them. change-scope.test.mjs already holds every step id to the workflow's
// rules; this pins what is specific to packaging the desktop app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { RELEASE_SECRETS, RELEASE_VARIABLES } from '../packages/desktop/scripts/package.mjs';
import { FIXED_ASSETS } from './desktop-release-assets.mjs';
import { STEPS_BY_CHECK, missedSteps, readWorkspaces, selectScope } from './change-scope.mjs';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release.yml', 'utf8');
const build = readFileSync('.github/workflows/desktop-build.yml', 'utf8');
const ciScript = readFileSync('scripts/ci.mjs', 'utf8');
const rootManifest = JSON.parse(readFileSync('package.json', 'utf8'));
const workspaces = readWorkspaces();

/** The text of one top-level job. */
const job = (workflow, name) => {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.ok(start >= 0, `no job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/^  [\w-]+:$/m);
  return end < 0 ? rest : rest.slice(0, end);
};

describe('the desktop build check in ci.yml', () => {
  it('is a packages step, so a change to any workspace owes it and a docs change does not', () => {
    assert.ok(STEPS_BY_CHECK.packages.includes('package-desktop'));
    const desktopOnly = selectScope(['packages/desktop/electron-builder.yml'], workspaces);
    const owed = (scope) => missedSteps(scope, {});
    assert.ok(owed(desktopOnly).some((line) => line.startsWith('package-desktop:')));
    assert.ok(!owed(selectScope(['docs/desktop/design.md'], workspaces)).some((line) => line.startsWith('package-desktop:')));
  });

  it('packages before the artifact check reads the installers', () => {
    assert.ok(ci.indexOf('id: package-desktop') > 0);
    assert.ok(ci.indexOf('id: package-desktop') < ci.indexOf('id: verify-artifacts'));
    assert.match(ci, /name: Package the desktop app\n\s+id: package-desktop\n\s+if: needs\.scope\.outputs\.packages != 'false'\n\s+run: npm run desktop:package\n/);
  });

  it('is run by scripts/ci.mjs as the same root script', () => {
    assert.match(ciScript, /'Package the desktop app': \(\) => npm\('run', 'desktop:package'\)/);
    assert.equal(rootManifest.scripts['desktop:package'], 'npm run package -w packages/desktop --');
  });

  it('is read by package-check.mjs, which fails when the installers are missing', () => {
    assert.match(readFileSync('scripts/package-check.mjs', 'utf8'), /checkDesktopPackage\(root\)/);
  });
});

describe('desktop-build.yml', () => {
  const builds = job(build, 'build');
  const attach = job(build, 'attach');

  it('runs on a release call, by hand and for a pull request to main that touches what an installer holds', () => {
    assert.match(build, /^ {2}workflow_call:$/m);
    assert.match(build, /^ {2}workflow_dispatch:$/m);
    assert.match(build, /^ {2}pull_request:\n {4}branches: \[ "main" \]\n(?: {4}#.*\n)* {4}paths:\n/m);
    const paths = [...build.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
    for (const path of ['packages/desktop/**', 'packages/ui/**', 'packages/core/**', 'packages/web/**', 'package.json', 'package-lock.json', '.github/workflows/desktop-build.yml', 'scripts/desktop-package-check.mjs', 'scripts/generate-third-party-notices.mjs']) {
      assert.ok(paths.includes(path), `${path} can change an installer but does not trigger a build`);
    }
  });

  it('takes the release path as inputs: whether to attach, and the tag', () => {
    assert.match(build, /attach:\n(?:\s+.*\n)*?\s+type: boolean\n\s+default: false/);
    assert.match(build, /tag:\n(?:\s+.*\n)*?\s+type: string/);
  });

  it('builds on macOS, Windows and Linux, and lets one OS fail without cancelling the others', () => {
    assert.match(builds, /os: \[macos-latest, windows-latest, ubuntu-latest\]/);
    assert.match(builds, /fail-fast: false/);
    assert.match(builds, /runs-on: \$\{\{ matrix\.os \}\}/);
  });

  it('is read-only everywhere except the job that attaches to the Release', () => {
    assert.match(build, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(builds, /permissions:/);
    assert.match(attach, /permissions:\n\s+contents: write/);
    assert.equal(build.match(/contents: write/g).length, 1);
    assert.match(attach, /if: inputs\.attach/);
    assert.match(attach, /needs: build/);
  });

  it('attaches only the versioned installers: the fixed names and SHA256SUMS wait for the CLI archives too (ADR-0065 C5)', () => {
    assert.doesNotMatch(build.replace(/^\s*#.*$/gm, ''), /desktop-release-assets|SHA256SUMS/, 'a sums file here would not list the CLI archives');
    for (const name of FIXED_ASSETS) assert.ok(!attach.includes(name), `${name} is uploaded here, before the CLI archives exist`);
    assert.match(job(release, 'release-assets'), /needs: \[desktop, cli\]/);
  });

  it('pins its attach job\'s action to a commit SHA: it holds a token that writes the Release', () => {
    const uses = [...attach.matchAll(/uses: (\S+)/g)].map(([, ref]) => ref);
    assert.ok(uses.length > 0);
    for (const ref of uses) assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
  });

  it('packages, verifies the packaged app and uploads the installers, in that order', () => {
    const order = ['npm ci', 'npm run build', 'npm run desktop:package', 'desktop-package-check.mjs', 'actions/upload-artifact'];
    const at = order.map((needle) => builds.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] < 0)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    assert.match(builds, /retention-days: \d+/);
    assert.match(builds, /if-no-files-found: error/);
  });

  it('uploads what it decided about signing, apart from the installers, for the package-manager jobs to read', () => {
    const upload = builds.slice(builds.indexOf('- name: Upload the signing manifest'), builds.indexOf('- name: Upload the installers'));
    assert.match(upload, /uses: actions\/upload-artifact@v4/);
    assert.match(upload, /name: signing-\$\{\{ runner\.os \}\}/);
    assert.match(upload, /path: packages\/desktop\/release\/signing\.json/);
    assert.match(upload, /if-no-files-found: error/);
    // The attach job downloads `desktop-*`; a name that matched would put the
    // signing manifest in the Release's asset directory.
    assert.doesNotMatch(upload, /name: desktop-/);
    assert.ok(builds.indexOf('desktop-package-check.mjs') < builds.indexOf('Upload the signing manifest'), 'only a checked build says what it signed');
  });

  it('checks the tag only on the release path, before anything is installed or built', () => {
    assert.match(builds, /if: inputs\.attach\n\s+env:\n\s+TAG: \$\{\{ inputs\.tag \}\}\n\s+run: node \.github\/workflows\/verify-release-tag\.mjs "\$TAG"/);
    assert.ok(builds.indexOf('verify-release-tag.mjs') < builds.indexOf('npm ci'));
  });

  it('keeps the daemon smoke off ordewell.ai (ADR-0048)', () => {
    assert.match(builds, /ORDEWELL_NO_VERSION_CHECK: '1'/);
    assert.match(builds, /ADR-0048/);
  });

  it('makes sure the Windows runner carries the Spectre-mitigated libraries node-pty compiles with', () => {
    const binding = readFileSync('node_modules/node-pty/binding.gyp', 'utf8');
    assert.match(binding, /'SpectreMitigation': 'Spectre'/);
    const step = builds.slice(builds.indexOf('Ensure the Visual Studio Spectre'), builds.indexOf('Install dependencies'));
    assert.match(step, /if: runner\.os == 'Windows'/);
    assert.match(step, /Microsoft\.VisualStudio\.Component\.VC\.Runtimes\.x86\.x64\.Spectre/);
    assert.match(step, /vswhere/);
    assert.match(step, /'modify'/);
    assert.ok(builds.indexOf('Ensure the Visual Studio Spectre') < builds.indexOf('npm run desktop:package'));
  });

  it('hands the package step each signing secret and variable on its own OS, and only on the release path (ADR-0063 H9)', () => {
    const step = builds.slice(builds.indexOf('- name: Package the desktop app'), builds.indexOf('- name: Verify the installers'));
    const passed = [...step.matchAll(/^ {10}(\w+): \$\{\{ (.+) \}\}$/gm)].map(([, name, expression]) => ({ name, expression }));
    const expected = [
      ...Object.entries(RELEASE_SECRETS).flatMap(([os, names]) => names.map((name) => ({ name, expression: `inputs.attach && runner.os == '${os}' && secrets.${name} || ''` }))),
      ...Object.entries(RELEASE_VARIABLES).flatMap(([os, names]) => names.map((name) => ({ name, expression: `inputs.attach && runner.os == '${os}' && vars.${name} || ''` }))),
    ];
    assert.deepEqual(passed, expected);
  });

  it('reads no secret anywhere else in the build job, so a pull request holds none', () => {
    const step = builds.slice(builds.indexOf('- name: Package the desktop app'), builds.indexOf('- name: Verify the installers'));
    const download = builds.slice(builds.indexOf('- name: Download CodeSignTool'), builds.indexOf('- name: Package the desktop app'));
    assert.doesNotMatch(builds.replace(step, '').replace(download, ''), /secrets\.|vars\./);
    assert.doesNotMatch(build, /secrets: inherit/);
  });

  it('fetches CodeSignTool for the eSigner route only on a Windows release with its secret, at a pinned checksum (ADR-0063 H9)', () => {
    const download = builds.slice(builds.indexOf('- name: Download CodeSignTool'), builds.indexOf('- name: Package the desktop app'));
    assert.ok(download.length > 0 && builds.indexOf('- name: Download CodeSignTool') < builds.indexOf('npm run desktop:package'));
    assert.match(download, /if: inputs\.attach && runner\.os == 'Windows'\n/);
    // Whether the secret is set, never its value, and no other secret.
    assert.deepEqual([...download.matchAll(/secrets\.\w+[^}]*/g)].map(([text]) => text.trim()), ["secrets.ES_USERNAME != ''"]);
    assert.match(download, /if \(\$env:ESIGNER_SET -ne 'true'\) \{[^}]*exit 0/);
    assert.match(download, /releases\/download\/v1\.3\.2\/CodeSignTool-v1\.3\.2-windows\.zip/);
    assert.match(download, /4afc32e8b7f79bbe1de7e4e7049aaad4e0f754357613b9bbec0e3052f06fd36b/);
    assert.match(download, /if \(\$actual -ne \$expected\) \{ throw/);
    assert.ok(download.indexOf('Get-FileHash') < download.indexOf('Expand-Archive'), 'checked before it is unpacked');
    assert.match(download, /"CODE_SIGN_TOOL_PATH=\$dir" \| Out-File -FilePath \$env:GITHUB_ENV/);
  });

  it('declares each secret it is handed as optional, so a release without them builds unsigned', () => {
    const declared = build.slice(build.indexOf('    secrets:\n'), build.indexOf('  workflow_dispatch:'));
    for (const name of Object.values(RELEASE_SECRETS).flat()) {
      assert.match(declared, new RegExp(`^ {6}${name}:\n {8}required: false$`, 'm'), `${name} is not declared`);
    }
  });

  it('attaches the files release.yml always attached, replacing a previous upload', () => {
    for (const pattern of ['Ordewell-*.dmg', 'Ordewell-*.zip', 'Ordewell-*.exe', 'Ordewell-*.AppImage', 'Ordewell-*.deb', 'Ordewell-*.blockmap', 'latest*.yml']) {
      assert.ok(attach.includes(pattern), `${pattern} is not attached`);
      assert.ok(builds.includes(`packages/desktop/release/${pattern}`), `${pattern} is not uploaded by the build`);
    }
    assert.match(attach, /gh release upload "\$TAG" "\$\{files\[@\]\}" --clobber --repo "\$REPO"/);
  });
});

describe('the desktop job in release.yml', () => {
  const desktop = job(release, 'desktop');

  it('calls desktop-build.yml to attach to this tag, after the Release exists', () => {
    assert.match(desktop, /needs: github-release/);
    assert.match(desktop, /uses: \.\/\.github\/workflows\/desktop-build\.yml/);
    assert.match(desktop, /attach: true/);
    assert.match(desktop, /tag: \$\{\{ github\.ref_name \}\}/);
  });

  it('passes the signing secrets by name and nothing else, never inheriting the publishing tokens', () => {
    assert.doesNotMatch(desktop, /secrets: inherit/);
    const passed = [...desktop.slice(desktop.indexOf('    secrets:\n')).matchAll(/^ {6}(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)];
    assert.deepEqual(passed.map(([, name, from]) => [name, from]), Object.values(RELEASE_SECRETS).flat().map((name) => [name, name]));
  });

  it('grants the write the called workflow\'s attach job asks for, and no more', () => {
    assert.match(desktop, /permissions:\n\s+contents: write/);
  });

  it('leaves the existing jobs as they were: only the package managers wait for the installers', () => {
    for (const name of ['ci', 'npm-publish', 'vscode-publish', 'github-release']) assert.ok(job(release, name));
    assert.match(job(release, 'github-release'), /needs: \[npm-publish, vscode-publish\]/);
    const rest = [desktop, job(release, 'release-assets'), job(release, 'homebrew'), job(release, 'winget')].reduce((text, part) => text.replace(part, ''), release);
    assert.doesNotMatch(rest, /needs:.*desktop/);
    // Homebrew names desktop only to read whether it ran (ADR-0065 C10).
    assert.match(job(release, 'homebrew'), /needs: \[desktop, release-assets\]\n/);
    assert.match(job(release, 'winget'), /needs: release-assets\n/);
  });
});

describe('the package-manager jobs in release.yml (ADR-0063 H11)', () => {
  const homebrew = job(release, 'homebrew');
  const winget = job(release, 'winget');

  it('wait for the installers and the sums, and read nothing else of the release', () => {
    for (const text of [homebrew, winget]) {
      assert.match(text, /needs: (?:\[desktop, )?release-assets\]?\n/);
      assert.match(text, /permissions:\n\s+contents: read/);
      assert.doesNotMatch(text, /contents: write/);
      assert.match(text, /gh release download "\$TAG" --pattern SHA256SUMS --dir sums --repo "\$REPO"|gh release download \$env:TAG --pattern SHA256SUMS --dir sums --repo \$env:REPO/);
    }
  });

  it('pin every action to a commit SHA, unlike the tag pins the other jobs use', () => {
    const expected = {
      homebrew: ['actions/checkout', 'actions/setup-node', 'actions/download-artifact'],
      winget: ['actions/checkout', 'actions/setup-node'],
    };
    for (const [name, text] of [['homebrew', homebrew], ['winget', winget]]) {
      const uses = [...text.matchAll(/^ {6,8}(?:- )?uses: (\S+)(?: # (\S+))?$/gm)].map(([, ref, version]) => ({ ref, version }));
      assert.deepEqual(uses.map(({ ref }) => ref.split('@')[0]), expected[name], name);
      for (const { ref, version } of uses) {
        assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
        assert.match(version ?? '', /^v\d+$/, `${ref} names no version`);
      }
      assert.equal((text.match(/- uses: actions\/[\w-]+@v\d+/g) ?? []).length, 0, `${name} uses a tag`);
    }
  });

  it('render the cask and the manifests from the release\'s own version and SHA256SUMS', () => {
    for (const only of ['formula', 'cask']) {
      assert.match(homebrew, new RegExp(`node scripts/render-package-manifests\\.mjs --version "\\$\\{TAG#v\\}" --sums sums/SHA256SUMS --only ${only} --out rendered`), only);
    }
    assert.match(winget, /node scripts\/render-package-manifests\.mjs --version \$tag\.TrimStart\('v'\) --sums sums\/SHA256SUMS --only winget --out rendered/);
    assert.ok(homebrew.indexOf('render-package-manifests.mjs') < homebrew.indexOf('homebrew-tap'));
    assert.ok(winget.indexOf('render-package-manifests.mjs') < winget.indexOf('wingetcreate.exe submit'));
  });

  it('publish the formula whenever the token exists, and the cask only for a notarized macOS build', () => {
    assert.match(homebrew, /HOMEBREW_TAP_TOKEN_SET: \$\{\{ secrets\.HOMEBREW_TAP_TOKEN != '' \}\}/);
    const publish = homebrew.slice(homebrew.indexOf('- name: Publish to ordewell/homebrew-tap'), homebrew.indexOf('- name: Say why nothing was published to the tap'));
    assert.ok(publish.length > 0);
    const formula = publish.indexOf('cp rendered/homebrew/Formula/ordewell.rb tap/Formula/ordewell.rb');
    const notarized = publish.indexOf('notarized === true');
    const cask = publish.indexOf('cp rendered/homebrew/Casks/ordewell-desktop.rb');
    const otherwise = publish.indexOf('else\n');
    assert.ok(formula >= 0 && formula < notarized, 'the formula is copied before, and apart from, the notarization test');
    assert.ok(notarized < cask && cask < otherwise, 'the cask is copied only on the notarized branch');
    assert.match(publish, /if: env\.HOMEBREW_TAP_TOKEN_SET == 'true'/);
    assert.match(publish, /signing\/signing\.json/);
    assert.match(publish, /notarized === true/);
    assert.match(publish, /::notice::the macOS build was not notarized/);
    assert.match(publish, /git clone --depth 1 "https:\/\/x-access-token:\$\{HOMEBREW_TAP_TOKEN\}@github\.com\/ordewell\/homebrew-tap\.git"/);
    assert.match(publish, /cp rendered\/homebrew\/Casks\/ordewell-desktop\.rb tap\/Casks\/ordewell-desktop\.rb/);
    assert.match(publish, /git -C tap remote set-url origin https:\/\/github\.com\/ordewell\/homebrew-tap\.git/);
    assert.match(publish, /git -C tap push origin HEAD/);
    assert.ok(publish.indexOf('remote set-url') < publish.indexOf('git -C tap commit'), 'the token is out of the remote before the commit');
    // The cask was `ordewell` before the formula took the name (ADR-0065 C8).
    const renamed = publish.slice(publish.indexOf('if [ -f tap/Casks/ordewell-desktop.rb ]'));
    assert.match(renamed, /git -C tap rm --quiet --ignore-unmatch Casks\/ordewell\.rb/);
    assert.match(renamed, /tap\/cask_renames\.json/);
    assert.match(renamed, /renames\.ordewell = "ordewell-desktop"/);
    assert.ok(renamed.indexOf('git -C tap add cask_renames.json') < renamed.indexOf('git -C tap commit'));
    assert.match(homebrew, /::notice::HOMEBREW_TAP_TOKEN is not set/);
  });

  it('open the winget pull request with the rendered manifests through a pinned wingetcreate', () => {
    assert.match(winget, /WINGET_TOKEN_SET: \$\{\{ secrets\.WINGET_TOKEN != '' \}\}/);
    const download = winget.slice(winget.indexOf('- name: Download wingetcreate'), winget.indexOf('- name: Open the pull request'));
    assert.match(download, /releases\/download\/v1\.12\.13\.0\/wingetcreate\.exe/);
    assert.match(download, /24042bd37915805615e6cf969ac57c6439124c3fe85823327f5f3fb24bd9ffea/);
    assert.match(download, /Get-FileHash -Algorithm SHA256/);
    assert.match(download, /if \(\$actual -ne \$expected\) \{ throw/);
    const submit = winget.slice(winget.indexOf('- name: Open the pull request'), winget.indexOf('- name: Say why no pull request'));
    assert.match(submit, /wingetcreate\.exe submit --token \$env:WINGET_TOKEN --no-open/);
    assert.match(submit, /"rendered\/winget\/manifests\/o\/Ordewell\/Ordewell\/\$version"/);
    assert.match(winget, /::notice::WINGET_TOKEN is not set/);
  });

  it('never put a publishing token in a job-level env, only in the step that uses it', () => {
    for (const text of [homebrew, winget]) {
      const jobEnv = text.slice(text.indexOf('    env:\n'), text.indexOf('    steps:'));
      assert.doesNotMatch(jobEnv, /secrets\.\w+ \}\}/, 'a token is in the job env');
      assert.match(jobEnv, /_SET: \$\{\{ secrets\.\w+ != '' \}\}/);
    }
    assert.equal((release.match(/HOMEBREW_TAP_TOKEN: \$\{\{ secrets\.HOMEBREW_TAP_TOKEN \}\}/g) ?? []).length, 1);
    assert.equal((release.match(/WINGET_TOKEN: \$\{\{ secrets\.WINGET_TOKEN \}\}/g) ?? []).length, 1);
  });

  it('say why nothing was published when a token is missing, rather than failing the release', () => {
    assert.match(homebrew, /- name: Say why nothing was published to the tap\n\s+if: env\.HOMEBREW_TAP_TOKEN_SET != 'true'/);
    assert.match(winget, /- name: Say why no pull request was opened\n\s+if: env\.WINGET_TOKEN_SET != 'true'/);
  });
});

describe('node-pty in the desktop package (ADR-0062 G11)', () => {
  const builder = readFileSync('packages/desktop/electron-builder.yml', 'utf8');

  it('is rebuilt for Electron per architecture and unpacked from the archive', () => {
    assert.match(builder, /^npmRebuild: true$/m);
    assert.match(builder, /^  - node_modules\/node-pty\/\*\*\/\*$/m);
  });

  it('is built by the package step that ci.yml and every desktop-build.yml runner run', () => {
    assert.match(job(build, 'build'), /run: npm run desktop:package\n/);
    assert.match(ci, /run: npm run desktop:package\n/);
  });
});

// The ORDEWELL_RELEASE_DESKTOP switch (ADR-0065 C10), run rather than read:
// the jobs' own conditions are evaluated as GitHub does, and the bash of the
// two Ubuntu jobs that write is run against a fake gh holding a Release and a
// fake git holding the tap, so what a release carries is what the steps did.

/** A job's top-level field (`needs`, `if`), or undefined. */
const jobField = (text, key) => new RegExp(`^ {4}${key}: (.*)$`, 'm').exec(text)?.[1];

/** A job's `env:` block, as written. */
const jobEnv = (text) => {
  const block = /^ {4}env:\n((?: {6}.*\n| *#.*\n)+)/m.exec(text)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/^ {6}(\w+): (.+)$/gm)].map(([, key, value]) => [key, value]));
};

/** A job's steps: its fields as written, the env block, and the run script dedented. */
const parseSteps = (text) => {
  const lines = text.slice(text.indexOf('\n    steps:\n') + '\n    steps:\n'.length).split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const first = /^ {6}- ([\w-]+): ?(.*)$/.exec(lines[i]);
    const field = first ?? /^ {8}([\w-]+): ?(.*)$/.exec(lines[i]);
    if (!field) continue;
    if (first) steps.push({ env: {} });
    const current = steps.at(-1);
    const [, key, value] = field;
    const block = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].startsWith('          '))) block.push(lines[++i]);
    if (key === 'env') for (const [, name, entry] of block.join('\n').matchAll(/^ {10}(\w+): (.+)$/gm)) current.env[name] = entry;
    else if (key === 'run' && value === '|') current.run = `${block.map((line) => line.slice(10)).join('\n').trimEnd()}\n`;
    else current[key] = value;
  }
  return steps;
};

/**
 * One GitHub Actions expression, in the forms release.yml uses: `!`, `&&`,
 * `||`, parentheses, `==`/`!=` (which GitHub compares ignoring case), string
 * literals, status functions and the needs, vars, env, secrets and github
 * contexts. A bare condition with no status function is `success() && (...)`.
 */
const evaluate = (expression, context, { condition = false } = {}) => {
  let source = expression.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  if (condition && !/\b(?:success|failure|cancelled|always)\(\)/.test(source)) source = `success() && (${source})`;
  const tokens = source.match(/'[^']*'|==|!=|&&|\|\||[!()]|[\w.-]+\(\)|[\w-]+(?:\.[\w-]+)+/g);
  assert.equal(tokens.join(''), source.replace(/\s+/g, ''), `release.yml uses an expression this test cannot read: ${source}`);
  const lookup = (path) => {
    const [scope, ...rest] = path.split('.');
    if (scope === 'needs') return context.needs[rest[0]];
    return context[scope]?.[rest.join('.')] ?? '';
  };
  const js = tokens.map((token) => {
    if (token.startsWith("'")) return JSON.stringify(token.slice(1, -1).toLowerCase());
    if (token === '==') return '===';
    if (token === '!=') return '!==';
    if (['&&', '||', '!', '(', ')'].includes(token)) return token;
    if (token.endsWith('()')) return JSON.stringify({ 'success()': context.success, 'cancelled()': false, 'failure()': !context.success, 'always()': true }[token]);
    const value = lookup(token);
    return JSON.stringify(typeof value === 'string' ? value.toLowerCase() : value);
  }).join(' ');
  return new Function(`return (${js});`)();
};

/** Each release job's result, given the switch's value and how each job that ran came out. */
const simulate = ({ vars = {}, outcome = {} }) => {
  const needs = {};
  const results = { ci: 'success', 'npm-publish': 'success', 'vscode-publish': 'success', 'github-release': 'success' };
  for (const name of ['desktop', 'cli', 'release-assets', 'homebrew', 'winget']) {
    const text = job(release, name);
    needs[name] = (jobField(text, 'needs') ?? '').replace(/[[\]]/g, '').split(',').map((n) => n.trim()).filter(Boolean);
    // A skipped or failed job anywhere upstream fails the implied success().
    const upstream = (n) => (needs[n] ?? []).flatMap((m) => [m, ...upstream(m)]);
    const success = upstream(name).every((n) => results[n] === 'success');
    const runs = evaluate(jobField(text, 'if') ?? 'success()', { needs: results, vars, success }, { condition: true });
    results[name] = runs ? outcome[name] ?? 'success' : 'skipped';
  }
  return results;
};

describe('the ORDEWELL_RELEASE_DESKTOP switch in release.yml (ADR-0065 C10)', () => {
  const pick = (results) => ['desktop', 'cli', 'release-assets', 'homebrew', 'winget'].map((name) => `${name}=${results[name]}`).join(' ');

  it('builds and releases the desktop app only when the variable is true', () => {
    const on = 'desktop=success cli=success release-assets=success homebrew=success winget=success';
    const off = 'desktop=skipped cli=success release-assets=success homebrew=success winget=skipped';
    assert.equal(pick(simulate({ vars: { ORDEWELL_RELEASE_DESKTOP: 'true' } })), on);
    for (const value of [undefined, '', 'false', '1', 'yes']) {
      assert.equal(pick(simulate({ vars: value === undefined ? {} : { ORDEWELL_RELEASE_DESKTOP: value } })), off, `ORDEWELL_RELEASE_DESKTOP=${value}`);
    }
  });

  it('still lets a desktop build that fails with the switch on stop the release assets and the package managers', () => {
    assert.equal(
      pick(simulate({ vars: { ORDEWELL_RELEASE_DESKTOP: 'true' }, outcome: { desktop: 'failure' } })),
      'desktop=failure cli=success release-assets=skipped homebrew=skipped winget=skipped',
    );
  });

  it('writes nothing after a CLI build or the release assets fail, with the switch either way', () => {
    for (const vars of [{}, { ORDEWELL_RELEASE_DESKTOP: 'true' }]) {
      assert.match(pick(simulate({ vars, outcome: { cli: 'failure' } })), /release-assets=skipped homebrew=skipped winget=skipped$/);
      assert.match(pick(simulate({ vars, outcome: { 'release-assets': 'failure' } })), /homebrew=skipped winget=skipped$/);
    }
  });

  const posixOnly = process.platform === 'win32' ? 'runs the bash of jobs that run only on ubuntu-latest' : false;
  const VERSION = '9.8.7';
  const CLI_ARCHIVES = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => `ordewell-${VERSION}-${target}.tar.gz`);
  const INSTALLERS = ['mac-arm64.dmg', 'mac-x64.dmg', 'mac-arm64.zip', 'mac-x64.zip', 'win-x64.exe', 'linux-x64.AppImage', 'linux-x64.deb'].map((rest) => `Ordewell-${VERSION}-${rest}`);

  /**
   * A checkout of this repository's scripts, a fake Release holding what the
   * builds that ran attached, and fake gh and git on PATH. Runs one job's steps
   * in order as GitHub would, and returns what each printed.
   */
  const workspace = ({ desktop, tap = [], releases = [{ tag_name: `v${VERSION}`, draft: false, prerelease: false }], existing = false, apiFails = false }) => {
    const root = mkdtempSync(join(tmpdir(), 'release-switch-'));
    const work = join(root, 'work');
    const assets = join(root, 'release-assets');
    const bin = join(root, 'bin');
    for (const dir of [work, assets, bin, join(root, 'tap')]) mkdirSync(dir, { recursive: true });
    // Copied, not linked: a script run through a link reads its own path as
    // the link's target and skips its command line.
    for (const dir of ['scripts', 'packaging']) cpSync(dir, join(work, dir), { recursive: true });
    for (const name of [...CLI_ARCHIVES, ...(desktop ? INSTALLERS : [])]) writeFileSync(join(assets, name), `asset ${name}\n`);
    for (const name of tap) {
      mkdirSync(dirname(join(root, 'tap', name)), { recursive: true });
      writeFileSync(join(root, 'tap', name), 'old\n');
    }
    const log = join(root, 'log');
    writeFileSync(join(bin, 'fake.mjs'), `
      import { appendFileSync, copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
      import { basename, join } from 'node:path';
      const [tool, ...args] = process.argv.slice(2);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify([tool, ...args]) + '\\n');
      const after = (flag) => args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));
      if (tool === 'gh' && args[0] === 'release' && args[1] === 'download') {
        const globs = after('--pattern').map((p) => new RegExp('^' + p.replace(/[.]/g, '\\\\.').replace(/[*]/g, '.*') + '$'));
        const names = readdirSync(${JSON.stringify(assets)}).filter((name) => globs.some((glob) => glob.test(name)));
        if (names.length === 0) { console.error('no assets match the file pattern'); process.exit(1); }
        mkdirSync(after('--dir')[0], { recursive: true });
        for (const name of names) copyFileSync(join(${JSON.stringify(assets)}, name), join(after('--dir')[0], name));
      } else if (tool === 'gh' && args[0] === 'release' && args[1] === 'upload') {
        const files = args.slice(3).filter((arg, at, all) => !arg.startsWith('--') && !['--repo'].includes(all[at - 1]));
        for (const file of files) copyFileSync(file, join(${JSON.stringify(assets)}, basename(file)));
      } else if (tool === 'gh' && args[0] === 'release' && args[1] === 'view') {
        process.exit(${JSON.stringify(existing)} ? 0 : 1);
      } else if (tool === 'gh' && args[0] === 'release' && ['create', 'edit'].includes(args[1])) {
        // Recorded in the log only.
      } else if (tool === 'gh' && args[0] === 'api') {
        // The one read release.yml makes, and the jq filter it reads it with:
        // a different filter would need this fake to learn it.
        if (!args.includes('repos/ordewell/ordewell/releases?per_page=100') || !args.includes('--paginate')) process.exit(4);
        if (after('--jq')[0] !== '.[] | select(.draft == false and .prerelease == false) | .tag_name') process.exit(4);
        if (${JSON.stringify(apiFails)}) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
        const releases = ${JSON.stringify(releases)};
        for (const release of releases) if (!release.draft && !release.prerelease) console.log(release.tag_name);
      } else if (tool === 'git' && args[0] === 'clone') {
        cpSync(${JSON.stringify(join(root, 'tap'))}, args.at(-1), { recursive: true });
      } else if (tool === 'git' && args[2] === 'rm') {
        rmSync(join(args[1], args.at(-1)), { force: true });
      } else if (tool === 'git' && args[2] === 'diff') {
        process.exit(1);
      } else if (tool !== 'git') {
        process.exit(3);
      }
    `);
    for (const tool of ['gh', 'git']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" ${tool} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const github = { ref_name: `v${VERSION}`, repository: 'ordewell/ordewell' };
    const run = (name, { results, secrets = {}, artifacts = {} }) => {
      const text = job(release, name);
      const context = { needs: results, github, secrets, vars: {}, success: true };
      const resolved = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value.includes('${{') ? evaluate(value, context) : value)]));
      const env = resolved(jobEnv(text));
      const printed = [];
      for (const step of parseSteps(text)) {
        if (step.if && !evaluate(step.if, { ...context, env }, { condition: true })) continue;
        if (step.uses) {
          const action = step.uses.split('@')[0];
          if (action === 'actions/download-artifact') {
            const artifact = /name: (\S+)/.exec(text.slice(text.indexOf(step.uses)))[1];
            assert.ok(artifact in artifacts, `${name} downloads the artifact ${artifact}, which no job of this run uploaded`);
            mkdirSync(join(work, 'signing'), { recursive: true });
            writeFileSync(join(work, 'signing', 'signing.json'), JSON.stringify(artifacts[artifact]));
          } else assert.ok(['actions/checkout', 'actions/setup-node'].includes(action), action);
          continue;
        }
        assert.doesNotMatch(step.run, /\$\{\{/, `${step.name} expands an expression inside its script`);
        const out = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
          cwd: work,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env, ...resolved(step.env) },
        });
        printed.push({ step: step.name, stdout: out.stdout, stderr: out.stderr });
        assert.equal(out.status, 0, `${name}: ${step.name} failed:\n${out.stdout}${out.stderr}`);
      }
      return printed;
    };
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const listed = () => readFileSync(join(assets, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split(/\s+\*?/)[1]).sort();
    return { root, work, assets, run, calls, listed, done: () => rmSync(root, { recursive: true, force: true }) };
  };

  const notices = (printed) => printed.flatMap(({ stdout }) => stdout.split('\n').filter((line) => line.startsWith('::notice::')));
  const FIXED_CLI = ['ordewell-darwin-arm64.tar.gz', 'ordewell-darwin-x64.tar.gz', 'ordewell-linux-arm64.tar.gz', 'ordewell-linux-x64.tar.gz'];
  const LATEST = `::notice::v${VERSION} is complete and the highest release, so it is now latest: releases/latest/download/ and ordewell.ai/install.sh serve it (ADR-0065 C11).`;

  it('releases the CLI alone with the switch off: its archives, their fixed copies, install.sh and a SHA256SUMS of just those', { skip: posixOnly }, () => {
    const space = workspace({ desktop: false });
    try {
      const results = simulate({});
      const printed = space.run('release-assets', { results });
      const carried = [...CLI_ARCHIVES, ...FIXED_CLI, 'install.sh'].sort();
      assert.deepEqual(readdirSync(space.assets).sort(), [...carried, 'SHA256SUMS'].sort());
      assert.deepEqual(space.listed(), carried);
      for (const [, hash, name] of readFileSync(join(space.assets, 'SHA256SUMS'), 'utf8').matchAll(/^([0-9a-f]{64}) [ *](\S+)$/gm)) {
        assert.equal(hash, createHash('sha256').update(readFileSync(join(space.assets, name))).digest('hex'), name);
      }
      const uploads = space.calls().filter(([, , verb]) => verb === 'upload');
      assert.deepEqual(uploads.at(-1).slice(4).filter((arg) => !arg.startsWith('--') && arg !== 'ordewell/ordewell'), ['release/SHA256SUMS']);
      const downloaded = space.calls().find(([, , verb]) => verb === 'download');
      assert.deepEqual(downloaded.filter((arg, at) => downloaded[at - 1] === '--pattern'), ['ordewell-*-*-*.tar.gz']);
      assert.deepEqual(notices(printed), [LATEST, "::notice::ORDEWELL_RELEASE_DESKTOP is not 'true', so the desktop app was not built: this release carries the CLI archives, install.sh and SHA256SUMS, Homebrew gets the formula and no cask, and winget no pull request (ADR-0065 C10)."]);
    } finally {
      space.done();
    }
  });

  it('releases the desktop installers too with the switch on, and says nothing about the switch', { skip: posixOnly }, () => {
    const space = workspace({ desktop: true });
    try {
      const results = simulate({ vars: { ORDEWELL_RELEASE_DESKTOP: 'true' } });
      const printed = space.run('release-assets', { results });
      const carried = [...CLI_ARCHIVES, ...FIXED_CLI, ...INSTALLERS, ...FIXED_ASSETS, 'install.sh'].sort();
      assert.deepEqual(readdirSync(space.assets).sort(), [...carried, 'SHA256SUMS'].sort());
      assert.deepEqual(space.listed(), carried);
      assert.deepEqual(notices(printed), [LATEST]);
    } finally {
      space.done();
    }
  });

  it('publishes the formula and no cask with the switch off, and leaves the tap\'s old cask and its rename alone', { skip: posixOnly }, () => {
    const space = workspace({ desktop: false, tap: ['Casks/ordewell.rb'] });
    try {
      const results = simulate({});
      space.run('release-assets', { results });
      const printed = space.run('homebrew', { results, secrets: { HOMEBREW_TAP_TOKEN: 'token' } });
      const tap = join(space.work, 'tap');
      assert.ok(existsSync(join(tap, 'Formula', 'ordewell.rb')));
      assert.match(readFileSync(join(tap, 'Formula', 'ordewell.rb'), 'utf8'), new RegExp(`version "${VERSION.replace(/\./g, '\\.')}"`));
      assert.ok(!existsSync(join(tap, 'Casks', 'ordewell-desktop.rb')), 'a cask was published for a release without the desktop app');
      assert.ok(existsSync(join(tap, 'Casks', 'ordewell.rb')), 'the old cask went before its successor exists');
      assert.ok(!existsSync(join(tap, 'cask_renames.json')));
      assert.ok(!existsSync(join(space.work, 'rendered', 'homebrew', 'Casks')), 'the cask was rendered');
      assert.ok(space.calls().some(([tool, , , verb]) => tool === 'git' && verb === 'push'));
      assert.deepEqual(notices(printed), ["::notice::ORDEWELL_RELEASE_DESKTOP is not 'true', so this release has no desktop app and no cask was published, only the formula (ADR-0065 C10)."]);
    } finally {
      space.done();
    }
  });

  it('says why nothing reached the tap when the token is missing too, with the switch off', { skip: posixOnly }, () => {
    const space = workspace({ desktop: false });
    try {
      const results = simulate({});
      space.run('release-assets', { results });
      const printed = space.run('homebrew', { results });
      assert.deepEqual(notices(printed), ['::notice::HOMEBREW_TAP_TOKEN is not set, so neither the formula nor the cask was published (ADR-0063 H11, ADR-0065 C8).']);
      assert.ok(!space.calls().some(([tool]) => tool === 'git'));
    } finally {
      space.done();
    }
  });

  it('publishes the cask from a notarized build with the switch on, and renames the old cask', { skip: posixOnly }, () => {
    const space = workspace({ desktop: true, tap: ['Casks/ordewell.rb'] });
    try {
      const results = simulate({ vars: { ORDEWELL_RELEASE_DESKTOP: 'true' } });
      space.run('release-assets', { results });
      const printed = space.run('homebrew', { results, secrets: { HOMEBREW_TAP_TOKEN: 'token' }, artifacts: { 'signing-macOS': { notarized: true } } });
      const tap = join(space.work, 'tap');
      assert.ok(existsSync(join(tap, 'Formula', 'ordewell.rb')));
      assert.match(readFileSync(join(tap, 'Casks', 'ordewell-desktop.rb'), 'utf8'), new RegExp(`version "${VERSION.replace(/\./g, '\\.')}"`));
      assert.ok(!existsSync(join(tap, 'Casks', 'ordewell.rb')));
      assert.deepEqual(JSON.parse(readFileSync(join(tap, 'cask_renames.json'), 'utf8')), { ordewell: 'ordewell-desktop' });
      assert.deepEqual(notices(printed), []);
    } finally {
      space.done();
    }
  });

  describe('the latest mark (ADR-0065 C11)', () => {
    /** Each gh call of the log, as its arguments after `gh`. */
    const gh = (space) => space.calls().filter(([tool]) => tool === 'gh').map(([, ...args]) => args);
    const marks = (space) => gh(space).filter(([group, verb]) => group === 'release' && verb === 'edit');

    it('creates the Release without the mark, so the previous release stays latest while this one fills', { skip: posixOnly }, () => {
      const space = workspace({ desktop: false });
      try {
        space.run('github-release', { results: simulate({}) });
        assert.deepEqual(gh(space), [
          ['release', 'view', `v${VERSION}`],
          ['release', 'create', `v${VERSION}`, '--title', `v${VERSION}`, '--notes-from-tag', '--latest=false'],
        ]);
      } finally {
        space.done();
      }
    });

    it('leaves a Release that already exists as it is, its mark too', { skip: posixOnly }, () => {
      const space = workspace({ desktop: false, existing: true });
      try {
        const printed = space.run('github-release', { results: simulate({}) });
        assert.deepEqual(gh(space), [['release', 'view', `v${VERSION}`]]);
        assert.match(printed[0].stdout, new RegExp(`Release v${VERSION.replace(/\./g, '\\.')} already exists, skipping`));
      } finally {
        space.done();
      }
    });

    it('is given only in release-assets, and nowhere is a Release made latest any other way', () => {
      const given = [...release.matchAll(/--latest\b(=\w+)?/g)].map(([flag]) => flag);
      assert.deepEqual(given, ['--latest=false', '--latest']);
      assert.match(job(release, 'github-release'), /--latest=false/);
      assert.match(parseSteps(job(release, 'release-assets')).find(({ name }) => name === 'Mark the Release latest, if it is the highest version').run, /gh release edit "\$TAG" --latest --repo "\$REPO"/);
      assert.doesNotMatch(release, /make_latest/);
    });

    for (const [switchName, vars, desktop] of [['off', {}, false], ['on', { ORDEWELL_RELEASE_DESKTOP: 'true' }, true]]) {
      it(`marks the Release latest only after SHA256SUMS is attached, with the switch ${switchName}`, { skip: posixOnly }, () => {
        const space = workspace({ desktop });
        try {
          space.run('release-assets', { results: simulate({ vars }) });
          const calls = gh(space);
          const sums = calls.findLastIndex(([group, verb, , file]) => group === 'release' && verb === 'upload' && file === 'release/SHA256SUMS');
          const mark = calls.findIndex(([group, verb]) => group === 'release' && verb === 'edit');
          assert.ok(sums >= 0 && mark > sums, 'the mark comes before SHA256SUMS');
          assert.equal(mark, calls.length - 1, 'the Release changed after it was marked');
          assert.deepEqual(calls[mark], ['release', 'edit', `v${VERSION}`, '--latest', '--repo', 'ordewell/ordewell']);
        } finally {
          space.done();
        }
      });
    }

    it('never takes latest back from a higher release when an older tag\'s release is re-run', { skip: posixOnly }, () => {
      const space = workspace({ desktop: false, releases: [{ tag_name: 'v10.0.0' }, { tag_name: `v${VERSION}` }, { tag_name: 'v9.8.6' }] });
      try {
        const printed = space.run('release-assets', { results: simulate({}) });
        assert.deepEqual(marks(space), []);
        assert.ok(notices(printed).includes(`::notice::v${VERSION} is complete, but v10.0.0 is a higher release, so latest stays where it is (ADR-0065 C11).`), notices(printed).join('\n'));
      } finally {
        space.done();
      }
    });

    it('passes over a higher draft or prerelease, which are never latest', { skip: posixOnly }, () => {
      const space = workspace({
        desktop: false,
        releases: [{ tag_name: 'v10.0.0', draft: true }, { tag_name: 'v9.9.0-rc.1', prerelease: true }, { tag_name: `v${VERSION}` }, { tag_name: 'v9.8.7-rc.1' }, { tag_name: 'not-a-version' }],
      });
      try {
        const printed = space.run('release-assets', { results: simulate({}) });
        assert.equal(marks(space).length, 1);
        assert.ok(notices(printed).includes(LATEST));
      } finally {
        space.done();
      }
    });

    it('marks nothing and fails the job when the release list cannot be read, or does not hold this release', { skip: posixOnly }, () => {
      for (const options of [{ apiFails: true }, { releases: [{ tag_name: 'v1.0.0' }] }, { releases: [] }]) {
        const space = workspace({ desktop: false, ...options });
        try {
          assert.throws(() => space.run('release-assets', { results: simulate({}) }), /Mark the Release latest, if it is the highest version failed/);
          assert.deepEqual(marks(space), [], JSON.stringify(options));
        } finally {
          space.done();
        }
      }
    });

    it('is not given when the CLI build fails, so latest stays on the last complete release', () => {
      for (const vars of [{}, { ORDEWELL_RELEASE_DESKTOP: 'true' }]) {
        assert.equal(simulate({ vars, outcome: { cli: 'failure' } })['release-assets'], 'skipped');
      }
      assert.equal(simulate({ vars: { ORDEWELL_RELEASE_DESKTOP: 'true' }, outcome: { desktop: 'failure' } })['release-assets'], 'skipped');
    });
  });
});
