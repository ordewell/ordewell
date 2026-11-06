import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fakeSea } from '@ordewell/core/testing';

describe('serverVersion', () => {
  // A fresh module each time, so the cache another test filled does not answer.
  beforeEach(() => { vi.resetModules(); });

  it('finds the package manifest from a bundle directory, past an unrelated one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-web-version-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ordewell/web', version: '9.8.7' }));
      const bundle = join(root, 'dist', 'server');
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
      const { serverVersion } = await import('../serverVersion');
      expect(serverVersion(bundle)).toBe('9.8.7');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says unknown when no manifest names the package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-web-version-'));
    try {
      const { serverVersion } = await import('../serverVersion');
      expect(serverVersion(root)).toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is the version the standalone binary embedded, with no manifest to walk up to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-web-version-'));
    try {
      const { serverVersion } = await import('../serverVersion');
      expect(serverVersion(root, { sea: fakeSea('4.5.6') })).toBe('4.5.6');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks to the manifest as before outside a binary', async () => {
    const { serverVersion } = await import('../serverVersion');
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(serverVersion(undefined, { sea: null })).toBe(pkg.version);
  });
});
