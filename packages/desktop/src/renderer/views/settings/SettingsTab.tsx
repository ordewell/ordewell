import { useEffect, useId, useState } from 'react';
import { CircleAlert, Settings as SettingsIcon } from 'lucide-react';
import { Button, EmptyState } from '@ordewell/ui/design';
import type { DiscoveredModel, SettingsResponse, SupervisorLevel } from '@ordewell/core';
import { SUPERVISOR_LEVEL_LABEL, parseCount } from '@ordewell/core/plan-utils';
import type { FrameApi, Unregister } from '../../frame/api';
import { THEME_CHOICES, type ThemePref } from '../../frame/themePref';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { useSettings, type RunnerSetting } from './useSettings';
import './settings.css';

const AUTONOMY = [
  { label: 'Full', value: true, hint: 'Agents run in their autonomous mode, with no permission prompts.' },
  { label: 'Guarded', value: false, hint: 'Agents run in their safe mode and ask before risky actions.' },
] as const;

const SUPERVISORS: readonly SupervisorLevel[] = ['off', 'watch', 'act'];

function Pills<T extends string | boolean>({ label, options, current, onPick }: {
  label: string;
  options: ReadonlyArray<{ label: string; value: T; hint?: string }>;
  current: T;
  onPick(value: T): void;
}): JSX.Element {
  const hint = options.find((option) => option.value === current)?.hint;
  return (
    <div className="settings-field">
      <span className="settings-label">{label}</span>
      <div className="settings-pills" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`settings-pill${option.value === current ? ' active' : ''}`}
            aria-pressed={option.value === current}
            onClick={() => { if (option.value !== current) onPick(option.value); }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint && <p className="settings-hint">{hint}</p>}
    </div>
  );
}

function Toggle({ label, checked, hint, onChange }: { label: string; checked: boolean; hint?: string; onChange(checked: boolean): void }): JSX.Element {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
      {hint && <span className="settings-hint">{hint}</span>}
    </label>
  );
}

/** A whole number at least `min`, sent on Enter or blur; a refused value comes back with the host's answer. */
function NumberField({ label, value, min, hint, busy, onCommit }: {
  label: string;
  value: number;
  min: number;
  hint(n: number): string;
  busy: boolean;
  onCommit(n: number): void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = parseCount(draft.trim(), min);
  const commit = (): void => { if (parsed !== null && parsed !== value) onCommit(parsed); };
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <span className="settings-number">
        <input
          type="number"
          min={min}
          step={1}
          value={draft}
          disabled={busy}
          aria-invalid={parsed === null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
          onBlur={commit}
        />
        <span className="settings-hint">{parsed === null ? `A whole number of ${min} or more.` : hint(parsed)}</span>
      </span>
    </label>
  );
}

function Allowlist({ runner, ids, busy, onCommit }: {
  runner: RunnerSetting;
  ids: readonly string[] | undefined;
  busy: boolean;
  onCommit(ids: string[]): void;
}): JSX.Element {
  const [draft, setDraft] = useState((ids ?? []).join(', '));
  useEffect(() => setDraft((ids ?? []).join(', ')), [ids]);
  const commit = (): void => {
    const next = draft.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
    if (next.join(',') !== (ids ?? []).join(',')) onCommit(next);
  };
  return (
    <label className="settings-field">
      <span className="settings-label">{runner.name} models</span>
      <textarea
        className="settings-allowlist"
        rows={2}
        value={draft}
        disabled={busy}
        placeholder="Every model this runner lists"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commit(); } }}
      />
      <span className="settings-hint">Comma-separated model ids. Empty allows every model the runner lists.</span>
    </label>
  );
}

