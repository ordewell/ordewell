// The desktop app's place in ci.yml, desktop-build.yml, release.yml and the
// scripts that mirror them. change-scope.test.mjs already holds every step id to the workflow's
// rules; this pins what is specific to packaging the desktop app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    for (const name of ['homebrew', 'winget']) assert.match(job(release, name), /needs: release-assets\n/, name);
  });
});

describe('the package-manager jobs in release.yml (ADR-0063 H11)', () => {
  const homebrew = job(release, 'homebrew');
  const winget = job(release, 'winget');

  it('wait for the installers and the sums, and read nothing else of the release', () => {
    for (const text of [homebrew, winget]) {
      assert.match(text, /needs: release-assets/);
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
