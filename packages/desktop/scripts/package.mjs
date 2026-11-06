// `npm run desktop:package`: the desktop app's installers for the current OS.
//
//   node scripts/package.mjs [--dir] [electron-builder args...]
//
// --dir builds the unpacked app only (no dmg, installer or AppImage): the
// quick way to check what a package holds. Anything else goes to
// electron-builder as it is, so `--arch x64` or `--config.mac.target=zip` work.
//
// Order is not optional: @ordewell/core and @ordewell/web must be built first
// (the root `npm run build` does), because the packaged daemon is web's dist.
//
// Signing is decided here from the environment (ADR-0063 H9): with no signing
// secrets the build is the unsigned one, ad hoc on macOS; with a complete set
// it is signed, notarized on macOS, and the app is built with updates on.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ESIGNER_HOOK = fileURLToPath(new URL('esigner-sign.mjs', import.meta.url));
const require = createRequire(import.meta.url);

export const MAC_CERTIFICATE = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
export const NOTARIZE_API_KEY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
export const NOTARIZE_APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
export const AZURE_SIGNING = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_CERTIFICATE_PROFILE'];
export const AZURE_CREDENTIALS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];
export const WIN_CERTIFICATE = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
// SSL.com eSigner: the cloud-HSM route for a publisher Azure Artifact Signing
// does not take (ADR-0063 H9).
export const ESIGNER = ['ES_USERNAME', 'ES_PASSWORD', 'ES_CREDENTIAL_ID', 'ES_TOTP_SECRET'];
// Everything electron-builder (or the Azure credential chain it runs) would
// pick up on its own. Each is dropped and only the chosen route's put back:
// on Windows electron-builder falls back from WIN_CSC_LINK to CSC_LINK, and on
// macOS it prefers an Apple ID to an API key whenever one is set.
const SIGNING_VARIABLES = [
  ...MAC_CERTIFICATE, 'CSC_NAME', ...NOTARIZE_API_KEY, ...NOTARIZE_APPLE_ID, 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE',
  ...AZURE_SIGNING, ...AZURE_CREDENTIALS, ...WIN_CERTIFICATE, ...ESIGNER, 'WIN_PUBLISHER_NAME',
];

/**
 * What a release passes in, by the runner.os that uses it: secrets from the
 * repository's secrets, the Azure account's names from its variables. The
 * rest of SIGNING_VARIABLES serve a local build.
 */
export const RELEASE_SECRETS = {
  macOS: [...MAC_CERTIFICATE, ...NOTARIZE_API_KEY, ...NOTARIZE_APPLE_ID],
  Windows: [...AZURE_CREDENTIALS, ...WIN_CERTIFICATE, ...ESIGNER],
};
export const RELEASE_VARIABLES = { Windows: [...AZURE_SIGNING, 'WIN_PUBLISHER_NAME'] };

/**
 * WIN_PUBLISHER_NAME holds one publisher name, or several for the release that
 * moves installs from one signer to another (ADR-0063 H9): electron-updater
 * accepts an update signed by any name its install lists. The separator is
 * `|`. A comma or a semicolon would be wrong ("Acme, Inc." is a legal name,
 * and RFC 4514 escapes both in a distinguished name), but `|` is neither
 * escaped there nor in any legal or personal name a CA validates, so no CN
 * holds one. Each entry is trimmed and an empty one dropped, so a trailing `|`
 * or a stray space changes nothing.
 */
export const PUBLISHER_NAME_SEPARATOR = '|';
export function publisherNames(value) {
  return typeof value === 'string' ? value.split(PUBLISHER_NAME_SEPARATOR).map((name) => name.trim()).filter(Boolean) : [];
}

const set = (env, name) => typeof env[name] === 'string' && env[name] !== '';
const missingFrom = (env, names) => names.filter((name) => !set(env, name));

/** A group of variables that is all there, absent, or reported as the ones missing. */
function group(env, names, label, problems) {
  const missing = missingFrom(env, names);
  if (missing.length === names.length) return false;
  if (missing.length === 0) return true;
  problems.push(`${label} needs ${names.join(', ')}; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`);
  return false;
}

