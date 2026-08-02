import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService, getSettingsPath } from '../SettingsService';

function tempSettingsDir() {
  const dir = path.join(os.tmpdir(), `ordewell-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = '.settings-test.json';
  const filePath = path.join(dir, fileName);
  return { dir, filePath };
}

function cleanup(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('SettingsService', () => {
  let service: SettingsService;
  let tempFile: string;
  let tempDir: string;

  beforeEach(() => {
    const t = tempSettingsDir();
    tempFile = t.filePath;
    tempDir = t.dir;
    service = new SettingsService(tempFile);
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('returns defaults when no settings file exists', () => {
    expect(service.getAll()).toEqual({
      grillMe: { enabled: false },
      tdd: { enabled: true },
      prd: { enabled: false },
      review: { enabled: false },
      verification: { enabled: false },
      researchSubagents: { enabled: false },
    });
  });

  it('creates the settings file on first write', () => {
    expect(fs.existsSync(tempFile)).toBe(false);
    service.setGrillMe(true);
    expect(fs.existsSync(tempFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw.grillMe.enabled).toBe(true);
    expect(raw.tdd.enabled).toBe(true);
  });

  it('reads existing settings from file', () => {
    fs.writeFileSync(tempFile, JSON.stringify({
      grillMe: { enabled: true },
      tdd: { enabled: false },
    }));
    const s2 = new SettingsService(tempFile);
    expect(s2.getAll()).toEqual({
      grillMe: { enabled: true },
      tdd: { enabled: false },
      prd: { enabled: false },
      review: { enabled: false },
      verification: { enabled: false },
      researchSubagents: { enabled: false },
    });
  });

  it('picks up a write from another process (mtime-based cache invalidation)', () => {
    service.setModelAllowlist('opencode', ['a']);
    expect(service.getModelAllowlist('opencode')).toEqual(['a']);

    // Simulate another surface (web server / CLI) rewriting the same file.
    const other = new SettingsService(tempFile);
    other.setModelAllowlist('opencode', ['b', 'c']);
    // Force a distinct mtime even on coarse-grained filesystems.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(tempFile, future, future);

    expect(service.getModelAllowlist('opencode')).toEqual(['b', 'c']);
  });

  it('getGrillMe returns the grillMe enabled state', () => {
    expect(service.getGrillMe()).toBe(false);
    service.setGrillMe(true);
    expect(service.getGrillMe()).toBe(true);
  });

  it('getTdd returns the tdd enabled state', () => {
    expect(service.getTdd()).toBe(true);
    service.setTdd(false);
    expect(service.getTdd()).toBe(false);
  });

  it('persists changes to disk', () => {
    service.setTdd(false);
    service.setGrillMe(true);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw).toEqual({
      grillMe: { enabled: true },
      tdd: { enabled: false },
      prd: { enabled: false },
      review: { enabled: false },
      verification: { enabled: false },
      researchSubagents: { enabled: false },
    });
  });

  it('getReview returns the review enabled state', () => {
    expect(service.getReview()).toBe(false);
    service.setReview(true);
    expect(service.getReview()).toBe(true);
  });

  it('getVerification returns the verification enabled state', () => {
    expect(service.getVerification()).toBe(false);
    service.setVerification(true);
    expect(service.getVerification()).toBe(true);
  });

  it('a legacy `verify` key still maps to review and never turns on verification', () => {
    fs.writeFileSync(tempFile, JSON.stringify({ verify: { enabled: true } }));
    const s2 = new SettingsService(tempFile);
    expect(s2.getReview()).toBe(true);
    expect(s2.getVerification()).toBe(false);
  });

  it('researchSubagents defaults to off and round-trips through disk', () => {
    expect(service.getResearchSubagents()).toBe(false);
    service.setResearchSubagents(true);
    expect(service.getResearchSubagents()).toBe(true);
    const s2 = new SettingsService(tempFile);
    expect(s2.getResearchSubagents()).toBe(true);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw.researchSubagents).toEqual({ enabled: true });
  });

  it('getSettingsPath returns the path in the user config directory', () => {
    const p = getSettingsPath();
    expect(p).toContain('.config');
    expect(p).toContain('ordewell');
    expect(p).toContain('settings.json');
  });

  describe('ORDEWELL_SETTINGS_PATH', () => {
    const saved = process.env.ORDEWELL_SETTINGS_PATH;
    afterEach(() => {
      if (saved === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
      else process.env.ORDEWELL_SETTINGS_PATH = saved;
    });

    // Two Ordewell processes on one machine must be able to hold DIFFERENT
    // toggles at once. Sharing one file makes an A/B of any toggle impossible:
    // getAll() re-reads on mtime change, so whichever process wrote last wins
    // for everyone.
    it('overrides the shared path so parallel processes can differ', () => {
      process.env.ORDEWELL_SETTINGS_PATH = '/tmp/lane-S/settings.json';
      expect(getSettingsPath()).toBe('/tmp/lane-S/settings.json');
    });

    it('falls back to the user config directory when unset or blank', () => {
      delete process.env.ORDEWELL_SETTINGS_PATH;
      expect(getSettingsPath()).toContain('.config');
      process.env.ORDEWELL_SETTINGS_PATH = '   ';
      expect(getSettingsPath()).toContain('.config');
    });

    it('two services on different paths do not see each other writes', () => {
      const a = tempSettingsDir();
      const b = tempSettingsDir();
      try {
        const sa = new SettingsService(a.filePath);
        const sb = new SettingsService(b.filePath);
        sa.setResearchSubagents(true);
        sb.setResearchSubagents(false);
        expect(sa.getResearchSubagents()).toBe(true);
        expect(sb.getResearchSubagents()).toBe(false);
      } finally {
        cleanup(a.dir);
        cleanup(b.dir);
      }
    });
  });

  describe('modelAllowlist', () => {
    it('getModelAllowlist returns undefined by default', () => {
      expect(service.getModelAllowlist('opencode')).toBeUndefined();
    });

    it('setModelAllowlist sets and persists values for a runner', () => {
      service.setModelAllowlist('opencode', ['model-a', 'model-b']);
      expect(service.getModelAllowlist('opencode')).toEqual(['model-a', 'model-b']);
      const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
      expect(raw.modelAllowlist).toEqual({ opencode: ['model-a', 'model-b'] });
    });

    it('clearing a runner allowlist removes it from the persisted object', () => {
      service.setModelAllowlist('opencode', ['model-a']);
      service.setModelAllowlist('opencode', undefined);
      expect(service.getModelAllowlist('opencode')).toBeUndefined();
    });

    it('load reads modelAllowlist from file', () => {
      fs.writeFileSync(tempFile, JSON.stringify({
        modelAllowlist: { opencode: ['a'], 'claude-code': ['x', 'y'] },
      }));
      const s2 = new SettingsService(tempFile);
      expect(s2.getModelAllowlist('opencode')).toEqual(['a']);
      expect(s2.getModelAllowlist('claude-code')).toEqual(['x', 'y']);
      expect(s2.getModelAllowlist('nonexistent')).toBeUndefined();
    });
  });

  describe('enabledRunners', () => {
    it('is undefined until the user chooses, so hosts can fall back to their defaults', () => {
      expect(service.getEnabledRunners()).toBeUndefined();
    });

    it('survives a new service reading the same file', () => {
      service.setEnabledRunners(['claude-code', 'opencode']);
      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual(['claude-code', 'opencode']);
    });

    it('keeps an empty choice distinct from never having chosen', () => {
      service.setEnabledRunners([]);
      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual([]);
    });
  });
});
