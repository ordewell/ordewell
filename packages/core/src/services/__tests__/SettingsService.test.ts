import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { SettingsService, getSettingsPath } from '../SettingsService';
import { filterModelsForPrompt } from '../ModelAllowlistResolver';
import { sessionRuntimeSettings } from '../createSession';

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
    expect(service.getAll()).toEqual({});
  });

  it('creates the settings file on first write', () => {
    expect(fs.existsSync(tempFile)).toBe(false);
    service.setEnabledRunners(['codex']);
    expect(fs.existsSync(tempFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw.enabledRunners).toEqual(['codex']);
  });

  it('reads existing settings from file', () => {
    fs.writeFileSync(tempFile, JSON.stringify({
      enabledRunners: ['codex'],
    }));
    const s2 = new SettingsService(tempFile);
    expect(s2.getAll()).toEqual({
      enabledRunners: ['codex'],
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

  describe('two processes on one file', () => {
    /**
     * Another process's write that lands in the same mtime tick as ours: the
     * timestamp is pinned to a value both sides have already seen, since a
     * coarse-grained filesystem does exactly that.
     */
    function writeInSameTick(other: SettingsService, write: (s: SettingsService) => void) {
      const tick = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(tempFile, tick, tick);
      service.getAll();
      write(other);
      fs.utimesSync(tempFile, tick, tick);
    }

    it('sees a write that shares the mtime of the one it last read', () => {
      service.setEnabledRunners(['opencode']);

      writeInSameTick(new SettingsService(tempFile), (s) => s.setEnabledRunners(['opencode', 'claude-code', 'codex']));

      expect(service.getEnabledRunners()).toEqual(['opencode', 'claude-code', 'codex']);
    });

    it('does not write back a stale copy over what the other process saved', () => {
      service.setEnabledRunners(['opencode']);
      writeInSameTick(new SettingsService(tempFile), (s) => s.setEnabledRunners(['opencode', 'codex']));

      service.setModelAllowlist('codex', ['m']);

      const saved = new SettingsService(tempFile).getAll();
      expect(saved.enabledRunners).toEqual(['opencode', 'codex']);
      expect(saved.modelAllowlist).toEqual({ codex: ['m'] });
    });

    it('changes the enabled runners from what another process just saved, not from what it last read', () => {
      service.setEnabledRunners(['opencode']);
      writeInSameTick(new SettingsService(tempFile), (s) => s.setEnabledRunners(['opencode', 'codex']));

      const next = service.updateEnabledRunners((saved) => [...(saved ?? []), 'claude-code']);

      expect(next).toEqual(['opencode', 'codex', 'claude-code']);
      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual(['opencode', 'codex', 'claude-code']);
    });

    it('keeps what another process saved while this one was making its change, and makes it again from that', () => {
      service.setEnabledRunners(['claude-code']);
      let raced = false;

      const next = service.updateEnabledRunners((saved) => {
        if (!raced) {
          raced = true;
          new SettingsService(tempFile).setEnabledRunners(['claude-code', 'codex']);
        }
        return [...(saved ?? []), 'opencode'];
      });

      expect(next).toEqual(['claude-code', 'codex', 'opencode']);
      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual(['claude-code', 'codex', 'opencode']);
    });

    it('hands the change nothing when no choice was ever saved', () => {
      const seen = vi.fn((saved: string[] | undefined) => saved ?? ['claude-code']);

      service.updateEnabledRunners(seen);

      expect(seen).toHaveBeenCalledWith(undefined);
    });

    it('sets the enabled runners only while no choice is saved, even when another process just saved one', () => {
      service.getAll();
      new SettingsService(tempFile).setEnabledRunners([]);

      expect(service.setEnabledRunnersIfUnset(['codex'])).toBe(false);
      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual([]);

      fs.rmSync(tempFile);
      expect(service.setEnabledRunnersIfUnset(['codex'])).toBe(true);
      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual(['codex']);
    });

    // A real second process, since a save is synchronous: it holds the file's
    // lock as it would between its last look and its swap, then swaps.
    it('waits for another process mid-swap, then keeps what that process saved', async () => {
      service.setEnabledRunners(['claude-code']);
      const lock = `${tempFile}.lock`;
      fs.writeFileSync(lock, 'other');
      const other = spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const [file, lock] = process.argv.slice(1);
        setTimeout(() => {
          fs.writeFileSync(file + '.other.tmp', JSON.stringify({ enabledRunners: ['claude-code', 'codex'] }));
          fs.renameSync(file + '.other.tmp', file);
          fs.rmSync(lock);
        }, 300);
      `, tempFile, lock]);
      const exited = new Promise((resolve) => other.on('exit', resolve));

      service.setModelAllowlist('codex', ['m']);
      await exited;

      const saved = new SettingsService(tempFile).getAll();
      expect(saved.enabledRunners).toEqual(['claude-code', 'codex']);
      expect(saved.modelAllowlist).toEqual({ codex: ['m'] });
      expect(fs.existsSync(lock)).toBe(false);
    });

    it('takes over a lock left by a process that died mid-swap', () => {
      const lock = `${tempFile}.lock`;
      fs.writeFileSync(lock, 'gone');
      const longAgo = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, longAgo, longAgo);

      service.setEnabledRunners(['codex']);

      expect(new SettingsService(tempFile).getEnabledRunners()).toEqual(['codex']);
      expect(fs.existsSync(lock)).toBe(false);
    });

    it('replaces the file whole, so no reader meets it half-written and takes it for empty', () => {
      service.setEnabledRunners(['opencode', 'codex']);
      const before = fs.statSync(tempFile).ino;

      service.setAutonomousMode(false);

      // A write in place truncates first; a rename swaps the file in one step.
      expect(fs.statSync(tempFile).ino).not.toBe(before);
      expect(fs.readdirSync(path.dirname(tempFile))).toEqual([path.basename(tempFile)]);
    });
  });

  describe('watching the file', () => {
    it('tells a listener when another process saves, once per save', async () => {
      const listener = vi.fn();
      const watching = service.watch(listener);
      try {
        // A directory watcher arms asynchronously. Space distinct arming saves
        // out until one is heard (same-value setters do not write) —
        // for as long as vi.waitFor would wait, since a loaded machine can take
        // past a second to arm it — then forget those calls: the counts below
        // are the saves under test.
        for (let attempt = 0; attempt < 100 && listener.mock.calls.length === 0; attempt++) {
          new SettingsService(tempFile).setEnabledRunners(attempt % 2 === 0 ? ['opencode'] : ['opencode', 'codex']);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(listener).toHaveBeenCalled();
        listener.mockClear();

        new SettingsService(tempFile).setEnabledRunners(['codex']);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(listener).toHaveBeenCalledTimes(1);

        new SettingsService(tempFile).setEnabledRunners(['codex', 'opencode']);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
        expect(service.getEnabledRunners()).toEqual(['codex', 'opencode']);
      } finally {
        watching.dispose();
      }
    });

    it('stops telling once disposed', async () => {
      const listener = vi.fn();
      service.watch(listener).dispose();

      new SettingsService(tempFile).setEnabledRunners(['codex']);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(listener).not.toHaveBeenCalled();
    });
  });

  it('persists changes to disk', () => {
    service.setEnabledRunners(['codex']);
    const raw = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    expect(raw).toEqual({
      enabledRunners: ['codex'],
    });
  });

  // Config-file control only: no setter and no settings panel offer it.
  it('reads plannerAutoCompaction from the file, keeps it through other writes, and drops a value that is not a boolean', () => {
    fs.writeFileSync(tempFile, JSON.stringify({ plannerAutoCompaction: false }));
    expect(service.getAll().plannerAutoCompaction).toBe(false);
    expect(sessionRuntimeSettings(service.getAll()).plannerAutoCompaction).toBe(false);

    service.setEnabledRunners(['codex']);
    expect(JSON.parse(fs.readFileSync(tempFile, 'utf-8'))).toEqual({ plannerAutoCompaction: false, enabledRunners: ['codex'] });

    fs.writeFileSync(tempFile, JSON.stringify({ plannerAutoCompaction: 'no' }));
    expect(service.getAll()).toEqual({});
    expect(sessionRuntimeSettings(service.getAll()).plannerAutoCompaction).toBeUndefined();
  });

  it('reads taskRunnerConfig from the file, keeps it through other writes, and drops a value that is not one of the two', () => {
    fs.writeFileSync(tempFile, JSON.stringify({ taskRunnerConfig: 'minimal' }));
    expect(service.getAll().taskRunnerConfig).toBe('minimal');
    expect(sessionRuntimeSettings(service.getAll()).taskRunnerConfig).toBe('minimal');

    service.setEnabledRunners(['codex']);
    expect(JSON.parse(fs.readFileSync(tempFile, 'utf-8'))).toEqual({ taskRunnerConfig: 'minimal', enabledRunners: ['codex'] });

    fs.writeFileSync(tempFile, JSON.stringify({ taskRunnerConfig: 'lean' }));
    expect(service.getAll()).toEqual({});
    expect(sessionRuntimeSettings(service.getAll()).taskRunnerConfig).toBeUndefined();
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
        sa.setModelAllowlist('opencode', ['a']);
        sb.setModelAllowlist('opencode', ['b']);
        expect(sa.getModelAllowlist('opencode')).toEqual(['a']);
        expect(sb.getModelAllowlist('opencode')).toEqual(['b']);
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

    it('reads a hand-edited allowlist of the wrong shape as nothing, instead of handing the planner a string', () => {
      fs.writeFileSync(tempFile, JSON.stringify({
        modelAllowlist: { 'claude-code': 'opus', codex: ['gpt-5', 7, '   '], opencode: [' zen/glm-4.6 '] },
      }));
      const s2 = new SettingsService(tempFile);

      expect(s2.getModelAllowlist('claude-code')).toBeUndefined();
      expect(s2.getModelAllowlist('codex')).toEqual(['gpt-5']);
      expect(s2.getModelAllowlist('opencode')).toEqual(['zen/glm-4.6']);
      // The real failure was every planner turn throwing on `allowlist.filter`.
      expect(() => filterModelsForPrompt(
        { 'claude-code': [{ modelId: 'opus', modelLabel: 'Opus', variants: [] }] },
        s2.getAll().modelAllowlist ?? {},
      )).not.toThrow();
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

    it('preserves a replacement planner model and effort across restart', () => {
      service.setPlannerModel('codex', { model: 'old-model' });
      service.setPlannerModel('codex', { model: 'new-model', effort: 'high' });
      expect(new SettingsService(tempFile).getPlannerModel('codex')).toEqual({ model: 'new-model', effort: 'high' });
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
      service.setEnabledRunners([]);
      expect(JSON.parse(fs.readFileSync(tempFile, 'utf-8'))).not.toHaveProperty('plannerModels');
    });

    it('stores a remembered model and effort without the spaces a copy-paste leaves', () => {
      fs.writeFileSync(tempFile, JSON.stringify({
        plannerModels: { codex: { model: ' claude-sonnet-5 ', effort: ' high ' } },
      }));

      expect(new SettingsService(tempFile).getPlannerModel('codex')).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
    });

    it('a plannerModels of the wrong shape does not throw and does not wipe the rest of the file', () => {
      fs.writeFileSync(tempFile, JSON.stringify({
        verification: { enabled: true },
        modelAllowlist: { 'claude-code': ['claude-b'] },
        plannerModels: 'not even an object',
      }));
      const s2 = new SettingsService(tempFile);
      expect(() => s2.getAll()).not.toThrow();
      expect(s2.getPlannerModel('claude-code')).toBeUndefined();
      expect(s2.getModelAllowlist('claude-code')).toEqual(['claude-b']);
    });
  });

  describe('settings an older build wrote', () => {
    it('loads an older file carrying the tdd, transport and verify settings, and drops them on the next write', () => {
      fs.writeFileSync(tempFile, JSON.stringify({ tdd: { enabled: false }, verification: { enabled: true }, runnerTransport: 'terminal', modelAllowlist: { codex: ['m'] }, enabledRunners: ['codex'] }));
      const s2 = new SettingsService(tempFile);
      expect(s2.getAll()).toEqual({ modelAllowlist: { codex: ['m'] }, enabledRunners: ['codex'] });

      s2.setEnabledRunners(['opencode']);

      expect(JSON.parse(fs.readFileSync(tempFile, 'utf-8'))).toEqual({ modelAllowlist: { codex: ['m'] }, enabledRunners: ['opencode'] });
    });
  });

  describe('a file it cannot read', () => {
    it('warns once and keeps a hand-edited file it cannot parse as a backup, rather than resetting it', () => {
      const corrupt = '{\n  "autonomousMode": false,\n  "modelAllowlist": { "codex": ["gpt-5"] },\n}\n';
      fs.writeFileSync(tempFile, corrupt);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(service.getAll()).toEqual({});

        service.setEnabledRunners(['claude-code']);

        const saved = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
        expect(saved).toEqual({ enabledRunners: ['claude-code'] });
        const aside = fs.readdirSync(tempDir).filter((f) => f.endsWith('.corrupt'));
        expect(aside).toHaveLength(1);
        expect(fs.readFileSync(path.join(tempDir, aside[0]), 'utf-8')).toBe(corrupt);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(tempFile);
      } finally {
        warn.mockRestore();
      }
    });

    it('refuses to save over a file a read error left unread, keeping what is there', () => {
      // A directory in the file's place makes readFileSync fail with EISDIR —
      // an I/O error, not a parse error, and no licence to overwrite it.
      fs.mkdirSync(tempFile);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() => service.setEnabledRunners(['codex'])).toThrow(/could not be read/);
        expect(fs.statSync(tempFile).isDirectory()).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
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

  describe('run settings (ADR-0030)', () => {
    it('defaults to a watching supervisor, no automatic merge, no autorun, 2 retries and 12 reads', () => {
      expect(service.getRunSettings()).toEqual({
        supervisorLevel: 'watch',
        mergeAtGatesAutomatically: false,
        plannedWithTrailer: true,
        autorun: false,
        supervisorRetryLimit: 2,
        wakeUpReadBudget: 12,
        delegationTokens: 0,
      });
    });

    it('saves a change for every later reader, leaving the other values as they were', () => {
      service.updateRunSettings({ supervisorLevel: 'act', mergeAtGatesAutomatically: true });

      expect(new SettingsService(tempFile).getRunSettings()).toEqual({
        supervisorLevel: 'act',
        mergeAtGatesAutomatically: true,
        plannedWithTrailer: true,
        autorun: false,
        supervisorRetryLimit: 2,
        wakeUpReadBudget: 12,
        delegationTokens: 0,
      });
    });

    it('refuses a value outside its range and saves nothing of that change', () => {
      expect(() => service.updateRunSettings({ supervisorLevel: 'act', supervisorRetryLimit: -1 })).toThrow(/retry limit/i);
      expect(() => service.updateRunSettings({ wakeUpReadBudget: 0 })).toThrow(/read budget/i);
      expect(() => service.updateRunSettings({ wakeUpReadBudget: 2.5 })).toThrow(/read budget/i);

      expect(service.getRunSettings().supervisorLevel).toBe('watch');
    });

    it('keeps a hand-supplied read budget through an unrelated save and a reload', () => {
      fs.writeFileSync(tempFile, JSON.stringify({ supervisorLevel: 'watch', wakeUpReadBudget: 30 }));

      new SettingsService(tempFile).updateRunSettings({ supervisorRetryLimit: 4 });

      expect(JSON.parse(fs.readFileSync(tempFile, 'utf8')).wakeUpReadBudget).toBe(30);
      expect(new SettingsService(tempFile).getRunSettings().wakeUpReadBudget).toBe(30);
    });

    it('has the Planned-with line on for a file that never mentioned it, and keeps a choice to turn it off', () => {
      fs.writeFileSync(tempFile, JSON.stringify({ autorun: true }));
      expect(new SettingsService(tempFile).getRunSettings().plannedWithTrailer).toBe(true);

      service.updateRunSettings({ plannedWithTrailer: false });

      expect(new SettingsService(tempFile).getRunSettings().plannedWithTrailer).toBe(false);
      expect(JSON.parse(fs.readFileSync(tempFile, 'utf8')).plannedWithTrailer).toBe(false);
    });

    it('refuses a Planned-with value that is not on or off, and reads one in a hand-edited file as on', () => {
      expect(() => service.updateRunSettings({ plannedWithTrailer: 'off' as unknown as boolean })).toThrow(/planned-with/i);

      fs.writeFileSync(tempFile, JSON.stringify({ plannedWithTrailer: 'no' }));
      expect(new SettingsService(tempFile).getRunSettings().plannedWithTrailer).toBe(true);
    });

    it('reads a hand-edited value it cannot use as the default, keeping the rest', () => {
      fs.writeFileSync(tempFile, JSON.stringify({ supervisorLevel: 'boss', supervisorRetryLimit: 'many', autorun: true }));

      expect(new SettingsService(tempFile).getRunSettings()).toMatchObject({ supervisorLevel: 'watch', supervisorRetryLimit: 2, autorun: true });
    });
  });

  describe('the autonomy level (ADR-0030)', () => {
    const saved = process.env.ORDEWELL_AUTONOMOUS_MODE;
    afterEach(() => {
      if (saved === undefined) delete process.env.ORDEWELL_AUTONOMOUS_MODE;
      else process.env.ORDEWELL_AUTONOMOUS_MODE = saved;
    });

    it('is Guarded on a fresh install, and keeps either level the user chooses for every later reader', () => {
      delete process.env.ORDEWELL_AUTONOMOUS_MODE;
      expect(service.autonomousMode()).toBe(false);

      service.setAutonomousMode(true);
      expect(new SettingsService(tempFile).autonomousMode()).toBe(true);

      service.setAutonomousMode(false);
      expect(new SettingsService(tempFile).autonomousMode()).toBe(false);
      expect(new SettingsService(tempFile).getAll().autonomousMode).toBe(false);
    });

    it('is Guarded for a file that never chose a level, including one written by an older build', () => {
      delete process.env.ORDEWELL_AUTONOMOUS_MODE;
      fs.writeFileSync(tempFile, JSON.stringify({ enabledRunners: ['codex'], supervisorLevel: 'act' }));

      expect(new SettingsService(tempFile).autonomousMode()).toBe(false);
      expect(new SettingsService(tempFile).getAll().autonomousMode).toBeUndefined();
    });

    it.each([['false', false], ['0', false], ['true', true]])('gives way to ORDEWELL_AUTONOMOUS_MODE=%s in the environment', (value, level) => {
      service.setAutonomousMode(!level);
      process.env.ORDEWELL_AUTONOMOUS_MODE = value;

      expect(service.autonomousMode()).toBe(level);
      expect(service.autonomousModeOverridden()).toBe(true);
    });

    it('reads a hand-edited level name it can use, and the Guarded default for one it cannot', () => {
      delete process.env.ORDEWELL_AUTONOMOUS_MODE;
      fs.writeFileSync(tempFile, JSON.stringify({ autonomousMode: 'guarded' }));
      expect(new SettingsService(tempFile).autonomousMode()).toBe(false);

      fs.writeFileSync(tempFile, JSON.stringify({ autonomousMode: 'maybe' }));
      expect(new SettingsService(tempFile).autonomousMode()).toBe(false);
    });

    it.each([
      ['off', false], ['guarded', false], ['auto', false],
      ['FALSE', false], [' false ', false],
      ['FULL', true], ['on', true],
    ])('reads %s as the level the environment names', (value, level) => {
      service.setAutonomousMode(!level);
      process.env.ORDEWELL_AUTONOMOUS_MODE = value;

      expect(service.autonomousMode()).toBe(level);
      expect(service.autonomousModeOverridden()).toBe(true);
    });

    it.each([['no'], ['maybe'], ['   ']])('leaves the saved level alone when the environment names no level (%s)', (value) => {
      service.setAutonomousMode(false);
      process.env.ORDEWELL_AUTONOMOUS_MODE = value;

      expect(service.autonomousMode()).toBe(false);
      expect(service.autonomousModeOverridden()).toBe(false);
    });
  });
});
