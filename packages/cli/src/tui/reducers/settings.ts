import type { GlobalRunSettings, SupervisorLevel } from '@ordewell/core';
import { ACT_RISK, AUTORUN_RISK, DELEGATION_OFFERED, DELEGATION_RISK, SUPERVISOR_LEVEL_LABEL, autonomyLevelLabel, codexSandboxNotice } from '@ordewell/core';
import type { ConfirmAction, PickerItem, TuiState } from '../state';
import { openStepper, reopenStepper, type StepChoices, type StepperDefinition } from './stepper';
import { step, type Effect, type Step } from './shared';

/**
 * `/settings`: autonomy, supervisor, merging, autorun, parallel tasks and
 * delegation in one stepped panel. Each enter saves its step, and only if it changed, through the
 * same paths the headless commands save them.
 */

export type SaveSettingsEffect = Extract<Effect, { type: 'saveSettings' }>;
type SaveSettingsAction = Extract<ConfirmAction, { kind: 'save-settings' }>;

const SUPERVISOR_DETAIL: Record<SupervisorLevel, string> = {
  off: 'The planner speaks only when you write',
  watch: 'The planner follows your runs and suggests what to do',
  act: 'The planner also runs, stops and retries tasks, edits the plan and merges, without asking',
};

const onOff = (on: boolean): string => (on ? 'on' : 'off');

const switchItems = (current: boolean, onDetail: string, offDetail: string): PickerItem[] => [
  { id: 'on', label: 'On', detail: onDetail, selected: current },
  { id: 'off', label: 'Off', detail: offDetail, selected: !current },
];

const supervisorOff = (_state: TuiState, choices: StepChoices): boolean => choices.supervisor === 'off';

// The counts are typed rather than picked: core takes any whole number from
// their minimum up, with no ceiling (parseCount, parseMaxParallel).
export const SETTINGS: StepperDefinition = {
  title: 'Settings',
  afterSave: 'stay',
  hint: `${DELEGATION_OFFERED ? 'Supervisor, automerge, autorun and delegation' : 'Supervisor, automerge and autorun'} apply to this session; your last change is the default for new ones. Autonomy and Parallel tasks apply to every session.`,
  steps: [
    {
      id: 'autonomy',
      label: 'Autonomy',
      items: (state) => [
        { id: 'full', label: 'Full', detail: "New plans run tasks in each runner's autonomous mode", selected: state.autonomous },
        {
          id: 'guarded',
          label: 'Guarded',
          detail: [`New plans run tasks in each runner's safer mode`, codexSandboxNotice(state.modesByRunner)?.line].filter(Boolean).join(' · '),
          selected: !state.autonomous,
        },
      ],
    },
    {
      id: 'supervisor',
      label: 'Supervisor',
      items: (state) => (['off', 'watch', 'act'] as const).map((level) => ({
        id: level, label: SUPERVISOR_LEVEL_LABEL[level], detail: SUPERVISOR_DETAIL[level], selected: state.runSettings.supervisorLevel === level,
      })),
    },
    {
      id: 'retries',
      label: 'Supervisor retries',
      hint: 'How many times the supervisor may retry one task in a run',
      skip: supervisorOff,
      number: { min: 0, current: (state) => state.runSettings.supervisorRetryLimit },
    },
    {
      id: 'automerge',
      label: 'Automerge',
      items: (state) => switchItems(
        state.runSettings.mergeAtGatesAutomatically,
        'Merge into your branch by itself at merge gates and at the end of a run',
        'Wait for you to merge',
      ),
    },
    {
      id: 'autorun',
      label: 'Autorun',
      items: (state) => switchItems(
        state.runSettings.autorun,
        'Start each plan the planner submits, without review',
        'Wait for you to review and start each plan',
      ),
    },
    {
      id: 'parallel',
      label: 'Parallel',
      hint: 'How many AI tasks run at once, a live run included',
      number: { min: 1, current: (state) => state.maxParallel },
    },
    // Not offered until a delegated task exists (ADR-0055 D21).
    ...(DELEGATION_OFFERED ? [{
      id: 'delegation',
      label: 'Delegation',
      hint: 'The token budget of a tree of plans; 0 keeps delegation off',
      number: { min: 0, current: (state: TuiState) => state.runSettings.delegationTokens },
    }] : []),
  ],
  save: saveChoices,
};

