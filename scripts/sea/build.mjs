#!/usr/bin/env node
// Builds the standalone `ordewell` binary (ADR-0065): the CLI, the TUI and the
// daemon in one Node single executable application, so a user needs no Node.
// It builds for the machine it runs on, embedding the very Node running it:
//
//   npm run build && node scripts/sea/build.mjs [--out <dir>] [--sign <identity>]
//
// and writes <out>/ordewell-<version>-<os>-<arch>.tar.gz, holding one `ordewell`,
// plus that binary at <out>/<os>-<arch>/ordewell, signed on macOS, for a later
// step to notarize. <out> defaults to dist-sea/. On macOS a Developer ID
// (`--sign`, or ORDEWELL_SEA_SIGN_IDENTITY) signs with the hardened runtime and
// packaging/sea/entitlements.plist; without one the signature is ad hoc.
//
// What is bundled: the CLI's and the web daemon's TypeScript sources (entry
// packages/cli/src/sea.ts, which imports packages/web/server/daemon.ts), and
// @ordewell/core's built dist/*.js, the CommonJS files the npm CLI loads. Core
// is taken built because its build is part of what it is (its tsup config
// rewrites import.meta for CJS), so `npm run build -w packages/core` comes
// first. Every third-party package is inlined: a SEA's `require` loads built-ins
// alone, so nothing may be left to load from disk. The exceptions are ws's
// optional native helpers, which it requires inside a try/catch.
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = join(root, 'packages', 'core');
const cliDir = join(root, 'packages', 'cli');

/** Where Node's SEA support looks for the injected blob. */
export const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * Required inside a try/catch by their one user, which runs without them: ws's
 * native speed-ups, and node-fetch's charset converter (openai's transport).
 */
const OPTIONAL_REQUIRES = ['bufferutil', 'utf-8-validate', 'encoding'];

const TARGETS = { darwin: ['arm64', 'x64'], linux: ['arm64', 'x64'] };

/**
 * Why `version` cannot be embedded, or undefined. The binary is this Node, and
 * the release ships 22.x at 22.17 or later (ADR-0065): another line would ship
 * a runtime the binary was never tried on.
 */
export function nodeVersionProblem(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if (major === 22 && minor >= 17) return undefined;
  return `The binary embeds the Node that builds it, which must be 22.x at 22.17 or later; this is ${version}.`;
}

/** The release archive's name for a build on `platform`/`arch`. */
export function archiveName(version, platform, arch) {
  if (!TARGETS[platform]?.includes(arch)) {
    throw new Error(`No standalone binary is built for ${platform}-${arch}; the targets are darwin and linux, arm64 and x64.`);
  }
  return `ordewell-${version}-${platform}-${arch}.tar.gz`;
}

/** Every file under core's skills/ and docker/, relative to core, `/`-separated whatever the OS. */
export function runtimeFiles(fromCore) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(fromCore, path).split(sep).join('/'));
    }
  };
  for (const top of ['skills', 'docker']) walk(join(fromCore, top));
  return files.sort();
}

/** The `runtime/manifest.json` asset: the version the binary reports, and the files embedded beside it. */
export function runtimeManifest(version, files) {
  return { version, files };
}

/**
 * The `--experimental-sea-config` input. The code cache and the snapshot stay
 * off: both are V8 data tied to the exact build, and neither has been shown
 * safe with this bundle, so the binary starts the plain way.
 */
export function seaConfig({ main, output, manifest, coreDir: fromCore, files }) {
  const assets = { 'runtime/manifest.json': manifest };
  for (const file of files) assets[`runtime/${file}`] = join(fromCore, ...file.split('/'));
  return { main, output, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets };
}

/** postject's options: Mach-O keeps the blob in a segment of its own. */
export function injectOptions(platform) {
  return platform === 'darwin' ? { sentinelFuse: SENTINEL_FUSE, machoSegmentName: 'NODE_SEA' } : { sentinelFuse: SENTINEL_FUSE };
}

/**
 * The `codesign` arguments that re-sign `binary` once postject has broken
 * Node's signature. A Developer ID signature needs the hardened runtime and a
 * secure timestamp for notarization, and the runtime then needs the JIT
 * entitlements; an ad hoc one is what lets an arm64 Mac run it at all.
 */
export function codesignArgs(binary, { identity, entitlements }) {
  if (!identity) return ['--sign', '-', '--force', binary];
  return ['--sign', identity, '--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, binary];
}

/** `--out <dir>` and `--sign <identity>`, the identity defaulting to ORDEWELL_SEA_SIGN_IDENTITY. */
export function parseBuildArgs(argv, env, cwd) {
  const options = { out: join(cwd, 'dist-sea'), identity: env.ORDEWELL_SEA_SIGN_IDENTITY || undefined };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name !== '--out' && name !== '--sign') throw new Error(`Unknown argument ${name}; the build takes --out <dir> and --sign <identity>.`);
    const value = argv[++i];
    if (!value) throw new Error(`${name} needs a value.`);
    if (name === '--out') options.out = resolve(cwd, value);
    else options.identity = value;
  }
  return options;
}

