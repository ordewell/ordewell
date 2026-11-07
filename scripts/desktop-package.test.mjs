import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ICNS_TYPES,
  ICO_SIZES,
  encodeIco,
  encodeIcns,
  encodePng,
} from '../packages/desktop/scripts/app-icon.mjs';
import {
  appleApiKeyFile,
  builderArgs,
  builderEnv,
  publisherNames,
  releasePlan,
  signingArgs,
  signingManifest,
  withoutSigning,
} from '../packages/desktop/scripts/package.mjs';
import { codeSignTool, failed, redact, sign, signArgs } from '../packages/desktop/scripts/esigner-sign.mjs';

const MAC_CERT = { CSC_LINK: 'base64p12', CSC_KEY_PASSWORD: 'p12pass' };
const API_KEY = { APPLE_API_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', APPLE_API_KEY_ID: 'KEYID123', APPLE_API_ISSUER: 'issuer-uuid' };
const APPLE_ID = { APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh', APPLE_TEAM_ID: 'TEAM123' };
const AZURE = {
  AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'ordewell',
  AZURE_CERTIFICATE_PROFILE: 'public',
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'secret',
  WIN_PUBLISHER_NAME: 'Ordewell',
};
const WIN_CERT = { WIN_CSC_LINK: 'base64pfx', WIN_CSC_KEY_PASSWORD: 'pfxpass' };
const ESIGNER = { ES_USERNAME: 'esuser', ES_PASSWORD: 'es-pass', ES_CREDENTIAL_ID: 'cred-id', ES_TOTP_SECRET: 'totp-secret' };
const ESIGNER_ROUTE = { ...ESIGNER, WIN_PUBLISHER_NAME: 'Ada Lovelace' };

describe('releasePlan on macOS', () => {
  it('is the ad hoc build, updates off, with no secrets', () => {
    assert.deepEqual(releasePlan({ PATH: 'p' }, 'darwin'), {
      platform: 'darwin', signing: null, notarization: null, publisherNames: [], azure: null, autoUpdate: false, notes: [],
    });
  });

  it('signs with a Developer ID certificate, but keeps updates off until it is also notarized', () => {
    const plan = releasePlan(MAC_CERT, 'darwin');
    assert.equal(plan.signing, 'certificate');
    assert.equal(plan.notarization, null);
    assert.equal(plan.autoUpdate, false);
  });

  it('signs with a keychain identity named by CSC_NAME, for a maintainer building locally', () => {
    assert.equal(releasePlan({ CSC_NAME: 'Developer ID Application: X' }, 'darwin').signing, 'keychain');
  });

  it('notarizes with an App Store Connect API key or an Apple ID, and only then turns updates on', () => {
    const viaKey = releasePlan({ ...MAC_CERT, ...API_KEY }, 'darwin');
    assert.equal(viaKey.notarization, 'api-key');
    assert.equal(viaKey.autoUpdate, true);
    const viaId = releasePlan({ ...MAC_CERT, ...APPLE_ID }, 'darwin');
    assert.equal(viaId.notarization, 'apple-id');
    assert.equal(viaId.autoUpdate, true);
  });

  it('prefers the API key when both notarization credentials are complete, and says so', () => {
    const plan = releasePlan({ ...MAC_CERT, ...API_KEY, ...APPLE_ID }, 'darwin');
    assert.equal(plan.notarization, 'api-key');
    assert.match(plan.notes.join('\n'), /API key/);
  });

  it('refuses half a certificate, half a notarization credential, or notarization without an identity', () => {
    assert.throws(() => releasePlan({ CSC_LINK: 'x' }, 'darwin'), /CSC_KEY_PASSWORD/);
    assert.throws(() => releasePlan({ CSC_KEY_PASSWORD: 'x' }, 'darwin'), /CSC_LINK/);
    assert.throws(() => releasePlan({ ...MAC_CERT, APPLE_API_KEY: 'k' }, 'darwin'), /APPLE_API_KEY_ID.*APPLE_API_ISSUER|APPLE_API_ISSUER.*APPLE_API_KEY_ID/s);
    assert.throws(() => releasePlan({ ...MAC_CERT, APPLE_ID: 'a' }, 'darwin'), /APPLE_APP_SPECIFIC_PASSWORD/);
    assert.throws(() => releasePlan({ ...API_KEY }, 'darwin'), /signing identity/);
  });

  it('lists every problem at once', () => {
    assert.throws(() => releasePlan({ CSC_LINK: 'x', APPLE_ID: 'a' }, 'darwin'), (error) => {
      assert.match(error.message, /CSC_KEY_PASSWORD/);
      assert.match(error.message, /APPLE_TEAM_ID/);
      return true;
    });
  });

  it('ignores the Windows secrets', () => {
    assert.equal(releasePlan({ ...AZURE, ...WIN_CERT }, 'darwin').signing, null);
  });
});

describe('releasePlan on Windows', () => {
  it('is unsigned, updates off, with no secrets, and ignores the macOS certificate', () => {
    const plan = releasePlan(MAC_CERT, 'win32');
    assert.equal(plan.signing, null);
    assert.equal(plan.autoUpdate, false);
  });

  it('signs through Azure Artifact Signing with a publisher name, and turns updates on', () => {
    const plan = releasePlan(AZURE, 'win32');
    assert.equal(plan.signing, 'azure');
    assert.deepEqual(plan.azure, { endpoint: AZURE.AZURE_SIGNING_ENDPOINT, account: 'ordewell', profile: 'public' });
    assert.deepEqual(plan.publisherNames, ['Ordewell']);
    assert.equal(plan.autoUpdate, true);
  });

  it('signs with a certificate file, the publisher name optional because the certificate carries it', () => {
    const plan = releasePlan(WIN_CERT, 'win32');
    assert.equal(plan.signing, 'certificate');
    assert.deepEqual(plan.publisherNames, []);
    assert.equal(plan.autoUpdate, true);
    assert.deepEqual(releasePlan({ ...WIN_CERT, WIN_PUBLISHER_NAME: 'Ordewell' }, 'win32').publisherNames, ['Ordewell']);
  });

  it('prefers Azure when both routes are configured, and says so', () => {
    const plan = releasePlan({ ...AZURE, ...WIN_CERT }, 'win32');
    assert.equal(plan.signing, 'azure');
    assert.match(plan.notes.join('\n'), /Azure/);
  });

  it('refuses an Azure route missing a secret or the publisher name, and half a certificate', () => {
    const noSecret = { ...AZURE };
    delete noSecret.AZURE_CLIENT_SECRET;
    assert.throws(() => releasePlan(noSecret, 'win32'), /AZURE_CLIENT_SECRET/);
    const noName = { ...AZURE };
    delete noName.WIN_PUBLISHER_NAME;
    assert.throws(() => releasePlan(noName, 'win32'), /WIN_PUBLISHER_NAME/);
    assert.throws(() => releasePlan({ AZURE_SIGNING_ENDPOINT: 'e' }, 'win32'), /AZURE_SIGNING_ACCOUNT/);
    assert.throws(() => releasePlan({ WIN_CSC_LINK: 'x' }, 'win32'), /WIN_CSC_KEY_PASSWORD/);
  });

  it('signs through SSL.com eSigner with a publisher name, and turns updates on', () => {
    const plan = releasePlan(ESIGNER_ROUTE, 'win32');
    assert.equal(plan.signing, 'esigner');
    assert.deepEqual(plan.publisherNames, [ESIGNER_ROUTE.WIN_PUBLISHER_NAME]);
    assert.equal(plan.azure, null);
    assert.equal(plan.autoUpdate, true);
  });

  it('refuses eSigner without the publisher name, since electron-updater would then check no update, and half its secrets', () => {
    assert.throws(() => releasePlan(ESIGNER, 'win32'), /SSL\.com eSigner is missing WIN_PUBLISHER_NAME/);
    const noTotp = { ...ESIGNER_ROUTE };
    delete noTotp.ES_TOTP_SECRET;
    assert.throws(() => releasePlan(noTotp, 'win32'), /ES_TOTP_SECRET is missing/);
    assert.throws(() => releasePlan({ ES_USERNAME: 'u' }, 'win32'), /ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET are missing/);
  });

  it('prefers Azure, then eSigner, then the certificate file, and names every route it passed over', () => {
    const all = releasePlan({ ...AZURE, ...ESIGNER_ROUTE, ...WIN_CERT }, 'win32');
    assert.equal(all.signing, 'azure');
    assert.match(all.notes.join('\n'), /All three .*Azure Artifact Signing, SSL\.com eSigner, the certificate file/);
    const two = releasePlan({ ...ESIGNER_ROUTE, ...WIN_CERT }, 'win32');
    assert.equal(two.signing, 'esigner');
    assert.match(two.notes.join('\n'), /Both .*signing with SSL\.com eSigner/);
  });

  it('builds unsigned with updates off when no route is set, eSigner included', () => {
    assert.deepEqual(releasePlan({ WIN_PUBLISHER_NAME: 'Ordewell' }, 'win32'), {
      platform: 'win32', signing: null, notarization: null, publisherNames: [], azure: null, autoUpdate: false, notes: [],
    });
  });

  it('does not take Azure credentials alone, which a developer machine may hold for other reasons, as a route', () => {
    assert.equal(releasePlan({ AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' }, 'win32').signing, null);
  });
});

describe('releasePlan on Linux', () => {
  it('is never signed, so neither the AppImage nor the deb updates itself', () => {
    const plan = releasePlan({ ...MAC_CERT, ...API_KEY, ...AZURE, ...WIN_CERT, ...ESIGNER_ROUTE }, 'linux');
    assert.equal(plan.signing, null);
    assert.equal(plan.autoUpdate, false);
  });
});

describe('builderEnv', () => {
  const everything = { PATH: 'p', ...MAC_CERT, CSC_NAME: 'n', ...API_KEY, ...APPLE_ID, APPLE_KEYCHAIN_PROFILE: 'kp', ...AZURE, ...WIN_CERT, ...ESIGNER };
  const signingKeys = (env) => Object.keys(env).filter((key) => /^(CSC_|WIN_CSC_|APPLE_|AZURE_|ES_)/.test(key)).sort();

  it('turns identity discovery off for an unsigned build and passes no signing secret on', () => {
    const env = builderEnv(everything, releasePlan({}, 'darwin'));
    assert.equal(env.PATH, 'p');
    assert.deepEqual(signingKeys(env), ['CSC_IDENTITY_AUTO_DISCOVERY']);
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  });

  it('passes only the macOS certificate and the chosen notarization credential, the key as a file path', () => {
    const env = builderEnv(everything, releasePlan({ ...MAC_CERT, ...API_KEY }, 'darwin'), { apiKeyPath: '/tmp/k/AuthKey_KEYID123.p8' });
    assert.deepEqual(signingKeys(env), ['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'CSC_KEY_PASSWORD', 'CSC_LINK']);
    assert.equal(env.APPLE_API_KEY, '/tmp/k/AuthKey_KEYID123.p8');
    const viaId = builderEnv(everything, releasePlan({ ...MAC_CERT, ...APPLE_ID }, 'darwin'));
    assert.deepEqual(signingKeys(viaId), ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID', 'CSC_KEY_PASSWORD', 'CSC_LINK']);
  });

  it('passes CSC_NAME alone for a keychain identity', () => {
    assert.deepEqual(signingKeys(builderEnv(everything, releasePlan({ CSC_NAME: 'n' }, 'darwin'))), ['CSC_NAME']);
  });

  it('never lets electron-builder fall back from WIN_CSC_LINK to the macOS CSC_LINK on Windows', () => {
    assert.deepEqual(signingKeys(builderEnv(everything, releasePlan(WIN_CERT, 'win32'))), ['WIN_CSC_KEY_PASSWORD', 'WIN_CSC_LINK']);
    assert.deepEqual(signingKeys(builderEnv(everything, releasePlan(AZURE, 'win32'))), ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID']);
  });

  it('passes the eSigner secrets only to an eSigner build', () => {
    assert.deepEqual(signingKeys(builderEnv(everything, releasePlan(ESIGNER_ROUTE, 'win32'))), ['ES_CREDENTIAL_ID', 'ES_PASSWORD', 'ES_TOTP_SECRET', 'ES_USERNAME']);
    assert.deepEqual(signingKeys(builderEnv(everything, releasePlan({}, 'win32'))), ['CSC_IDENTITY_AUTO_DISCOVERY']);
  });
});

describe('withoutSigning', () => {
  it('drops every signing secret and keeps the rest, for the steps that build rather than sign', () => {
    const env = withoutSigning({ PATH: 'p', ...MAC_CERT, ...API_KEY, ...APPLE_ID, ...AZURE, ...WIN_CERT, ...ESIGNER, CSC_NAME: 'n' });
    assert.deepEqual(env, { PATH: 'p' });
  });
});

describe('signingArgs', () => {
  it('signs ad hoc on macOS without an identity, as before, so the fused binary still launches on arm64', () => {
    assert.deepEqual(signingArgs(releasePlan({}, 'darwin')), ['--config.mac.identity=-', '--config.mac.hardenedRuntime=false']);
  });

  it('adds nothing to an unsigned Windows or Linux build', () => {
    assert.deepEqual(signingArgs(releasePlan({}, 'win32')), []);
    assert.deepEqual(signingArgs(releasePlan({}, 'linux')), []);
  });

  it('forces signing with an identity, and turns notarization on only when it has credentials', () => {
    assert.deepEqual(signingArgs(releasePlan(MAC_CERT, 'darwin')), ['--config.forceCodeSigning=true']);
    assert.deepEqual(signingArgs(releasePlan({ ...MAC_CERT, ...APPLE_ID }, 'darwin')), ['--config.forceCodeSigning=true', '--config.mac.notarize=true']);
  });

  it('configures Azure Artifact Signing with its publisher name', () => {
    assert.deepEqual(signingArgs(releasePlan(AZURE, 'win32')), [
      '--config.forceCodeSigning=true',
      `--config.win.azureSignOptions.endpoint=${AZURE.AZURE_SIGNING_ENDPOINT}`,
      '--config.win.azureSignOptions.codeSigningAccountName=ordewell',
      '--config.win.azureSignOptions.certificateProfileName=public',
      '--config.win.azureSignOptions.publisherName=Ordewell',
    ]);
  });

  it('signs eSigner through the hook, and records the publisher electron-updater checks', () => {
    const args = signingArgs(releasePlan(ESIGNER_ROUTE, 'win32'));
    assert.equal(args[0], '--config.forceCodeSigning=true');
    const hook = args.find((arg) => arg.startsWith('--config.win.signtoolOptions.sign='));
    assert.ok(hook && existsSync(hook.slice(hook.indexOf('=') + 1)), `the hook is not a file: ${hook}`);
    assert.match(hook, /esigner-sign\.mjs$/);
    assert.ok(args.includes(`--config.win.signtoolOptions.publisherName=${ESIGNER_ROUTE.WIN_PUBLISHER_NAME}`));
    assert.ok(!args.some((arg) => Object.values(ESIGNER).some((value) => arg.includes(value))), 'no credential on the command line');
  });

  it('sets the signtool publisher name only when one is given', () => {
    assert.deepEqual(signingArgs(releasePlan(WIN_CERT, 'win32')), ['--config.forceCodeSigning=true']);
    assert.deepEqual(signingArgs(releasePlan({ ...WIN_CERT, WIN_PUBLISHER_NAME: 'Ordewell' }, 'win32')), [
      '--config.forceCodeSigning=true',
      '--config.win.signtoolOptions.publisherName=Ordewell',
    ]);
  });
});

describe('builderArgs', () => {
  it('targets the current OS and never publishes', () => {
    assert.deepEqual(builderArgs([], 'linux'), ['--linux', '--publish', 'never']);
    assert.deepEqual(builderArgs([], 'win32'), ['--win', '--publish', 'never']);
    assert.deepEqual(builderArgs([], 'darwin'), ['--mac', '--publish', 'never', '--config.mac.identity=-', '--config.mac.hardenedRuntime=false']);
  });

  it('applies the plan it is given', () => {
    assert.deepEqual(builderArgs([], 'darwin', releasePlan(MAC_CERT, 'darwin')), ['--mac', '--publish', 'never', '--config.forceCodeSigning=true']);
  });

  it('puts --dir before the rest and lets an explicit OS flag win', () => {
    assert.deepEqual(builderArgs(['--dir'], 'linux'), ['--linux', '--dir', '--publish', 'never']);
    assert.deepEqual(builderArgs(['--mac', '--x64'], 'linux'), ['--publish', 'never', '--mac', '--x64']);
  });

  it('refuses a platform the app is not packaged on', () => {
    assert.throws(() => builderArgs([], 'freebsd'), /not packaged on freebsd/);
  });
});

describe('appleApiKeyFile', () => {
  it('writes the key contents to AuthKey_<id>.p8, readable only by its owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ow-key-'));
    const file = appleApiKeyFile(API_KEY.APPLE_API_KEY, 'KEYID123', dir);
    assert.equal(file, join(dir, 'AuthKey_KEYID123.p8'));
    assert.equal(readFileSync(file, 'utf8'), API_KEY.APPLE_API_KEY);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('takes a value that is not a key as the path to one, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ow-key-'));
    assert.equal(appleApiKeyFile('/keys/AuthKey_X.p8', 'X', dir), '/keys/AuthKey_X.p8');
    assert.equal(existsSync(join(dir, 'AuthKey_X.p8')), false);
  });
});

describe('signingManifest', () => {
  it('records what the build was, for the package check to hold the artifacts to', () => {
    assert.deepEqual(signingManifest(releasePlan({}, 'darwin')), { platform: 'darwin', signing: null, notarized: false, autoUpdate: false, publisherNames: [] });
    assert.deepEqual(signingManifest(releasePlan({ ...MAC_CERT, ...API_KEY }, 'darwin')), { platform: 'darwin', signing: 'certificate', notarized: true, autoUpdate: true, publisherNames: [] });
    assert.deepEqual(signingManifest(releasePlan(AZURE, 'win32')), { platform: 'win32', signing: 'azure', notarized: false, autoUpdate: true, publisherNames: ['Ordewell'] });
  });
});

describe('the eSigner signing hook', () => {
  const toolDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'codesigntool-'));
    mkdirSync(join(dir, 'jdk-11.0.2', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'jar'));
    writeFileSync(join(dir, 'jar', 'code_sign_tool-1.3.2.jar'), '');
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'run.log'), 'log');
    return dir;
  };

  it('finds the java and jar CodeSignTool unpacks, and says how to fix a missing one', () => {
    const dir = toolDir();
    const { java, jar } = codeSignTool(dir);
    assert.equal(jar, join(dir, 'jar', 'code_sign_tool-1.3.2.jar'));
    assert.match(java, /jdk-11\.0\.2[\\/]bin[\\/]java/);
    assert.throws(() => codeSignTool(undefined), /CODE_SIGN_TOOL_PATH/);
    assert.throws(() => codeSignTool(mkdtempSync(join(tmpdir(), 'empty-'))), /code_sign_tool-\*\.jar/);
  });

  it('signs the file in place with every credential, and no prompt', () => {
    const args = signArgs('/t/jar/cst.jar', 'C:\\out\\Ordewell.exe', ESIGNER);
    assert.deepEqual(args, [
      '-jar', '/t/jar/cst.jar', 'sign',
      '-username=esuser', '-password=es-pass', '-credential_id=cred-id', '-totp_secret=totp-secret',
      '-input_file_path=C:\\out\\Ordewell.exe', '-override=true',
    ]);
  });

  it('cuts every credential out of what it shows', () => {
    assert.equal(redact('user esuser pass es-pass totp totp-secret id cred-id', ESIGNER), 'user <ES_USERNAME> pass <ES_PASSWORD> totp <ES_TOTP_SECRET> id <ES_CREDENTIAL_ID>');
  });

  it('counts an exit 0 that reports an error as a failure, as SSL.com\'s own action does', () => {
    assert.equal(failed({ status: 0, stdout: 'Code signed successfully: x.exe', stderr: '' }), false);
    assert.equal(failed({ status: 0, stdout: 'Error: invalid credentials', stderr: '' }), true);
    assert.equal(failed({ status: 0, stdout: '', stderr: 'java.lang.NullPointerException' }), true);
    assert.equal(failed({ status: 1, stdout: '', stderr: '' }), true);
    assert.equal(failed({ status: null, error: new Error('ETIMEDOUT') }), true);
  });

  it('runs CodeSignTool with no shell, prints its output without a credential, and removes its logs', async (t) => {
    const dir = toolDir();
    const calls = [];
    const logged = [];
    t.mock.method(console, 'log', (line) => logged.push(line));
    await sign({ path: 'app.exe' }, {
      env: { ...ESIGNER, CODE_SIGN_TOOL_PATH: dir },
      run: (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout: 'signed for esuser with es-pass', stderr: '' }; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cwd, dir);
    assert.equal(calls[0].options.shell, undefined);
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(logged, ['signed for <ES_USERNAME> with <ES_PASSWORD>']);
    assert.equal(existsSync(join(dir, 'logs')), false);
  });

  it('signs once per file: the SHA-1 round electron-builder offers by default is skipped', async () => {
    const calls = [];
    const run = (file, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
    const env = { ...ESIGNER, CODE_SIGN_TOOL_PATH: toolDir() };
    await sign({ path: 'app.exe', hash: 'sha1' }, { env, run });
    assert.equal(calls.length, 0);
    await sign({ path: 'app.exe', hash: 'sha256' }, { env, run });
    assert.equal(calls.length, 1);
  });

  it('fails the build, naming no credential, when CodeSignTool does', async (t) => {
    const dir = toolDir();
    t.mock.method(console, 'log', () => {});
    await assert.rejects(
      sign({ path: 'app.exe' }, { env: { ...ESIGNER, CODE_SIGN_TOOL_PATH: dir }, run: () => ({ status: 0, stdout: 'Error: es-pass rejected', stderr: '' }) }),
      (error) => /could not sign app\.exe/.test(error.message) && !error.message.includes('es-pass'),
    );
  });
});

describe('the icon encoders', () => {
  const pixels = (size) => new Float32Array(size * size * 4).fill(255);
  const sizes = [...new Set([...ICNS_TYPES.map(([, s]) => s), ...ICO_SIZES])];
  const pngs = new Map(sizes.map((size) => [size, encodePng(pixels(size), size)]));

  it('writes a PNG whose header carries its size', () => {
    const png = pngs.get(32);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), 32);
    assert.equal(png.readUInt32BE(20), 32);
  });

  it('writes an ICNS whose declared length is the file and whose entries are the listed types', () => {
    const icns = encodeIcns(pngs);
    assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
    assert.equal(icns.readUInt32BE(4), icns.length);
    const types = [];
    for (let offset = 8; offset < icns.length; offset += icns.readUInt32BE(offset + 4)) types.push(icns.subarray(offset, offset + 4).toString('ascii'));
    assert.deepEqual(types, ICNS_TYPES.map(([type]) => type));
  });

  it('writes an ICO whose directory points at each PNG, 256 stored as 0', () => {
    const ico = encodeIco(pngs);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
    ICO_SIZES.forEach((size, i) => {
      const entry = 6 + 16 * i;
      assert.equal(ico[entry], size === 256 ? 0 : size);
      const offset = ico.readUInt32LE(entry + 12);
      assert.equal(ico.subarray(offset, offset + 4).toString('latin1'), '\x89PNG');
      assert.equal(ico.readUInt32LE(entry + 8), pngs.get(size).length);
    });
  });
});

