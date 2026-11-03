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
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const hasIdentity = (env) => Boolean(env.CSC_LINK || env.CSC_NAME);

/** The unsigned build is the default; a signing identity is opted into with CSC_LINK or CSC_NAME. */
export function signingEnv(env) {
  if (hasIdentity(env)) return env;
  // With none configured, electron-builder would look in the keychain and warn
  // or, on a machine with a stray identity, sign with it.
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
}

/**
 * Without an identity a macOS build is signed ad hoc, not left unsigned. The
 * fuses are flipped by rewriting the main executable, which breaks the bundle's
 * seal; an arm64 Mac kills a binary whose signature does not hold (SIGKILL on
 * launch), and an unsigned arm64 app is no better. The ad-hoc seal makes the
 * app run, though Gatekeeper still asks the person to open it by hand. With an
 * identity the config's own signing applies untouched.
 * hardenedRuntime off: library validation would reject Electron's frameworks,
 * which carry a different team id than an ad-hoc signature.
 */
export function macSigningArgs(env, platform) {
  if (platform !== 'darwin' || hasIdentity(env)) return [];
  return ['--config.mac.identity=-', '--config.mac.hardenedRuntime=false'];
}

/** electron-builder's flags for the current OS, plus whatever the caller passed. */
export function builderArgs(argv, platform, env = {}) {
  const os = { darwin: '--mac', win32: '--win', linux: '--linux' }[platform];
  if (!os) throw new Error(`The desktop app is not packaged on ${platform}.`);
  const dir = argv.includes('--dir');
  const rest = argv.filter((arg) => arg !== '--dir');
  const explicitOs = rest.some((arg) => ['--mac', '--win', '--linux', '-m', '-w', '-l'].includes(arg));
  // `--publish never`: release.yml attaches the installers; the builder never uploads.
  return [...(explicitOs ? [] : [os]), ...(dir ? ['--dir'] : []), '--publish', 'never', ...macSigningArgs(env, platform), ...rest];
}

function run(file, args, env = process.env) {
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

  const args = builderArgs(process.argv.slice(2), process.platform, process.env);

  // The icons are generated and checked in: regenerate only if they are missing.
  if (!existsSync(join(root, 'build', 'icon.icns'))) run(process.execPath, [join(root, 'scripts', 'app-icon.mjs')]);

  run(process.execPath, [require.resolve('tsup/dist/cli-default.js')]);
  run(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), 'build']);

  // node-pty is rebuilt for Electron by electron-builder itself, per target
  // architecture (npmRebuild in electron-builder.yml): a single rebuild here
  // would be the host's architecture, wrong for a macOS x64 build on arm64.

  const builderCli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  run(process.execPath, [builderCli, ...args], signingEnv(process.env));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
