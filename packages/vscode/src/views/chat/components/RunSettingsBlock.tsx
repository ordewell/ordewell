import React, { forwardRef, useEffect, useId, useState } from 'react';
import type { GlobalRunSettings, SupervisorLevel } from '@ordewell/core';
import { DELEGATION_OFFERED, SUPERVISOR_LEVEL_LABEL, parseCount } from '@ordewell/core/plan-utils';
import type { SettingsChange } from '../../../shared/protocol';

export interface RunSettingsValue {
  autonomous: boolean;
  run: GlobalRunSettings;
  maxParallel: number;
}

interface PillOption<T> {
  label: string;
  value: T;
  hint: string;
}

function PillRow<T>({ label, options, current, onPick }: { label: string; options: PillOption<T>[]; current: T; onPick(value: T): void }) {
  const hint = options.find((o) => o.value === current)?.hint;
  return (
    <div className="run-setting">
      <span className="run-setting-label">{label}</span>
      <div className="run-setting-pills" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`planner-pill ${o.value === current ? 'active' : ''}`}
            aria-pressed={o.value === current}
            onClick={() => { if (o.value !== current) onPick(o.value); }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hint && <div className="run-setting-hint">{hint}</div>}
    </div>
  );
}

/**
 * A whole number at least `min`, sent on Enter or blur. Anything else stays in
 * the box marked invalid and is never sent; the host's next answer replaces it.
 */
function NumberRow({ label, value, min, hint, host, onCommit }: { label: string; value: number; min: number; hint(n: number): string; host: RunSettingsValue; onCommit(n: number): void }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  // Keyed on the host's whole answer, not the number: a refused change comes back with the same value.
  useEffect(() => setDraft(String(value)), [host, value]);
  const parsed = parseCount(draft.trim(), min);
  const commit = (): void => {
    if (parsed !== null && parsed !== value) onCommit(parsed);
  };
  return (
    <div className="run-setting">
      <label className="run-setting-label" htmlFor={id}>{label}</label>
      <div>
        <input
          id={id}
          type="number"
          className="run-setting-number"
          min={min}
          step={1}
          value={draft}
          aria-invalid={parsed === null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          onBlur={commit}
        />
      </div>
      <div className="run-setting-hint">{parsed === null ? `A whole number of ${min} or more.` : hint(parsed)}</div>
    </div>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const AUTONOMY: PillOption<boolean>[] = [
  { label: 'Full', value: true, hint: 'Agents run in their autonomous mode, with no permission prompts.' },
  { label: 'Guarded', value: false, hint: 'Agents run in their safe mode and ask before risky actions.' },
];

const SUPERVISOR_HINT: Record<SupervisorLevel, string> = {
  off: 'The planner does nothing while a run is going.',
  watch: 'The planner reads the run and leaves you notes; it changes nothing.',
  act: 'The planner runs, stops and retries tasks and edits the plan for you.',
};
const SUPERVISOR: PillOption<SupervisorLevel>[] = (['off', 'watch', 'act'] as const)
  .map((value) => ({ label: SUPERVISOR_LEVEL_LABEL[value], value, hint: SUPERVISOR_HINT[value] }));

const AUTOMERGE: PillOption<boolean>[] = [
  { label: 'On', value: true, hint: 'Merge at merge gates and at the end of a run without asking.' },
  { label: 'Off', value: false, hint: 'Wait for you at every merge.' },
];

const AUTORUN: PillOption<boolean>[] = [
  { label: 'On', value: true, hint: 'A plan the planner submits starts at once.' },
  { label: 'Off', value: false, hint: 'Each plan waits for you to press Execute.' },
];

/** The Settings panel's Run block (ADR-0030): every run setting one click away, each saved by the host as it changes. */
const RunSettingsBlock = forwardRef<HTMLElement, { value: RunSettingsValue; expanded: boolean; onToggle(): void; onChange(change: SettingsChange): void }>(function RunSettingsBlock({ value, expanded, onToggle, onChange }, ref) {
  const { run } = value;
  const summary = [
    value.autonomous ? 'Full' : 'Guarded',
    `Supervisor: ${SUPERVISOR_LEVEL_LABEL[run.supervisorLevel]}`,
    `Automerge ${run.mergeAtGatesAutomatically ? 'on' : 'off'}`,
    `Autorun ${run.autorun ? 'on' : 'off'}`,
    `${value.maxParallel} parallel`,
    ...(DELEGATION_OFFERED && run.delegationTokens > 0 ? ['Delegation on'] : []),
  ].join(' · ');
  return (
    <section ref={ref} tabIndex={-1} className="setup-block run-settings" aria-label="Run">
      <div className="run-settings-head">
        <button type="button" className="run-settings-toggle" aria-expanded={expanded} onClick={onToggle}>
          <span className="setup-block-title">Run</span>
          <span className={`setup-panel-chevron${expanded ? '' : ' collapsed'}`}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
              <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        {/* Beside the toggle, not inside it, so the button is still named just "Run". */}
        {!expanded && <div className="setup-panel-summary run-settings-summary">{summary}</div>}
      </div>
      {expanded && <RunSettingsRows value={value} onChange={onChange} />}
    </section>
  );
});

function RunSettingsRows({ value, onChange }: { value: RunSettingsValue; onChange(change: SettingsChange): void }) {
  const { run } = value;
  return (
    <>
      <div className="setup-block-hint">{DELEGATION_OFFERED ? 'Supervisor, automerge, autorun and delegation' : 'Supervisor, automerge and autorun'} apply to this session; your last change is the default for new ones.</div>
      <div className="setup-block-hint run-settings-scope-note">Autonomy and Parallel tasks apply to every session.</div>
      <PillRow label="Autonomy" options={AUTONOMY} current={value.autonomous} onPick={(autonomous) => onChange({ autonomous })} />
      <PillRow label="Supervisor" options={SUPERVISOR} current={run.supervisorLevel} onPick={(supervisorLevel) => onChange({ run: { supervisorLevel } })} />
      {run.supervisorLevel !== 'off' && (
        <NumberRow
          label="Supervisor retries" value={run.supervisorRetryLimit} min={0} host={value}
          hint={(n) => (n === 0 ? 'Never retry a task.' : `Retry one task up to ${plural(n, 'time', 'times')}.`)}
          onCommit={(supervisorRetryLimit) => onChange({ run: { supervisorRetryLimit } })}
        />
      )}
      <PillRow label="Automerge" options={AUTOMERGE} current={run.mergeAtGatesAutomatically} onPick={(mergeAtGatesAutomatically) => onChange({ run: { mergeAtGatesAutomatically } })} />
      <PillRow label="Autorun" options={AUTORUN} current={run.autorun} onPick={(autorun) => onChange({ run: { autorun } })} />
      <NumberRow
        label="Parallel tasks" value={value.maxParallel} min={1} host={value}
        hint={(n) => `Up to ${plural(n, 'AI task', 'AI tasks')} at a time.`}
        onCommit={(maxParallel) => onChange({ maxParallel })}
      />
      {/* Not offered until a delegated task exists (ADR-0055 D21). */}
      {DELEGATION_OFFERED && (
        <NumberRow
          label="Delegation budget" value={run.delegationTokens} min={0} host={value}
          hint={(n) => (n === 0 ? 'Delegation is off: plans stay flat.' : `A tree of plans may spend up to ${plural(n, 'token', 'tokens')}.`)}
          onCommit={(delegationTokens) => onChange({ run: { delegationTokens } })}
        />
      )}
    </>
  );
}

export default RunSettingsBlock;
