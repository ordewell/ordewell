import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, KeyRound, LogIn, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { Button, EmptyState, Icon } from '@ordewell/ui/design';
import type { DiscoveredModel, SettingsResponse, SupervisorLevel } from '@ordewell/core';
import type { PlannerBackend } from '@ordewell/ui/protocol';
import { describeSignInWays, signInAction, signInOfVerdict, SUPERVISOR_LEVEL_LABEL, TERMINAL_UI_SIGN_IN } from '@ordewell/core/plan-utils';
import type { FrameApi, Unregister } from '../../frame/api';
import { THEME_CHOICES, type ThemePref } from '../../frame/themePref';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import NumberField from './NumberField';
import { atRunDefaults, runDefaultsChange } from './runDefaults';
import { ModelAllowlist } from './ModelAllowlist';
import { Subplanners } from './Subplanners';
import { runnerRowsFor, useSettings, type RunnerRow } from './useSettings';
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

function Toggle({ label, checked, hint, disabled, onChange }: { label: string; checked: boolean; hint?: string; disabled?: boolean; onChange(checked: boolean): void }): JSX.Element {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
      {hint && <span className="settings-hint">{hint}</span>}
    </label>
  );
}

/** Restore for the Run section: it asks inline first, so a stray click never overwrites six settings. */
function RestoreRunDefaults({ disabled, onRestore }: { disabled: boolean; onRestore(): Promise<void> }): JSX.Element {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <Button size="sm" disabled={disabled} onClick={() => setAsking(true)}>Restore defaults</Button>;
  }
  return (
    <div className="settings-confirm" role="group" aria-label="Restore Run settings">
      <span className="settings-confirm-text">Restore Run settings to their defaults?</span>
      <Button size="sm" variant="primary" onClick={() => { void onRestore().finally(() => setAsking(false)); }}>Restore</Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
    </div>
  );
}

