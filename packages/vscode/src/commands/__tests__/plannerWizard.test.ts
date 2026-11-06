import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlannerModelMemory, type DiscoveredModel, type PlannerModelStore } from '@ordewell/core';
import { __quickPicks, __resetQuickPicks, window, type FakeQuickPick } from '../../test/vscode.mock';
import { runPlannerWizard, type PlannerWizardDeps } from '../plannerWizard';
import { recallPlannerModel } from '../../plan/PlannerModelSwitch';
import type { PlannerBackend } from '@ordewell/ui/protocol';

const CLAUDE: PlannerBackend = { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true };
const CODEX: PlannerBackend = { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: false, reason: 'codex is not installed' };
const OPENROUTER: PlannerBackend = { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true };

function model(modelId: string, modelLabel: string, variantIds: string[] = []): DiscoveredModel {
  return { modelId, modelLabel, variants: variantIds.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) };
}

const OPUS = model('claude-opus-5-5', 'Claude Opus 5.5', ['low', 'high']);
const HAIKU = model('claude-haiku-5-5', 'Claude Haiku 5.5');

function memoryOf(entries: Record<string, { model: string; effort?: string }> = {}): PlannerModelMemory {
  const store = { ...entries };
  const backing: PlannerModelStore = {
    getPlannerModel: (p) => store[p],
    setPlannerModel: (p, e) => { if (e) store[p] = e; else delete store[p]; },
  };
  return new PlannerModelMemory(backing);
}