describe('WIN_PUBLISHER_NAME with several names', () => {
  it('splits on | and trims every entry, dropping empty ones', () => {
    assert.deepEqual(publisherNames('Ordewell'), ['Ordewell']);
    assert.deepEqual(publisherNames('Ada Lovelace|Acme, Inc.'), ['Ada Lovelace', 'Acme, Inc.']);
    assert.deepEqual(publisherNames('  Ada Lovelace | Acme, Inc. |'), ['Ada Lovelace', 'Acme, Inc.']);
    assert.deepEqual(publisherNames('||  | A ||B'), ['A', 'B']);
    assert.deepEqual(publisherNames('Ada;Lovelace, Jr'), ['Ada;Lovelace, Jr'], 'a comma or a semicolon belongs to a name');
    assert.deepEqual(publisherNames(undefined), []);
    assert.deepEqual(publisherNames(' | '), []);
  });

  it('plans the names as a list, only for a signed build', () => {
    assert.deepEqual(releasePlan({ ...AZURE, WIN_PUBLISHER_NAME: ' Ada Lovelace | Acme, Inc. |' }, 'win32').publisherNames, ['Ada Lovelace', 'Acme, Inc.']);
    assert.deepEqual(releasePlan({ ...WIN_CERT, WIN_PUBLISHER_NAME: 'Ordewell' }, 'win32').publisherNames, ['Ordewell']);
    assert.deepEqual(releasePlan(WIN_CERT, 'win32').publisherNames, []);
    // A name with nothing to sign never turns anything on.
    const unsigned = releasePlan({ WIN_PUBLISHER_NAME: 'A|B' }, 'win32');
    assert.deepEqual([unsigned.publisherNames, unsigned.signing, unsigned.autoUpdate], [[], null, false]);
    assert.equal(releasePlan({ WIN_PUBLISHER_NAME: 'A|B' }, 'linux').autoUpdate, false);
  });

  it('refuses a variable that holds no name, on every route', () => {
    for (const env of [{ ...AZURE, WIN_PUBLISHER_NAME: ' | ' }, { ...ESIGNER, WIN_PUBLISHER_NAME: '|' }, { ...WIN_CERT, WIN_PUBLISHER_NAME: ' ' }]) {
      assert.throws(() => releasePlan(env, 'win32'), /WIN_PUBLISHER_NAME holds no name/);
    }
    assert.throws(() => releasePlan({ ...ESIGNER, WIN_PUBLISHER_NAME: ' | ' }, 'win32'), /holds no name/);
  });

  it('records the names in the signing manifest', () => {
    const manifest = signingManifest(releasePlan({ ...ESIGNER, WIN_PUBLISHER_NAME: 'A | B' }, 'win32'));
    assert.deepEqual(manifest.publisherNames, ['A', 'B']);
    assert.deepEqual(signingManifest(releasePlan({}, 'darwin')).publisherNames, []);
  });

  it('repeats the flag for several names, and sends Azure\'s list through the publish config', () => {
    const several = { WIN_PUBLISHER_NAME: ' Ada Lovelace | Acme, Inc. |' };
    assert.deepEqual(signingArgs(releasePlan({ ...WIN_CERT, ...several }, 'win32')), [
      '--config.forceCodeSigning=true',
      '--config.win.signtoolOptions.publisherName=Ada Lovelace',
      '--config.win.signtoolOptions.publisherName=Acme, Inc.',
    ]);
    const azure = signingArgs(releasePlan({ ...AZURE, ...several }, 'win32'));
    assert.ok(azure.includes('--config.win.azureSignOptions.publisherName=Ada Lovelace'));
    assert.deepEqual(azure.filter((arg) => arg.startsWith('--config.publish.')), [
      '--config.publish.publisherName=Ada Lovelace',
      '--config.publish.publisherName=Acme, Inc.',
    ]);
    assert.ok(!signingArgs(releasePlan(AZURE, 'win32')).some((arg) => arg.startsWith('--config.publish.')), 'one name leaves the publish config alone');
  });
});

