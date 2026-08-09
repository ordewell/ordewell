import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService } from '../SettingsService';
import { PlannerModelMemory } from '../PlannerModelMemory';

describe('PlannerModelMemory', () => {
  let dir: string;
  let filePath: string;
  let memory: PlannerModelMemory;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-planner-model-'));
    filePath = path.join(dir, 'settings.json');
    process.env.ORDEWELL_SETTINGS_PATH = filePath;
    memory = new PlannerModelMemory(new SettingsService());
  });

  afterEach(() => {
    delete process.env.ORDEWELL_SETTINGS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recalls the model and effort the user last chose for that planner', () => {
    memory.remember('claude-code', 'claude-sonnet-4-5', 'high');

    expect(
      memory.recall('claude-code', [
        { id: 'claude-haiku-4-5', variants: [{ id: 'low' }] },
        { id: 'claude-sonnet-4-5', variants: [{ id: 'low' }, { id: 'high' }] },
      ]),
    ).toEqual({ model: 'claude-sonnet-4-5', effort: 'high', source: 'remembered' });
  });

  it('lands a never-used planner on the first catalog entry rather than an empty picker', () => {
    expect(
      memory.recall('opencode', [
        { id: 'zen/glm-4.6', variants: [{ id: 'low' }] },
        { id: 'zen/kimi-k2', variants: [] },
      ]),
    ).toEqual({ model: 'zen/glm-4.6', effort: '', source: 'catalog-default' });
  });

  it('drops a remembered id the catalog no longer serves instead of restoring a dead model', () => {
    memory.remember('opencode', 'zen/retired-model', 'high');

    expect(memory.recall('opencode', [{ id: 'zen/glm-4.6', variants: [] }])).toEqual({
      model: 'zen/glm-4.6',
      effort: '',
      source: 'catalog-default',
    });
  });

  it('drops a remembered effort the restored model no longer declares, keeping the model', () => {
    memory.remember('claude-code', 'claude-sonnet-4-5', 'xhigh');

    expect(
      memory.recall('claude-code', [
        { id: 'claude-sonnet-4-5', variants: [{ id: 'low' }, { id: 'high' }] },
      ]),
    ).toEqual({ model: 'claude-sonnet-4-5', effort: '', source: 'remembered' });
  });

  it('does not borrow an effort from a sibling model that happens to declare it', () => {
    memory.remember('claude-code', 'claude-sonnet-4-5', 'high');

    expect(
      memory.recall('claude-code', [
        { id: 'claude-haiku-4-5', variants: [{ id: 'high' }] },
        { id: 'claude-sonnet-4-5', variants: [] },
      ]),
    ).toEqual({ model: 'claude-sonnet-4-5', effort: '', source: 'remembered' });
  });

  // Discovery being cold is not a licence to guess an id: an invented model
  // fails at spawn, while an empty one leaves the surface free to say so.
  it('yields nothing when the catalog is empty, even with a remembered choice', () => {
    memory.remember('codex', 'gpt-5-codex', 'high');

    expect(memory.recall('codex', [])).toEqual({ model: '', effort: '', source: 'none' });
  });

  it('keeps each planner backend its own choice', () => {
    memory.remember('claude-code', 'claude-haiku-4-5', 'low');
    memory.remember('openrouter', 'z-ai/glm-4.6');

    expect(memory.recall('claude-code', [{ id: 'claude-haiku-4-5', variants: [{ id: 'low' }] }])).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
      source: 'remembered',
    });
    expect(memory.recall('openrouter', [{ id: 'z-ai/glm-4.6' }])).toEqual({
      model: 'z-ai/glm-4.6',
      effort: '',
      source: 'remembered',
    });
  });

  it('a blank model forgets the planner instead of remembering an empty id', () => {
    memory.remember('claude-code', 'claude-haiku-4-5', 'low');
    memory.remember('claude-code', '   ');

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).plannerModels).toBeUndefined();
    expect(memory.recall('claude-code', [{ id: 'claude-sonnet-4-5' }])).toEqual({
      model: 'claude-sonnet-4-5',
      effort: '',
      source: 'catalog-default',
    });
  });

  it('stores a blank effort as absent, so no runner is handed an empty level', () => {
    memory.remember('opencode', 'zen/glm-4.6', '');

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).plannerModels).toEqual({
      opencode: { model: 'zen/glm-4.6' },
    });
  });

  it('survives a restart — the choice is read back from disk, not held in memory', () => {
    memory.remember('claude-code', 'claude-sonnet-4-5', 'high');

    const fresh = new PlannerModelMemory(new SettingsService());
    expect(
      fresh.recall('claude-code', [{ id: 'claude-sonnet-4-5', variants: [{ id: 'high' }] }]),
    ).toEqual({ model: 'claude-sonnet-4-5', effort: 'high', source: 'remembered' });
  });

  it('survives a hand-edited settings file whose plannerModels are the wrong shape', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        plannerModels: {
          codex: 'gpt-5-codex',
          opencode: { model: 42, effort: 'high' },
          gemini: { model: '', effort: 'high' },
          'claude-code': { model: 'claude-haiku-4-5', effort: 7 },
        },
      }),
    );
    const fresh = new PlannerModelMemory(new SettingsService());

    expect(fresh.recall('codex', [{ id: 'gpt-5-codex' }]).source).toBe('catalog-default');
    expect(fresh.recall('opencode', [{ id: 'zen/glm-4.6' }]).source).toBe('catalog-default');
    expect(fresh.recall('gemini', [{ id: 'gemini-3-pro' }]).source).toBe('catalog-default');
    expect(
      fresh.recall('claude-code', [{ id: 'claude-haiku-4-5', variants: [{ id: 'low' }] }]),
    ).toEqual({ model: 'claude-haiku-4-5', effort: '', source: 'remembered' });
  });
});
