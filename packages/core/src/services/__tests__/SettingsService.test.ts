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
      tdd: { enabled: true },
      verification: { enabled: false },
    });
  });

  it('creates the settings file on first write', () => {
    expect(fs.existsSync(tempFile)).toBe(false);
    service.setTdd(false);
    expect(fs.existsSync(tempFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw.tdd.enabled).toBe(false);
  });

  it('reads existing settings from file', () => {
    fs.writeFileSync(tempFile, JSON.stringify({
      tdd: { enabled: false },
      verification: { enabled: true },
    }));
    const s2 = new SettingsService(tempFile);
    expect(s2.getAll()).toEqual({
      tdd: { enabled: false },
      verification: { enabled: true },
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

  it('getTdd returns the tdd enabled state', () => {
    expect(service.getTdd()).toBe(true);
    service.setTdd(false);
    expect(service.getTdd()).toBe(false);
  });

  it('persists changes to disk', () => {
    service.setTdd(false);
    service.setVerification(true);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw).toEqual({
      tdd: { enabled: false },
      verification: { enabled: true },
    });
  });

  it('getVerification returns the verification enabled state', () => {
    expect(service.getVerification()).toBe(false);
    service.setVerification(true);
    expect(service.getVerification()).toBe(true);
  });

  it('getSettingsPath returns the path in the user data directory', () => {
    const p = getSettingsPath();
    expect(p).toContain('.ordewell');
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

    it('falls back to the user data directory when unset or blank', () => {
      delete process.env.ORDEWELL_SETTINGS_PATH;
      expect(getSettingsPath()).toContain('.ordewell');
      process.env.ORDEWELL_SETTINGS_PATH = '   ';
      expect(getSettingsPath()).toContain('.ordewell');
    });

    it('two services on different paths do not see each other writes', () => {
      const a = tempSettingsDir();
      const b = tempSettingsDir();
      try {
        const sa = new SettingsService(a.filePath);
        const sb = new SettingsService(b.filePath);
        sa.setVerification(true);
        sb.setVerification(false);
        expect(sa.getVerification()).toBe(true);
        expect(sb.getVerification()).toBe(false);
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

  describe('plannerModels', () => {
    it('getPlannerModel returns undefined for a planner never used', () => {
      expect(service.getPlannerModel('claude-code')).toBeUndefined();
    });

    it('setPlannerModel persists one entry per planner backend', () => {
      service.setPlannerModel('claude-code', { model: 'claude-haiku-4-5', effort: 'low' });
      service.setPlannerModel('openrouter', { model: 'z-ai/glm-4.6' });
      expect(service.getPlannerModel('claude-code')).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
      const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
      expect(raw.plannerModels).toEqual({
        'claude-code': { model: 'claude-haiku-4-5', effort: 'low' },
        openrouter: { model: 'z-ai/glm-4.6' },
      });
    });

    it('clearing the last entry collapses plannerModels back to absent', () => {
      service.setPlannerModel('claude-code', { model: 'claude-haiku-4-5' });
      service.setPlannerModel('claude-code', undefined);
      expect(service.getPlannerModel('claude-code')).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(tempFile, 'utf-8')).plannerModels).toBeUndefined();
    });

    it('load drops entries whose model is not a real id and keeps the rest', () => {
      fs.writeFileSync(tempFile, JSON.stringify({
        plannerModels: {
          codex: { model: '  ' },
          opencode: { model: 'zen/glm-4.6', effort: 'high' },
          gemini: ['nonsense'],
        },
      }));
      const s2 = new SettingsService(tempFile);
      expect(s2.getPlannerModel('codex')).toBeUndefined();
      expect(s2.getPlannerModel('gemini')).toBeUndefined();
      expect(s2.getPlannerModel('opencode')).toEqual({ model: 'zen/glm-4.6', effort: 'high' });
    });

    it('is absent — never an empty object — when nothing has been recorded', () => {
      service.setTdd(false);
      expect(JSON.parse(fs.readFileSync(tempFile, 'utf-8'))).not.toHaveProperty('plannerModels');
    });

    it('a plannerModels of the wrong shape does not throw and does not wipe the rest of the file', () => {
      fs.writeFileSync(tempFile, JSON.stringify({
        tdd: { enabled: false },
        modelAllowlist: { 'claude-code': ['claude-b'] },
        plannerModels: 'not even an object',
      }));
      const s2 = new SettingsService(tempFile);
      expect(() => s2.getAll()).not.toThrow();
      expect(s2.getPlannerModel('claude-code')).toBeUndefined();
      expect(s2.getTdd()).toBe(false);
      expect(s2.getModelAllowlist('claude-code')).toEqual(['claude-b']);
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