function Planner({ settings, backends, models, busy, onPlanner, onModel, onEffort }: {
  settings: SettingsResponse;
  backends: readonly PlannerBackend[];
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
  // core's list always names the shipped agents, so an uninstalled one keeps
  // its row and says why instead of vanishing from the picker.
  const offered: PlannerBackend[] = backends.some((backend) => backend.id === settings.aiProvider)
    ? [...backends]
    : [{ id: settings.aiProvider, label: settings.aiProvider, kind: 'vendor', usable: true }, ...backends];
  const active = backends.find((backend) => backend.id === settings.aiProvider);
  return (
    <>
      <label className="settings-field" htmlFor={plannerId}>
        <span className="settings-label">Planner</span>
        <select className="ow-select" id={plannerId} aria-label="Planner" value={settings.aiProvider} disabled={busy} onChange={(event) => onPlanner(event.target.value)}>
          {offered.map((backend) => (
            <option key={backend.id} value={backend.id} disabled={!backend.usable}>
              {backend.label}{backend.usable ? '' : ` — ${backend.reason ?? 'not available'}`}
            </option>
          ))}
        </select>
        <span className="settings-hint">
          Who turns a goal into a plan. An agent plans with its own models.
          {active && (!active.usable || active.auth?.state === 'signed-out') && active.reason ? ` ${active.reason}` : ''}
        </span>
      </label>
      <label className="settings-field" htmlFor={modelFieldId}>
        <span className="settings-label">Planner model</span>
        <select className="ow-select" id={modelFieldId} aria-label="Planner model" value={settings.orchestratorModel} disabled={busy || choices.length === 0} onChange={(event) => onModel(event.target.value)}>
          {choices.length === 0 && <option value={settings.orchestratorModel}>{settings.orchestratorModel || 'No model listed'}</option>}
          {choices.map((candidate) => <option key={candidate.modelId} value={candidate.modelId}>{candidate.modelLabel || candidate.modelId}</option>)}
        </select>
      </label>
      {efforts.length > 0 && (
        <label className="settings-field" htmlFor={effortId}>
          <span className="settings-label">Thinking effort</span>
          <select className="ow-select" id={effortId} aria-label="Thinking effort" value={settings.plannerThinkingEffort} disabled={busy} onChange={(event) => onEffort(event.target.value)}>
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
  const { view, refresh, rescan, update, updateRun, setRunner, savePref, setTheme } = useSettings(host, sessionId);
  const { settings, runners, models, prefs, busy, loading, error, backends } = view;
  // Held here as well as in the prefs so the disclosure answers the click at once, not after the write.
  const [advancedChoice, setAdvancedChoice] = useState<boolean | undefined>(undefined);
  const advancedOpen = advancedChoice ?? prefs?.settingsAdvancedOpen ?? false;
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
  const runnerRows = runnerRowsFor(runners, backends);
  const runnerHint = (row: RunnerRow): string => {
    const parts: string[] = [];
    const state = row.auth?.state;
    const signIn = signInOfVerdict(row.id, row.name, row.auth);
    if (state) parts.push(state === 'signed-in' ? 'Signed in' : state === 'signed-out' ? 'Signed out' : 'Sign-in unknown');
    const ways = signIn && state !== 'signed-in' ? describeSignInWays(signIn, TERMINAL_UI_SIGN_IN) : '';
    if (ways) parts.push(ways);
    if (row.reason) parts.push(row.reason);
    else if (!row.installed) parts.push('not installed');
    return parts.join(' · ');
  };

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
          <select className="ow-select" value={prefs?.theme ?? 'dark'} onChange={(event) => { void setTheme(event.target.value as ThemePref); }}>
            {THEME_CHOICES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
          <span className="settings-hint">Dark is the default. System follows your computer's light or dark setting. Also in the command palette (⌘K, then "Theme").</span>
        </label>
      </section>

      <section className="settings-section" aria-labelledby="settings-planner">
        <h3 id="settings-planner">Planner</h3>
        <Planner
          settings={settings}
          backends={backends}
          models={runnerModels as DiscoveredModel[] | undefined}
          busy={busy}
          onPlanner={(provider) => { void update({ env: { AI_PROVIDER: provider } }); }}
          onModel={(model) => { void update({ orchestratorModel: model }); }}
          onEffort={(effort) => { void update({ plannerThinkingEffort: effort }); }}
        />
      </section>

      <section className="settings-section" aria-labelledby="settings-runners">
        <div className="settings-section-head">
          <h3 id="settings-runners">Runners</h3>
          <Button size="sm" icon={RotateCw} disabled={busy} onClick={() => { void rescan(); }}>Refresh</Button>
        </div>
        <p className="settings-hint">Which coding agents a task may run on, and which models each may offer.</p>
        <ul className="settings-runners">
          {runnerRows.map((row) => {
            const signIn = signInOfVerdict(row.id, row.name, row.auth);
            const state = row.auth?.state;
            const action = state === 'signed-out' ? signInAction(signIn) : null;
            return (
              <li key={row.id} className="settings-runner">
                <Toggle
                  label={row.name}
                  checked={row.enabled}
                  disabled={!row.installed}
                  hint={runnerHint(row) || undefined}
                  onChange={(enabled) => { void setRunner(row.id, enabled); }}
                />
                {row.installed ? (
                  <ModelAllowlist
                    runnerName={row.name}
                    models={models?.modelsByRunner[row.id] ?? []}
                    ids={settings.modelAllowlist?.[row.id]}
                    disabled={!row.enabled}
                    error={models?.runnerErrors?.[row.id]}
                    onCommit={(next) => update({ modelAllowlist: { [row.id]: next } })}
                  />
                ) : (
                  <p className="settings-hint">Install {row.name}, then Refresh.</p>
                )}
                {row.installed && (action === 'login' || signIn?.key) && (
                  <span className="settings-runner-actions">
                    {action === 'login' && (
                      <Button size="sm" icon={LogIn} disabled={busy} onClick={() => { void host.handle({ type: 'loginPlanner', runner: row.id }); }}>
                        Log in
                      </Button>
                    )}
                    {signIn?.key && (
                      <Button size="sm" icon={KeyRound} disabled={busy} onClick={() => { void host.enterApiKey(signIn.key?.provider, row.name); }}>
                        Set API key…
                      </Button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="settings-section" aria-labelledby="settings-run">
        <div className="settings-section-head">
          <h3 id="settings-run">Run</h3>
          <RestoreRunDefaults
            disabled={busy || atRunDefaults(settings)}
            onRestore={() => update(runDefaultsChange())}
          />
        </div>
        <p className="settings-hint">How a run is started, watched and merged. These apply to the open session; the last change is the default for a new one.</p>
        <Pills
          label="Autonomy"
          options={AUTONOMY.map((option) => ({ ...option }))}
          current={settings.autonomousMode}
          onPick={(autonomousMode) => { void update({ autonomousMode }); }}
        />
        <label className="settings-field">
          <span className="settings-label">Supervisor</span>
          <select className="ow-select" value={settings.run.supervisorLevel} disabled={busy} onChange={(event) => { void updateRun({ supervisorLevel: event.target.value as SupervisorLevel }); }}>
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
        <NumberField
          label="Parallel tasks"
          value={settings.maxParallel}
          min={1}
          busy={busy}
          hint={(n) => `Up to ${n} AI task${n === 1 ? '' : 's'} at a time.`}
          onCommit={(maxParallel) => { void update({ env: { ORDEWELL_MAX_PARALLEL: String(maxParallel) } }); }}
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
        <Toggle
          label="Reopen projects on launch"
          checked={prefs?.reopenProjects ?? true}
          hint="Open the projects that were open when the app last quit."
          onChange={(reopenProjects) => { void savePref('reopenProjects', reopenProjects); }}
        />
      </section>

      <section className="settings-section" aria-labelledby="settings-advanced">
        <h3 id="settings-advanced">
          <button
            type="button"
            className="settings-disclosure"
            aria-expanded={advancedOpen}
            aria-controls="settings-advanced-body"
            onClick={() => { setAdvancedChoice(!advancedOpen); void savePref('settingsAdvancedOpen', !advancedOpen); }}
          >
            <Icon icon={advancedOpen ? ChevronDown : ChevronRight} size={16} />
            <span>Advanced</span>
          </button>
        </h3>
        <div id="settings-advanced-body" className="settings-advanced-body" hidden={!advancedOpen}>
          <Toggle label="Planned-with line in commits" checked={settings.run.plannedWithTrailer} onChange={(plannedWithTrailer) => { void updateRun({ plannedWithTrailer }); }} />
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
          {/* Settings that are not ready for everyone. */}
          <div className="settings-group">
            <h4>Experimental</h4>
            <Subplanners run={settings.run} busy={busy} onChange={updateRun} />
          </div>
        </div>
      </section>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return all(
    api.registerTabKind({ kind: 'settings', render: () => <SettingsTab host={host} /> }),
    // The key entry is one dialog for every surface: Settings' rows, each
    // signed-out agent's Log in, and this command all reach the host's path.
    api.registerCommand({
      id: 'settings.apiKey',
      title: 'Set API key…',
      run: () => { void host.enterApiKey(); },
    }),
  );
}