/**
 * What the bundle would load from disk at run time, which a SEA cannot: an
 * import esbuild left external (its metafile's `imports` of the output) naming
 * neither a built-in nor an optional helper. A text scan cannot tell these from
 * the `require("...")` strings ajv generates code with. A `require.resolve`
 * loads nothing: the one there is finds the npm layout's server file, which
 * the binary never looks for.
 */
export function unloadableImports(imports) {
  const builtins = new Set(builtinModules);
  const names = imports.filter((entry) => entry.external && entry.kind !== 'require-resolve').map((entry) => entry.path);
  return [...new Set(names)]
    .filter((name) => !name.startsWith('node:') && !builtins.has(name) && !OPTIONAL_REQUIRES.includes(name))
    .sort();
}

/** A gzipped ustar archive holding one regular file, `name`, at its root. */
export function tarGz(name, data, mode, mtime = Math.floor(Date.now() / 1000)) {
  const header = Buffer.alloc(512);
  const put = (text, offset) => header.write(text, offset, 'latin1');
  const octal = (value, width) => value.toString(8).padStart(width - 1, '0');
  put(name, 0);
  put(octal(mode, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(data.length, 12), 124);
  put(octal(mtime, 12), 136);
  put('        ', 148);
  put('0', 156);
  put('ustar\0', 257);
  put('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(`${octal(sum, 7)}\0`, 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]), { level: 9 });
}

function run(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} exited with ${result.status}`);
}

async function bundle(outfile) {
  const esbuild = await import('esbuild');
  const { createRequire } = await import('node:module');
  const requireFromCli = createRequire(join(cliDir, 'package.json'));
  const result = await esbuild.build({
    entryPoints: [join(cliDir, 'src', 'sea.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    tsconfig: join(cliDir, 'tsconfig.json'),
    external: OPTIONAL_REQUIRES,
    // tr46 (node-fetch's URL parser, under openai) requires Node's built-in
    // punycode, whose deprecation warning the binary would print on every
    // run. The npm package of the same code is in the tree; an alias resolves
    // from the working directory, hence the root.
    alias: { punycode: 'punycode/' },
    absWorkingDir: root,
    // ESM-only dependencies read `import.meta.url`, which CJS output blanks. In
    // a SEA `__filename` is the binary's own path, the nearest true answer.
    define: { 'import.meta.url': '__ordewellImportMetaUrl' },
    banner: { js: 'var __ordewellImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    legalComments: 'eof',
    logLevel: 'warning',
    metafile: true,
    plugins: [{
      // A plain `import` would pick core's ESM build by its `import`
      // condition; the CJS one is what the npm CLI runs and what core's own
      // build shapes for CommonJS.
      name: 'core-from-dist',
      setup(build) {
        build.onResolve({ filter: /^@ordewell\/core(\/.*)?$/ }, (args) => ({ path: requireFromCli.resolve(args.path) }));
      },
    }],
  });
  if (result.errors.length > 0) throw new Error('esbuild failed');
  const unloadable = unloadableImports(Object.values(result.metafile.outputs).flatMap((output) => output.imports));
  if (unloadable.length > 0) throw new Error(`The bundle would require from disk, which a SEA cannot: ${unloadable.join(', ')}`);
}

async function build(argv, env) {
  const problem = nodeVersionProblem(process.version);
  if (problem) throw new Error(problem);
  const { out, identity } = parseBuildArgs(argv, env, process.cwd());
  const { version } = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
  const name = archiveName(version, process.platform, process.arch);
  if (!existsSync(join(coreDir, 'dist', 'index.js'))) {
    throw new Error('packages/core/dist is missing: run `npm run build -w packages/core` first.');
  }

  const target = `${process.platform}-${process.arch}`;
  const work = join(out, 'work', target);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const main = join(work, 'sea.cjs');
  await bundle(main);

  const files = runtimeFiles(coreDir);
  const manifest = join(work, 'manifest.json');
  writeFileSync(manifest, `${JSON.stringify(runtimeManifest(version, files), null, 2)}\n`);
  const blob = join(work, 'sea-prep.blob');
  const config = join(work, 'sea-config.json');
  writeFileSync(config, `${JSON.stringify(seaConfig({ main, output: blob, manifest, coreDir, files }), null, 2)}\n`);
  run(process.execPath, ['--experimental-sea-config', config]);

  const binDir = join(out, target);
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, 'ordewell');
  rmSync(binary, { force: true });
  copyFileSync(process.execPath, binary);
  chmodSync(binary, 0o755);
  if (process.platform === 'darwin') run('codesign', ['--remove-signature', binary]);
  const { inject } = (await import('postject')).default;
  await inject(binary, 'NODE_SEA_BLOB', readFileSync(blob), injectOptions(process.platform));
  if (process.platform === 'darwin') {
    run('codesign', codesignArgs(binary, { identity, entitlements: join(root, 'packaging', 'sea', 'entitlements.plist') }));
  }

  const archive = join(out, name);
  writeFileSync(archive, tarGz('ordewell', readFileSync(binary), 0o755));
  console.log(`archive: ${archive}`);
  console.log(`binary:  ${binary}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  build(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