export const openSettings = (state: TuiState): Step => openStepper(state, SETTINGS);

function saveChoices(state: TuiState, choices: StepChoices): Step {
  const run: Partial<GlobalRunSettings> = {};
  const changed: string[] = [];
  const save: Omit<SaveSettingsEffect, 'message'> = { type: 'saveSettings', run, ...(state.sessionId ? { sessionId: state.sessionId } : {}) };

  const autonomous = choices.autonomy === 'full';
  if (autonomous !== state.autonomous) {
    save.autonomous = autonomous;
    changed.push(`Autonomy ${autonomyLevelLabel(autonomous)}`);
  }
  const level = choices.supervisor as SupervisorLevel;
  if (level !== state.runSettings.supervisorLevel) {
    run.supervisorLevel = level;
    changed.push(`Supervisor ${SUPERVISOR_LEVEL_LABEL[level]}`);
  }
  // A skipped step has no choice, which leaves its setting as it is.
  if (choices.retries !== undefined && Number(choices.retries) !== state.runSettings.supervisorRetryLimit) {
    run.supervisorRetryLimit = Number(choices.retries);
    changed.push(`Supervisor retries ${choices.retries}`);
  }
  const automerge = choices.automerge === 'on';
  if (automerge !== state.runSettings.mergeAtGatesAutomatically) {
    run.mergeAtGatesAutomatically = automerge;
    changed.push(`Automerge ${onOff(automerge)}`);
  }
  const autorun = choices.autorun === 'on';
  if (autorun !== state.runSettings.autorun) {
    run.autorun = autorun;
    changed.push(`Autorun ${onOff(autorun)}`);
  }
  const parallel = Number(choices.parallel);
  if (parallel !== state.maxParallel) {
    save.maxParallel = parallel;
    changed.push(`Parallel ${parallel}`);
  }
  // A step that is not offered has no choice, which leaves its setting as it is.
  const delegationTokens = Number(choices.delegation);
  if (choices.delegation !== undefined && delegationTokens !== state.runSettings.delegationTokens) {
    run.delegationTokens = delegationTokens;
    changed.push(delegationTokens > 0 ? `Delegation on, ${delegationTokens} tokens` : 'Delegation off');
  }

  if (changed.length === 0) return step(state);
  const effect: SaveSettingsEffect = { ...save, message: `Settings: ${changed.join(' · ')}` };
  const delegationOn = state.runSettings.delegationTokens === 0 && (run.delegationTokens ?? 0) > 0;
  const risks = [...(run.supervisorLevel === 'act' ? [ACT_RISK] : []), ...(run.autorun ? [AUTORUN_RISK] : []), ...(delegationOn ? [DELEGATION_RISK] : [])];
  if (risks.length === 0) return saveSettings(state, effect);
  // The same warning the headless `ordewell supervisor act` and
  // `ordewell autorun on` ask behind; picking the row in a list is no more
  // considered than typing the command.
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: 'Save this setting?',
      message: effect.message,
      note: `${risks.join('\n')}\nIt applies to this session's run now, and is the default for new ones.`,
      action: { kind: 'save-settings', effect, ...(state.overlay?.kind === 'stepper' ? { menu: state.overlay.stepper } : {}) },
    },
  });
}

/** The confirmation's answer, back on the menu it was asked from — with the setting saved only if `confirmed`. */
export function answerSaveSettings(state: TuiState, action: SaveSettingsAction, confirmed: boolean): Step {
  const closed = { ...state, overlay: null };
  const { state: next, effects } = confirmed ? saveSettings(closed, action.effect) : step(closed);
  return step(action.menu ? reopenStepper(next, action.menu) : next, effects);
}

/**
 * Everything is updated here, not when the save lands: the flags the autonomy
 * and parallel saves set because the daemon never answers them back, the run
 * settings so the open menu marks the new value at once. The daemon's answer
 * then replaces the run settings with the same values.
 */
export function saveSettings(state: TuiState, effect: SaveSettingsEffect): Step {
  return step({
    ...state,
    ...(effect.autonomous !== undefined ? { autonomous: effect.autonomous } : {}),
    ...(effect.maxParallel !== undefined ? { maxParallel: effect.maxParallel } : {}),
    runSettings: { ...state.runSettings, ...effect.run },
  }, [effect]);
}