function macPlan(env, problems, notes) {
  const certificate = group(env, MAC_CERTIFICATE, 'A Developer ID certificate', problems);
  const signing = certificate ? 'certificate' : set(env, 'CSC_NAME') ? 'keychain' : null;
  const apiKey = group(env, NOTARIZE_API_KEY, 'Notarizing with an App Store Connect API key', problems);
  const appleId = group(env, NOTARIZE_APPLE_ID, 'Notarizing with an Apple ID', problems);
  if (apiKey && appleId) notes.push('Both notarization credentials are set: notarizing with the App Store Connect API key.');
  let notarization = apiKey ? 'api-key' : appleId ? 'apple-id' : null;
  if (notarization && !signing && !set(env, 'CSC_LINK') && !set(env, 'CSC_KEY_PASSWORD')) {
    problems.push('Notarization needs a signing identity: set CSC_LINK and CSC_KEY_PASSWORD.');
    notarization = null;
  }
  // Squirrel.Mac only installs an update that satisfies the running app's
  // designated requirement, but Gatekeeper would still stop an update that is
  // signed and not notarized: updates wait for both.
  return { signing, notarization, publisherNames: [], azure: null, autoUpdate: signing !== null && notarization !== null };
}

function windowsPlan(env, problems, notes) {
  // The repository variables choose Azure; its three secrets alone do not,
  // because a developer's shell may hold them for something else.
  let azure = null;
  if (AZURE_SIGNING.some((name) => set(env, name))) {
    const missing = missingFrom(env, [...AZURE_SIGNING, ...AZURE_CREDENTIALS, 'WIN_PUBLISHER_NAME']);
    if (missing.length > 0) problems.push(`Azure Artifact Signing is missing ${missing.join(', ')}.`);
    else azure = { endpoint: env.AZURE_SIGNING_ENDPOINT, account: env.AZURE_SIGNING_ACCOUNT, profile: env.AZURE_CERTIFICATE_PROFILE };
  }
  let esigner = group(env, ESIGNER, 'SSL.com eSigner', problems);
  if (esigner && !set(env, 'WIN_PUBLISHER_NAME')) {
    problems.push('SSL.com eSigner is missing WIN_PUBLISHER_NAME.');
    esigner = false;
  }
  const certificate = group(env, WIN_CERTIFICATE, 'A Windows code-signing certificate', problems);
  const routes = [azure && 'Azure Artifact Signing', esigner && 'SSL.com eSigner', certificate && 'the certificate file'].filter(Boolean);
  if (routes.length > 1) notes.push(`${routes.length === 2 ? 'Both' : 'All three'} Windows signing routes are set (${routes.join(', ')}): signing with ${routes[0]}.`);
  const signing = azure ? 'azure' : esigner ? 'esigner' : certificate ? 'certificate' : null;
  // With a certificate file electron-builder reads the publisher from the
  // certificate itself. Azure and eSigner give it no certificate to read, and
  // without a name electron-updater would check no update's signature.
  const names = publisherNames(env.WIN_PUBLISHER_NAME);
  if (set(env, 'WIN_PUBLISHER_NAME') && names.length === 0) {
    problems.push(`WIN_PUBLISHER_NAME holds no name: it is only "${PUBLISHER_NAME_SEPARATOR}" and spaces.`);
  }
  return { signing, notarization: null, publisherNames: signing ? names : [], azure, autoUpdate: signing !== null };
}

/**
 * What this build is, from the signing secrets in `env` (ADR-0063 H9). Updates
 * are on only where the build is signed, and notarized on macOS: a signed
 * install records who signed it and refuses an update signed by anyone else,
 * while an unsigned one has nothing to hold an update to. Linux is never signed.
 * Half a credential is an error rather than an unsigned build, so a release
 * cannot quietly lose its signature to a mistyped secret.
 */
