import { getProviderMeta } from '@ordewell/core';
import type { PickerItem, TuiState } from '../state';
import { DEFAULT_EFFORT, plannerEffortItems, plannerHarnessModel, plannerItems, plannerModelItems } from './pickers';
import { step } from './shared';
import type { StepChoices, StepperDefinition } from './stepper';

const offered = (items: PickerItem[]): Set<string> => new Set(items.filter((i) => !i.disabled).map((i) => i.id));

/**
 * The model a backend would open on: what the user last picked for it, else
 * the current model when it is the current backend — whichever its catalog
 * still lists. The stepper falls through to the catalog's first row.
 */
function preferredModel(state: TuiState, provider: string): string {
  const listed = offered(plannerModelItems(state, provider, ''));
  const current = provider === state.plannerProvider ? state.orchestratorModel : undefined;
  return [state.plannerModels[provider]?.model, current].find((id) => id && listed.has(id)) ?? '';
}

/** The same rule one level down: an effort only means something for the model it was picked with. */
function preferredEffort(state: TuiState, provider: string, modelId: string): string {
  const listed = offered(plannerEffortItems(state, provider, modelId, ''));
  const remembered = state.plannerModels[provider];
  const unchanged = provider === state.plannerProvider && modelId === state.orchestratorModel;
  const wanted = remembered?.model === modelId ? remembered.effort ?? '' : unchanged ? state.plannerEffort : '';
  return listed.has(wanted) ? wanted : '';
}

const hasEfforts = (state: TuiState, choices: StepChoices): boolean =>
  (plannerHarnessModel(state, choices.harness, choices.model)?.variants?.length ?? 0) > 0;

/**
 * `/planner` with no argument: harness, model and effort in one pass
 * (ADR-0009). Each step's rows come from the backend chosen before it, not
 * the one in effect. Each enter saves its step with the later ones at their
 * pre-selection — a harness goes with the model and effort it opens on — so
 * the planner is never left holding one backend with another's model.
 */
// Claude's catalog labels its rungs "Low effort"; other runners' say "Low".
const effortLabel = (label: string): string => (/\beffort$/i.test(label) ? label : `${label} effort`);

export const plannerStepper: StepperDefinition = {
  title: 'Planner',
  afterSave: 'advance',
  hint: 'Who researches your goal and writes the plan. Coding agents use their own subscription. No API key.',
  steps: [
    {
      id: 'harness',
      label: 'Harness',
      items: (state) => plannerItems(state),
    },
    {
      id: 'model',
      label: 'Model',
      filterable: true,
      items: (state, choices) => plannerModelItems(state, choices.harness, preferredModel(state, choices.harness)),
    },
    {
      id: 'effort',
      label: 'Effort',
      skip: (state, choices) => !hasEfforts(state, choices),
      items: (state, choices) =>
        plannerEffortItems(state, choices.harness, choices.model, preferredEffort(state, choices.harness, choices.model)),
    },
  ],
  save(state, choices) {
    const provider = choices.harness;
    const modelId = choices.model;
    // An empty or not yet loaded catalog offers no model to pair the harness with.
    if (!modelId) return step(state);
    const effort = choices.effort && choices.effort !== DEFAULT_EFFORT ? choices.effort : '';
    if (provider === state.plannerProvider && modelId === state.orchestratorModel && effort === state.plannerEffort) return step(state);
    const model = plannerModelItems(state, provider, '').find((m) => m.id === modelId);
    const level = plannerEffortItems(state, provider, modelId, '').find((e) => e.id === effort);
    const parts = [
      getProviderMeta(provider)?.label ?? provider,
      model?.label ?? modelId,
      ...(effort ? [effortLabel(level?.label ?? effort)] : []),
    ];
    // Taken ahead of the daemon's answer so the rows mark it at once; the
    // answer carries the same values, the daemon remembering the pick per
    // backend just as this does.
    return step({
      ...state,
      plannerProvider: provider,
      orchestratorModel: modelId,
      plannerEffort: effort,
      plannerModels: { ...state.plannerModels, [provider]: effort ? { model: modelId, effort } : { model: modelId } },
    }, [{ type: 'setPlannerChoice', provider, modelId, effort, notice: `Planner: ${parts.join(' · ')}` }]);
  },
};
