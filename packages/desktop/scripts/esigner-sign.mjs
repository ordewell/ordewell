// electron-builder's Windows signing hook for the SSL.com eSigner route
// (ADR-0063 H9). package.mjs names this file in win.signtoolOptions.sign when
// the ES_* secrets are set; electron-builder then calls sign() once for each
// file it would have handed to signtool.
//
// CodeSignTool is SSL.com's signer: a Java program shipped with its own JDK,
// which desktop-build.yml downloads at a pinned checksum and names in
// CODE_SIGN_TOOL_PATH. It takes its credentials only as arguments, so they are
// passed to it directly, with no shell between, and never printed: its output
// is shown with every credential cut out.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ESIGNER } from './package.mjs';

/** Where CodeSignTool's java and jar are under `dir`, found rather than named so a new pinned version needs no edit here. */
export function codeSignTool(dir) {
  if (!dir || !existsSync(dir)) {
    throw new Error('SSL.com eSigner needs CodeSignTool: set CODE_SIGN_TOOL_PATH to the folder it was unpacked into (desktop-build.yml does this on a release).');
  }
  const jdk = readdirSync(dir).find((name) => name.startsWith('jdk'));
  const jarDir = join(dir, 'jar');
  const jar = existsSync(jarDir) ? readdirSync(jarDir).find((name) => /^code_sign_tool-.*\.jar$/.test(name)) : undefined;
  if (!jdk || !jar) throw new Error(`CODE_SIGN_TOOL_PATH (${dir}) does not hold CodeSignTool's jdk and jar/code_sign_tool-*.jar.`);
  return { java: join(dir, jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), jar: join(dir, 'jar', jar) };
}

/** CodeSignTool's arguments to sign `file` in place. */
export function signArgs(jar, file, env) {
  return [
    '-jar', jar, 'sign',
    `-username=${env.ES_USERNAME}`,
    `-password=${env.ES_PASSWORD}`,
    `-credential_id=${env.ES_CREDENTIAL_ID}`,
    // The TOTP secret lets CodeSignTool answer the one-time-password check
    // itself, which is what makes a signing unattended.
    `-totp_secret=${env.ES_TOTP_SECRET}`,
    `-input_file_path=${file}`,
    '-override=true',
  ];
}

/** `text` with each credential replaced, so CodeSignTool's output can be shown. */
export function redact(text, env) {
  let out = text;
  for (const name of ESIGNER) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') out = out.split(value).join(`<${name}>`);
  }
  return out;
}

/**
 * Whether CodeSignTool's run failed. It can exit 0 having signed nothing, so
 * its output is read as well: these are the markers SSL.com's own GitHub
 * action (sslcom/esigner-codesign) treats as a failure.
 */
export function failed(result) {
  if (result.error || result.status !== 0) return true;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return ['Error', 'Exception', 'Missing required option', 'Unmatched argument'].some((marker) => output.includes(marker));
}

export async function sign(configuration, { env = process.env, run = spawnSync } = {}) {
  // electron-builder calls the hook once per hash algorithm, SHA-1 then SHA-256
  // by default. CodeSignTool signs with SHA-256 only, and each call is a signing
  // the eSigner plan counts, so the SHA-1 round is skipped: one call per file.
  // (signingHashAlgorithms cannot say so: its schema wants an array, and one
  // flag on the command line is a string.)
  if (configuration.hash && configuration.hash !== 'sha256') return;
  const dir = env.CODE_SIGN_TOOL_PATH;
  const { java, jar } = codeSignTool(dir);
  const result = run(java, signArgs(jar, configuration.path, env), {
    cwd: dir,
    env: { ...env, CODE_SIGN_TOOL_PATH: dir },
    encoding: 'utf8',
    // Nothing answers a prompt here: a closed stdin ends one instead of hanging the release.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
  const output = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`, env).trim();
  if (output) console.log(output);
  // CodeSignTool keeps a log of each run in its folder; nothing needs it after.
  rmSync(join(dir, 'logs'), { recursive: true, force: true });
  if (failed(result)) {
    const why = result.error ? redact(result.error.message, env) : `exit ${result.status ?? result.signal}`;
    throw new Error(`SSL.com eSigner could not sign ${configuration.path} (${why}).`);
  }
}
