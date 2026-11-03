import * as vscode from 'vscode';
import type { PlannerBackendId, DiscoveredModel, PlannerModelRecall } from '@ordewell/core';
import type { PlannerBackend } from '@ordewell/ui/protocol';
import type { VendorModelOption } from '../plan/PlannerModelSwitch';

export interface PlannerVendorModel extends VendorModelOption {
  label: string;
  description?: string;
  pricing?: string;
}

export interface PlannerWizardDeps {
  /** What plans right now, read at the start so the steps can mark and pre-select it. */
  current(): { provider: PlannerBackendId; model: string; effort: string };
  /** Every planner the user could pick; unusable ones are filtered from the steps. */
  plannerBackends(): Promise<PlannerBackend[]>;
  modelsForRunner(runner: string): Promise<DiscoveredModel[]>;
  vendorModels(provider: PlannerBackendId): Promise<PlannerVendorModel[]>;
  recall(provider: PlannerBackendId, harnessModels: DiscoveredModel[] | undefined, vendorOptions: VendorModelOption[] | undefined): PlannerModelRecall;
  /** Writes provider, model and effort together and tells the webview once. */
  applyChoice(provider: PlannerBackendId, modelId: string, effort: string): Promise<void>;
}

type Item = vscode.QuickPickItem & { key: string };

interface StepView {
  step: number;
  totalSteps: number;
  placeholder: string;
  items: Item[];
  /** Key to highlight; the first item when absent or unmatched. */
  active?: string;
  back: boolean;
}

type Outcome = { kind: 'accept'; key: string } | { kind: 'back' } | { kind: 'cancel' };

interface Candidate {
  id: string;
  label: string;
  detail?: string;
  variants: { id: string; label: string }[];
}

const RUNNER_DEFAULT = '';

/**
 * Harness → Model → Effort as one quick pick. Nothing is written until the
 * last step is accepted, so backing out — or dismissing — leaves the planner
 * exactly as it was; the three settings can't be left half-switched.
 */
export async function runPlannerWizard(deps: PlannerWizardDeps): Promise<void> {
  // Only what can actually plan is offered: an unavailable agent is left out of
  // the step rather than listed struck through (ADR-0009). A user naming one explicitly
  // still hears why through the `/planner <id>` command.
  const backends = (await deps.plannerBackends()).filter((b) => b.usable);
  if (backends.length === 0) {
    vscode.window.showWarningMessage('No planner available: install a coding agent, or add an API key with /key.');
    return;
  }
  const current = deps.current();
  const hasHarness = backends.some((b) => b.kind === 'harness');

  const qp = vscode.window.createQuickPick<Item>();
  qp.ignoreFocusOut = true;
  const ask = presenter(qp);
  qp.show();

  try {
    let backend: PlannerBackend | undefined;
    let candidates: Candidate[] = [];
    let recall: PlannerModelRecall | undefined;
    let modelId: string | undefined;
    let step: 'harness' | 'model' | 'effort' = 'harness';

    for (;;) {
      if (step === 'harness') {
        const outcome = await ask({
          step: 1,
          totalSteps: hasHarness ? 3 : 2,
          placeholder: 'Who researches your goal and writes the plan?',
          items: backends.map((b) => ({
            key: b.id,
            label: b.label,
            description: b.id === current.provider ? 'current' : undefined,
            detail: b.reason,
          })),
          active: backend?.id ?? current.provider,
          back: false,
        });
        if (outcome.kind !== 'accept') return;
        const picked = backends.find((b) => b.id === outcome.key);
        if (!picked) continue;
        if (backend?.id !== picked.id) {
          modelId = undefined;
          const catalog = await loadCatalog(picked, deps);
          candidates = catalog.candidates;
          recall = catalog.recall;
        }
        backend = picked;
        if (candidates.length === 0) {
          vscode.window.showWarningMessage(`No ${picked.label} models discovered yet. Run /refresh.`);
          return;
        }
        step = 'model';
        continue;
      }

      if (!backend) return;
      const isHarness = backend.kind === 'harness';

      if (step === 'model') {
        const remembered = recall?.model || candidates[0].id;
        const active = backend.id === current.provider && candidates.some((c) => c.id === current.model)
          ? current.model
          : remembered;
        const outcome = await ask({
          step: 2,
          totalSteps: isHarness && candidates.some((c) => c.variants.length > 0) ? 3 : 2,
          placeholder: `Pick the planner model for ${backend.label}`,
          items: candidates.map((c) => ({ key: c.id, label: c.label, description: c.id, detail: c.detail })),
          active: modelId ?? active,
          back: true,
        });
        if (outcome.kind === 'cancel') return;
        if (outcome.kind === 'back') { step = 'harness'; continue; }
        modelId = outcome.key;
        const chosen = candidates.find((c) => c.id === modelId);
        if (isHarness && chosen && chosen.variants.length > 0) {
          step = 'effort';
          continue;
        }
        await finish(deps, backend, chosen, RUNNER_DEFAULT);
        return;
      }

      const chosen = candidates.find((c) => c.id === modelId);
      if (!chosen) return;
      const declared = (effort: string | undefined): effort is string => !!effort && chosen.variants.some((v) => v.id === effort);
      const preferred = [
        backend.id === current.provider && chosen.id === current.model ? current.effort : undefined,
        recall?.model === chosen.id ? recall.effort : undefined,
      ].find(declared) ?? RUNNER_DEFAULT;
      const outcome = await ask({
        step: 3,
        totalSteps: 3,
        placeholder: `Thinking effort for ${chosen.label}`,
        items: [
          { key: RUNNER_DEFAULT, label: 'Runner default', detail: 'Let the agent choose' },
          ...chosen.variants.map((v) => ({ key: v.id, label: v.label })),
        ],
        active: preferred,
        back: true,
      });
      if (outcome.kind === 'cancel') return;
      if (outcome.kind === 'back') { step = 'model'; continue; }
      await finish(deps, backend, chosen, outcome.key);
      return;
    }
  } finally {
    qp.dispose();
  }
}