function makeDeps(overrides: Partial<PlannerWizardDeps> = {}): PlannerWizardDeps {
  const memory = memoryOf();
  return {
    current: () => ({ provider: 'claude-code', model: '', effort: '' }),
    plannerBackends: async () => [CLAUDE, CODEX, OPENROUTER],
    modelsForRunner: async () => [OPUS, HAIKU],
    vendorModels: async () => [{ id: 'z-ai/glm-4.6', label: 'GLM 4.6' }, { id: 'deepseek/v4', label: 'DeepSeek V4' }],
    recall: (provider, harness, vendor) => recallPlannerModel(memory, provider, harness, vendor),
    applyChoice: vi.fn(async () => {}),
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The picker currently on screen, once the wizard has had a chance to build its next step. */
async function step(): Promise<FakeQuickPick> {
  await flush();
  return __quickPicks[__quickPicks.length - 1];
}

const info = window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
const warn = window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

const labels = (qp: FakeQuickPick) => qp.items.map((i) => (i as { label: string }).label);

beforeEach(() => {
  __resetQuickPicks();
  info.mockClear();
  warn.mockClear();
});

describe('/planner wizard: harness path', () => {
  it('walks Harness → Model → Effort and applies once on the last accept', async () => {
    const deps = makeDeps();
    const done = runPlannerWizard(deps);

    let qp = await step();
    expect([qp.step, qp.totalSteps]).toEqual([1, 3]);
    expect(labels(qp)).toEqual(['Claude Code', 'OpenRouter']);
    qp.__accept(0);

    qp = await step();
    expect(qp.step).toBe(2);
    expect(labels(qp)).toEqual(['Claude Opus 5.5', 'Claude Haiku 5.5']);
    expect(deps.applyChoice).not.toHaveBeenCalled();
    qp.__accept(0);

    qp = await step();
    expect(qp.step).toBe(3);
    expect(labels(qp)).toEqual(['Runner default', 'Low', 'High']);
    expect(deps.applyChoice).not.toHaveBeenCalled();
    qp.__accept(2);
    await done;

    expect(deps.applyChoice).toHaveBeenCalledOnce();
    expect(deps.applyChoice).toHaveBeenCalledWith('claude-code', 'claude-opus-5-5', 'high');
    expect(info).toHaveBeenCalledWith('Planner: Claude Code · Claude Opus 5.5 · High effort');
  });

  it('skips the effort step for a model with no variants', async () => {
    const deps = makeDeps();
    const done = runPlannerWizard(deps);

    (await step()).__accept(0);
    const qp = await step();
    expect(qp.totalSteps).toBe(3);
    qp.__accept(1);
    await done;

    expect(__quickPicks).toHaveLength(1);
    expect(deps.applyChoice).toHaveBeenCalledOnce();
    expect(deps.applyChoice).toHaveBeenCalledWith('claude-code', 'claude-haiku-5-5', '');
    expect(info).toHaveBeenCalledWith('Planner: Claude Code · Claude Haiku 5.5');
  });
});

describe('/planner wizard: vendor path', () => {
  it('is two steps — a vendor has no effort levels', async () => {
    const deps = makeDeps();
    const done = runPlannerWizard(deps);

    (await step()).__accept(1);
    const qp = await step();
    expect([qp.step, qp.totalSteps]).toEqual([2, 2]);
    expect(labels(qp)).toEqual(['GLM 4.6', 'DeepSeek V4']);
    qp.__accept(1);
    await done;

    expect(deps.applyChoice).toHaveBeenCalledOnce();
    expect(deps.applyChoice).toHaveBeenCalledWith('openrouter', 'deepseek/v4', '');
    expect(info).toHaveBeenCalledWith('Planner: OpenRouter · DeepSeek V4');
  });
});

describe('/planner wizard: leaving', () => {
  it('Back returns to the previous step with the earlier choice still highlighted', async () => {
    const deps = makeDeps({ modelsForRunner: async () => [HAIKU, OPUS] });
    const done = runPlannerWizard(deps);

    (await step()).__accept(0);
    let qp = await step();
    expect(qp.buttons).toHaveLength(1);
    qp.__accept(1);
    qp = await step();
    expect(qp.step).toBe(3);
    qp.__back();

    qp = await step();
    expect(qp.step).toBe(2);
    expect((qp.activeItems[0] as { label: string }).label).toBe('Claude Opus 5.5');
    qp.__back();

    qp = await step();
    expect(qp.step).toBe(1);
    expect(qp.buttons).toHaveLength(0);
    qp.__escape();
    await done;

    expect(deps.applyChoice).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])('dismissing at step %i applies nothing', async (stepNumber) => {
    const deps = makeDeps();
    const done = runPlannerWizard(deps);

    for (let n = 1; n < stepNumber; n++) (await step()).__accept(0);
    expect((await step()).step).toBe(stepNumber);
    (await step()).__escape();
    await done;

    expect(deps.applyChoice).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('leaves an unusable harness off the step', async () => {
    const deps = makeDeps();
    const done = runPlannerWizard(deps);

    const qp = await step();
    expect(labels(qp)).toEqual(['Claude Code', 'OpenRouter']);
    qp.__escape();
    await done;
    expect(deps.applyChoice).not.toHaveBeenCalled();
  });

  it('says so and applies nothing when no planner is available', async () => {
    const deps = makeDeps({ plannerBackends: async () => [CODEX] });
    await runPlannerWizard(deps);

    expect(warn).toHaveBeenCalledWith('No planner available: install a coding agent, or add an API key with /key.');
    expect(deps.applyChoice).not.toHaveBeenCalled();
  });

  it('warns and changes nothing when the catalog is empty', async () => {
    const deps = makeDeps({ modelsForRunner: async () => [] });
    const done = runPlannerWizard(deps);

    (await step()).__accept(0);
    await done;

    expect(warn).toHaveBeenCalledWith('No Claude Code models discovered yet. Run /refresh.');
    expect(deps.applyChoice).not.toHaveBeenCalled();
  });
});

describe('/planner wizard: starting point', () => {
  it('marks and highlights the current planner, model and effort', async () => {
    const deps = makeDeps({ current: () => ({ provider: 'openrouter', model: 'deepseek/v4', effort: '' }) });
    const done = runPlannerWizard(deps);

    let qp = await step();
    expect((qp.items[1] as { description?: string }).description).toBe('current');
    expect((qp.activeItems[0] as { label: string }).label).toBe('OpenRouter');
    qp.__accept();

    qp = await step();
    expect((qp.activeItems[0] as { label: string }).label).toBe('DeepSeek V4');
    qp.__escape();
    await done;
  });

  it('highlights the model remembered for a backend that is not the current one', async () => {
    const memory = memoryOf({ 'claude-code': { model: 'claude-opus-5-5', effort: 'low' } });
    const deps = makeDeps({
      current: () => ({ provider: 'openrouter', model: 'z-ai/glm-4.6', effort: '' }),
      recall: (provider, harness, vendor) => recallPlannerModel(memory, provider, harness, vendor),
      modelsForRunner: async () => [HAIKU, OPUS],
    });
    const done = runPlannerWizard(deps);

    (await step()).__accept(0);
    let qp = await step();
    expect((qp.activeItems[0] as { label: string }).label).toBe('Claude Opus 5.5');
    qp.__accept();

    qp = await step();
    expect((qp.activeItems[0] as { label: string }).label).toBe('Low');
    qp.__escape();
    await done;
  });

  it('falls back to the first model, and to Runner default for an effort the model no longer declares', async () => {
    const memory = memoryOf({ 'claude-code': { model: 'retired-model', effort: 'max' } });
    const deps = makeDeps({
      recall: (provider, harness, vendor) => recallPlannerModel(memory, provider, harness, vendor),
      current: () => ({ provider: 'claude-code', model: 'claude-opus-5-5', effort: 'max' }),
    });
    const done = runPlannerWizard(deps);

    (await step()).__accept(0);
    let qp = await step();
    expect((qp.activeItems[0] as { label: string }).label).toBe('Claude Opus 5.5');
    qp.__accept();

    qp = await step();
    expect((qp.activeItems[0] as { label: string }).label).toBe('Runner default');
    qp.__escape();
    await done;
  });
});
