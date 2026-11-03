import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ICNS_TYPES,
  ICO_SIZES,
  encodeIco,
  encodeIcns,
  encodePng,
} from '../packages/desktop/scripts/app-icon.mjs';
import { builderArgs, macSigningArgs, signingEnv } from '../packages/desktop/scripts/package.mjs';

describe('signingEnv', () => {
  it('turns identity discovery off when no identity is configured, so an unsigned build cannot fail on a missing one', () => {
    assert.equal(signingEnv({ PATH: 'p' }).CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  });

  it('leaves the environment alone when CSC_LINK or CSC_NAME names an identity', () => {
    const link = { CSC_LINK: 'file.p12' };
    const name = { CSC_NAME: 'Developer ID' };
    assert.equal(signingEnv(link), link);
    assert.equal(signingEnv(name), name);
  });
});

describe('macSigningArgs', () => {
  it('signs ad hoc on macOS without an identity, so the fused binary still launches on arm64', () => {
    assert.deepEqual(macSigningArgs({}, 'darwin'), ['--config.mac.identity=-', '--config.mac.hardenedRuntime=false']);
  });

  it('does nothing with an identity, or off macOS', () => {
    assert.deepEqual(macSigningArgs({ CSC_LINK: 'x' }, 'darwin'), []);
    assert.deepEqual(macSigningArgs({}, 'win32'), []);
    assert.deepEqual(macSigningArgs({}, 'linux'), []);
  });
});

describe('builderArgs', () => {
  it('targets the current OS and never publishes', () => {
    assert.deepEqual(builderArgs([], 'linux'), ['--linux', '--publish', 'never']);
    assert.deepEqual(builderArgs([], 'win32'), ['--win', '--publish', 'never']);
    assert.deepEqual(builderArgs([], 'darwin'), ['--mac', '--publish', 'never', '--config.mac.identity=-', '--config.mac.hardenedRuntime=false']);
  });

  it('puts --dir before the rest and lets an explicit OS flag win', () => {
    assert.deepEqual(builderArgs(['--dir'], 'linux'), ['--linux', '--dir', '--publish', 'never']);
    assert.deepEqual(builderArgs(['--mac', '--x64'], 'linux'), ['--publish', 'never', '--mac', '--x64']);
  });

  it('refuses a platform the app is not packaged on', () => {
    assert.throws(() => builderArgs([], 'freebsd'), /not packaged on freebsd/);
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