async function loadCatalog(
  backend: PlannerBackend,
  deps: PlannerWizardDeps,
): Promise<{ candidates: Candidate[]; recall: PlannerModelRecall }> {
  if (backend.kind === 'harness' && backend.runner) {
    const models = await deps.modelsForRunner(backend.runner);
    return {
      candidates: models.map((m) => ({
        id: m.modelId,
        label: m.modelLabel,
        detail: m.variants.length > 0
          ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}`
          : 'runner default effort',
        variants: m.variants.map((v) => ({ id: v.id, label: v.label })),
      })),
      recall: deps.recall(backend.id, models, undefined),
    };
  }
  const options = await deps.vendorModels(backend.id);
  return {
    candidates: options.map((o) => ({
      id: o.id,
      label: o.label,
      detail: `${o.description ?? ''}${o.pricing ? ` · $${o.pricing}/MTok` : ''}`.trim() || undefined,
      variants: [],
    })),
    recall: deps.recall(backend.id, undefined, options),
  };
}

async function finish(deps: PlannerWizardDeps, backend: PlannerBackend, model: Candidate | undefined, effort: string): Promise<void> {
  if (!model) return;
  await deps.applyChoice(backend.id, model.id, effort);
  const level = model.variants.find((v) => v.id === effort);
  const parts = [backend.label, model.label];
  if (model.variants.length > 0) parts.push(level ? `${level.label} effort` : 'default effort');
  vscode.window.showInformationMessage(`Planner: ${parts.join(' · ')}`);
}

/**
 * One picker reused for every step — VS Code's native multi-step pattern — so
 * the window doesn't flicker between steps. Hiding the picker ourselves after
 * the last step is not a cancellation: no step is pending then.
 */
function presenter(qp: vscode.QuickPick<Item>): (view: StepView) => Promise<Outcome> {
  let pending: ((outcome: Outcome) => void) | undefined;
  const settle = (outcome: Outcome) => {
    const resolve = pending;
    pending = undefined;
    resolve?.(outcome);
  };
  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    if (picked) settle({ kind: 'accept', key: picked.key });
  });
  qp.onDidTriggerButton((button) => {
    if (button === vscode.QuickInputButtons.Back) settle({ kind: 'back' });
  });
  qp.onDidHide(() => settle({ kind: 'cancel' }));

  return (view) => new Promise<Outcome>((resolve) => {
    pending = resolve;
    qp.title = 'Planner';
    qp.step = view.step;
    qp.totalSteps = view.totalSteps;
    qp.placeholder = view.placeholder;
    qp.buttons = view.back ? [vscode.QuickInputButtons.Back] : [];
    qp.items = view.items;
    const active = view.items.find((i) => i.key === view.active) ?? view.items[0];
    qp.activeItems = active ? [active] : [];
  });
}