// The flags above only matter if electron-builder reads them as intended, so
// they go through its own CLI parsing, config merge and schema validation, and
// out comes the list its updater config would carry (PublishManager takes
// publish.publisherName first, else the signing manager's computed name).
describe('the publisher names electron-builder derives from the flags', () => {
  const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
  const desktop = fileURLToPath(new URL('../packages/desktop/', import.meta.url));
  const asList = (value) => (value == null ? null : [value].flat());

  // builder-util's log writes to process.stdout, where node:test reads this
  // file's messages, and a stray line there crashes the run (test-stdout.test.mjs).
  async function derived(t, env) {
    const { log } = createRequire(require.resolve('app-builder-lib/package.json'))('builder-util');
    t.mock.property(log, 'stream', { write: () => true });
    const { configureBuildCommand, createYargs, normalizeOptions } = require('electron-builder/out/builder.js');
    const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
    const argv = configureBuildCommand(createYargs()).parse(builderArgs(['--win', '--dir'], 'win32', releasePlan(env, 'win32')));
    const config = await getConfig(desktop, null, normalizeOptions(argv).config);
    await validateConfiguration(config, { isEnabled: false, add() {} });
    const { azureSignOptions, signtoolOptions } = config.win ?? {};
    return asList(config.publish.publisherName) ?? asList((azureSignOptions ?? signtoolOptions)?.publisherName);
  }

  for (const [route, env] of [['Azure', AZURE], ['eSigner', ESIGNER], ['a certificate file', WIN_CERT]]) {
    it(`reads one name on ${route} as it always has`, async (t) => {
      assert.deepEqual(await derived(t, { ...env, WIN_PUBLISHER_NAME: 'Ordewell' }), ['Ordewell']);
    });

    it(`reads a list of names on ${route}`, async (t) => {
      assert.deepEqual(await derived(t, { ...env, WIN_PUBLISHER_NAME: ' Ada Lovelace | Acme, Inc. |' }), ['Ada Lovelace', 'Acme, Inc.']);
    });
  }

  it('derives no name from a certificate file without the variable', async (t) => {
    assert.equal(await derived(t, WIN_CERT), null);
  });
});