function Planner({ settings, runners, providers, models, busy, onPlanner, onModel, onEffort }: {
  settings: SettingsResponse;
  runners: readonly RunnerSetting[];
  providers: readonly string[];
  models: DiscoveredModel[] | undefined;
  busy: boolean;
  onPlanner(provider: string): void;
  onModel(model: string): void;
  onEffort(effort: string): void;
}): JSX.Element {
  const current = models ?? [];
  const modelIds = new Set(current.map((model) => model.modelId));
  const choices = modelIds.has(settings.orchestratorModel) ? current : [
    { modelId: settings.orchestratorModel, modelLabel: settings.orchestratorModel, variants: [] } as DiscoveredModel,
    ...current,
  ];
  const model = choices.find((candidate) => candidate.modelId === settings.orchestratorModel);
  const efforts = model?.variants ?? [];
  const plannerId = useId();
  const modelFieldId = useId();
  const effortId = useId();
  const backends = [
    ...runners.map((runner) => ({ id: runner.id, label: `${runner.name} (agent)`, usable: true })),
    ...providers.filter((provider) => !runners.some((runner) => runner.id === provider)).map((provider) => ({ id: provider, label: `${provider} (vendor)`, usable: true })),
    ...(settings.aiProvider && !runners.some((runner) => runner.id === settings.aiProvider) && !providers.includes(settings.aiProvider) ? [{ id: settings.aiProvider, label: settings.aiProvider, usable: true }] : []),
  ];
  return (
    <>
      <label className="settings-field" htmlFor={plannerId}>
        <span className="settings-label">Planner</span>
        <select id={plannerId} aria-label="Planner" value={settings.aiProvider} disabled={busy} onChange={(event) => onPlanner(event.target.value)}>
          {backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.label}</option>)}
        </select>
        <span className="settings-hint">Who turns a goal into a plan. An agent plans with its own models.</span>
      </label>
      <label className="settings-field" htmlFor={modelFieldId}>
        <span className="settings-label">Planner model</span>
        <select id={modelFieldId} aria-label="Planner model" value={settings.orchestratorModel} disabled={busy || choices.length === 0} onChange={(event) => onModel(event.target.value)}>
          {choices.length === 0 && <option value={settings.orchestratorModel}>{settings.orchestratorModel || 'No model listed'}</option>}
          {choices.map((candidate) => <option key={candidate.modelId} value={candidate.modelId}>{candidate.modelLabel || candidate.modelId}</option>)}
        </select>
      </label>
      {efforts.length > 0 && (
        <label className="settings-field" htmlFor={effortId}>
          <span className="settings-label">Thinking effort</span>
          <select id={effortId} aria-label="Thinking effort" value={settings.plannerThinkingEffort} disabled={busy} onChange={(event) => onEffort(event.target.value)}>
            <option value="">Default</option>
            {efforts.map((variant) => <option key={variant.id} value={variant.id}>{variant.label || variant.id}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/**
 * Settings (W2's planner, ADR-0030's run settings, the runner catalog and the
 * desktop's own preferences), over the daemon's existing settings routes. No
 * value is held here: every write answers with the settings as they now stand.
 */
function SettingsTab({ host }: { host: DaemonHost }): JSX.Element {
  const { sessionId } = useSession(host);
  const { view, refresh, update, updateRun, setRunner, savePref, setTheme } = useSettings(host, sessionId);
  const { settings, runners, models, prefs, busy, loading, error } = view;
  if (loading) return <EmptyState icon={SettingsIcon} title="Loading settings…" />;
  if (!settings) {
    return (
      <EmptyState
        icon={CircleAlert}
        title="Settings could not be loaded"
        body={error ?? 'The daemon did not answer with settings.'}
        action={<Button onClick={() => { void refresh(); }}>Retry</Button>}
      />
    );
  }

  const runnerModels = runners.some((runner) => runner.id === settings.aiProvider)
    ? models?.modelsByRunner[settings.aiProvider]
    : (models?.orchestratorModels ?? []).map((option): DiscoveredModel => ({
      modelId: option.id,
      modelLabel: option.label,
      variants: [],
    }));

  return (
    <div className="settings-view">
      <header className="settings-head">
        <h2>Settings</h2>
        <p>The planner, the runners and the run rules. Every surface shares them; the desktop's own preferences stay in this app.</p>
      </header>
      {error && <p className="settings-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p>}
      {busy && <p className="settings-saving" role="status">Saving…</p>}

      <section className="settings-section" aria-labelledby="settings-appearance">
        <h3 id="settings-appearance">Appearance</h3>
        <label className="settings-field">
          <span className="settings-label">Theme</span>
          <select value={prefs?.theme ?? 'dark'} onChange={(event) => { void setTheme(event.target.value as ThemePref); }}>
            {THEME_CHOICES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
          <span className="settings-hint">Dark is the default. System follows your computer's light or dark setting. Also in the command palette (⌘K, then "Theme").</span>
        </label>
      </section>

      <section className="settings-section" aria-labelledby="settings-planner">
        <h3 id="settings-planner">Planner</h3>
        <Planner
          settings={settings}
          runners={runners}
          providers={models?.providers ?? []}
          models={runnerModels as DiscoveredModel[] | undefined}
          busy={busy}
          onPlanner={(provider) => { void update({ env: { AI_PROVIDER: provider } }); }}
          onModel={(model) => { void update({ orchestratorModel: model }); }}
          onEffort={(effort) => { void update({ plannerThinkingEffort: effort }); }}
        />
      </section>

      <section className="settings-section" aria-labelledby="settings-runners">
        <h3 id="settings-runners">Runners</h3>
        <p className="settings-hint">Which coding agents a task may run on, and which models each may offer.</p>
        <ul className="settings-runners">
          {runners.map((runner) => (
            <li key={runner.id} className="settings-runner">
              <Toggle
                label={runner.name}
                checked={runner.enabled}
                hint={runner.auth ? `Signed ${runner.auth.state === 'signed-in' ? 'in' : runner.auth.state === 'signed-out' ? 'out' : 'in unknown'}` : undefined}
                onChange={(enabled) => { void setRunner(runner.id, enabled); }}
              />
              <Allowlist
                runner={runner}
                ids={settings.modelAllowlist?.[runner.id]}
                busy={busy}
                onCommit={(ids) => { void update({ modelAllowlist: { [runner.id]: ids.length > 0 ? ids : null } }); }}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-section" aria-labelledby="settings-run">
        <h3 id="settings-run">Run</h3>
        <p className="settings-hint">How a run is started, watched and merged. These apply to the open session; the last change is the default for a new one.</p>
        <Pills
          label="Autonomy"
          options={AUTONOMY.map((option) => ({ ...option }))}
          current={settings.autonomousMode}
          onPick={(autonomousMode) => { void update({ autonomousMode }); }}
        />
        <label className="settings-field">
          <span className="settings-label">Supervisor</span>
          <select value={settings.run.supervisorLevel} disabled={busy} onChange={(event) => { void updateRun({ supervisorLevel: event.target.value as SupervisorLevel }); }}>
            {SUPERVISORS.map((level) => <option key={level} value={level}>{SUPERVISOR_LEVEL_LABEL[level]}</option>)}
          </select>
        </label>
        {settings.run.supervisorLevel !== 'off' && (
          <NumberField
            label="Supervisor retries"
            value={settings.run.supervisorRetryLimit}
            min={0}
            busy={busy}
            hint={(n) => (n === 0 ? 'Never retry a task.' : `Retry one task up to ${n} time${n === 1 ? '' : 's'}.`)}
            onCommit={(supervisorRetryLimit) => { void updateRun({ supervisorRetryLimit }); }}
          />
        )}
        <Toggle label="Merge at gates automatically" checked={settings.run.mergeAtGatesAutomatically} onChange={(mergeAtGatesAutomatically) => { void updateRun({ mergeAtGatesAutomatically }); }} />
        <Toggle label="Autorun" checked={settings.run.autorun} hint="A plan the planner submits starts at once." onChange={(autorun) => { void updateRun({ autorun }); }} />
        <Toggle label="Planned-with line in commits" checked={settings.run.plannedWithTrailer} onChange={(plannedWithTrailer) => { void updateRun({ plannedWithTrailer }); }} />
        <NumberField
          label="Parallel tasks"
          value={settings.maxParallel}
          min={1}
          busy={busy}
          hint={(n) => `Up to ${n} AI task${n === 1 ? '' : 's'} at a time.`}
          onCommit={(maxParallel) => { void update({ env: { ORDEWELL_MAX_PARALLEL: String(maxParallel) } }); }}
        />
        {settings.run.supervisorLevel !== 'off' && (
          <NumberField
            label="Wake-up reads"
            value={settings.run.wakeUpReadBudget}
            min={1}
            busy={busy}
            hint={(n) => `Up to ${n} read${n === 1 ? '' : 's'} for one supervisor wake-up.`}
            onCommit={(wakeUpReadBudget) => { void updateRun({ wakeUpReadBudget }); }}
          />
        )}
        <NumberField
          label="Subplanner tree budget"
          value={settings.run.delegationTokens}
          min={0}
          busy={busy}
          hint={(n) => (n === 0 ? 'Subplanners off.' : `A tree of plans may spend up to ${n} tokens.`)}
          onCommit={(delegationTokens) => { void updateRun({ delegationTokens }); }}
        />
      </section>

      <section className="settings-section" aria-labelledby="settings-desktop">
        <h3 id="settings-desktop">This app</h3>
        <Toggle
          label="Desktop notifications"
          checked={prefs?.notifications ?? true}
          hint="Tell me when something needs me, or when a run ends."
          onChange={(notifications) => { void savePref('notifications', notifications); }}
        />
        <Toggle
          label="Keep running in the tray"
          checked={prefs?.keepRunningInTray ?? false}
          hint="Keep the app and its daemon open when the last window closes and no run is live."
          onChange={(keepRunningInTray) => { void savePref('keepRunningInTray', keepRunningInTray); }}
        />
      </section>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return api.registerTabKind({ kind: 'settings', render: () => <SettingsTab host={host} /> });
}