export function releasePlan(env, platform) {
  const problems = [];
  const notes = [];
  const unsigned = { signing: null, notarization: null, publisherNames: [], azure: null, autoUpdate: false };
  const plan = platform === 'darwin' ? macPlan(env, problems, notes) : platform === 'win32' ? windowsPlan(env, problems, notes) : unsigned;
  if (problems.length > 0) throw new Error(`The signing configuration is incomplete:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  return { platform, ...plan, notes };
}

/** `env` without a signing secret: what every build step but electron-builder runs with. */
export function withoutSigning(env) {
  const out = { ...env };
  for (const name of SIGNING_VARIABLES) delete out[name];
  return out;
}

/** The environment electron-builder runs with: the chosen route's secrets and no others. */
export function builderEnv(env, plan, { apiKeyPath } = {}) {
  const out = withoutSigning(env);
  const pass = (names) => { for (const name of names) out[name] = env[name]; };
  if (plan.signing === null) {
    // With none configured, electron-builder would look in the keychain and warn
    // or, on a machine with a stray identity, sign with it.
    out.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    return out;
  }
  if (plan.signing === 'keychain') pass(['CSC_NAME']);
  if (plan.platform === 'darwin' && plan.signing === 'certificate') pass(MAC_CERTIFICATE);
  if (plan.notarization === 'apple-id') pass(NOTARIZE_APPLE_ID);
  if (plan.notarization === 'api-key') {
    pass(NOTARIZE_API_KEY);
    // electron-builder reads APPLE_API_KEY as the path to the .p8.
    if (apiKeyPath) out.APPLE_API_KEY = apiKeyPath;
  }
  if (plan.signing === 'azure') pass(AZURE_CREDENTIALS);
  if (plan.signing === 'esigner') pass(ESIGNER);
  if (plan.platform === 'win32' && plan.signing === 'certificate') pass(WIN_CERTIFICATE);
  return out;
}

/**
 * The config each plan adds. Unsigned macOS is signed ad hoc, not left
 * unsigned: the fuses are flipped by rewriting the main executable, which
 * breaks the bundle's seal, and an arm64 Mac kills a binary whose signature
 * does not hold (SIGKILL on launch). Ad hoc runs without the hardened runtime,
 * whose library validation would reject Electron's frameworks. A signed build
 * keeps electron-builder.yml's hardened runtime and entitlements, and
 * forceCodeSigning fails it rather than let it ship unsigned.
 */
export function signingArgs(plan) {
  if (plan.signing === null) {
    return plan.platform === 'darwin' ? ['--config.mac.identity=-', '--config.mac.hardenedRuntime=false'] : [];
  }
  const args = ['--config.forceCodeSigning=true'];
  // electron-builder.yml keeps notarize off, so a local build with an identity
  // and no Apple credentials signs without trying.
  if (plan.notarization) args.push('--config.mac.notarize=true');
  const names = plan.publisherNames;
  // One name goes in as a string, as it always has. Several repeat the flag,
  // which electron-builder's parser turns into an array.
  const nameArgs = (path) => names.map((name) => `--config.${path}=${name}`);
  if (plan.signing === 'azure') {
    args.push(
      `--config.win.azureSignOptions.endpoint=${plan.azure.endpoint}`,
      `--config.win.azureSignOptions.codeSigningAccountName=${plan.azure.account}`,
      `--config.win.azureSignOptions.certificateProfileName=${plan.azure.profile}`,
      // Azure's schema takes one string and signing never reads it: the list
      // reaches app-update.yml through the publish config, which the
      // electron-builder version in this repository reads first.
      `--config.win.azureSignOptions.publisherName=${names[0]}`,
      ...(names.length > 1 ? nameArgs('publish.publisherName') : []),
    );
  } else if (plan.signing === 'esigner') {
    args.push(
      `--config.win.signtoolOptions.sign=${ESIGNER_HOOK}`,
      ...nameArgs('win.signtoolOptions.publisherName'),
    );
  } else if (plan.platform === 'win32') {
    args.push(...nameArgs('win.signtoolOptions.publisherName'));
  }
  return args;
}

/** electron-builder's flags for the current OS, plus whatever the caller passed. */
export function builderArgs(argv, platform, plan = releasePlan({}, platform)) {
  const os = { darwin: '--mac', win32: '--win', linux: '--linux' }[platform];
  if (!os) throw new Error(`The desktop app is not packaged on ${platform}.`);
  const dir = argv.includes('--dir');
  const rest = argv.filter((arg) => arg !== '--dir');
  const explicitOs = rest.some((arg) => ['--mac', '--win', '--linux', '-m', '-w', '-l'].includes(arg));
  // `--publish never`: desktop-build.yml attaches the installers; the builder never uploads.
  return [...(explicitOs ? [] : [os]), ...(dir ? ['--dir'] : []), '--publish', 'never', ...signingArgs(plan), ...rest];
}

/**
 * The App Store Connect key as a file, which is what electron-builder takes.
 * A CI secret holds the .p8's contents; a value that is not one is taken as a
 * path a maintainer already has.
 */
export function appleApiKeyFile(value, keyId, dir) {
  if (!value.includes('-----BEGIN')) return value;
  const file = join(dir, `AuthKey_${keyId}.p8`);
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}

/** What the build was, written beside the installers for desktop-package-check.mjs to hold them to. */
export function signingManifest(plan) {
  return { platform: plan.platform, signing: plan.signing, notarized: plan.notarization !== null, autoUpdate: plan.autoUpdate, publisherNames: plan.publisherNames };
}

function run(file, args, env = withoutSigning(process.env)) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) {
    console.error(`${[file, ...args].join(' ')} failed${result.status === null ? ` (${result.signal})` : ` with ${result.status}`}.`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const missing = [
    ['@ordewell/core', join(root, '..', 'core', 'dist', 'index.js')],
    ['@ordewell/web', join(root, '..', 'web', 'dist', 'server', 'main.js')],
  ].filter(([, file]) => !existsSync(file));
  if (missing.length > 0) {
    console.error(`Build ${missing.map(([name]) => name).join(' and ')} first: run \`npm run build\` at the repository root.`);
    process.exit(1);
  }

  let plan;
  try {
    plan = releasePlan(process.env, process.platform);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const note of plan.notes) console.log(note);
  console.log(`Packaging ${plan.signing ? `signed (${plan.signing})${plan.notarization ? `, notarized (${plan.notarization})` : ''}` : 'unsigned'}, updates ${plan.autoUpdate ? 'on' : 'off'}.`);
  const args = builderArgs(process.argv.slice(2), process.platform, plan);

  // A manifest left by an earlier build would vouch for this one if it failed.
  const manifest = join(root, 'release', 'signing.json');
  rmSync(manifest, { force: true });

  let apiKeyPath;
  if (plan.notarization === 'api-key') {
    const keyDir = mkdtempSync(join(tmpdir(), 'ordewell-notarize-'));
    // run() leaves through process.exit on a failure, so only an exit hook
    // removes the key on every path.
    process.on('exit', () => rmSync(keyDir, { recursive: true, force: true }));
    apiKeyPath = appleApiKeyFile(process.env.APPLE_API_KEY, process.env.APPLE_API_KEY_ID, keyDir);
  }

  // The icons are generated and checked in: regenerate only if they are missing.
  if (!existsSync(join(root, 'build', 'icon.icns'))) run(process.execPath, [join(root, 'scripts', 'app-icon.mjs')]);

  // The update gate is baked in here, from the same plan that signs the build
  // (tsup.config.ts): nothing at run time can turn it on.
  run(process.execPath, [require.resolve('tsup/dist/cli-default.js')], {
    ...withoutSigning(process.env),
    ORDEWELL_DESKTOP_AUTO_UPDATE: plan.autoUpdate ? 'on' : 'off',
  });
  run(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), 'build']);

  // extraResources names it, so a package built without this would ship a
  // notice describing a previous dependency tree, or none at all.
  run(process.execPath, [join(root, '..', '..', 'scripts', 'generate-third-party-notices.mjs'), 'desktop']);

  // node-pty is rebuilt for Electron by electron-builder itself, per target
  // architecture (npmRebuild in electron-builder.yml): a single rebuild here
  // would be the host's architecture, wrong for a macOS x64 build on arm64.

  const builderCli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  run(process.execPath, [builderCli, ...args], builderEnv(process.env, plan, { apiKeyPath }));

  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify(signingManifest(plan), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
