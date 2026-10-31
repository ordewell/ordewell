import React from 'react';
import type { GlobalRunSettings } from '@ordewell/core';
import { SUPERVISOR_LEVEL_LABEL } from '@ordewell/core/plan-utils';
import type { IsolationPreview } from '@ordewell/core';
import IsolationNotice from './IsolationNotice';
import PlanApprovalNote, { type HostRunSettings } from './PlanApprovalNote';
import PlannerLoginAction from './PlannerLogin';

export interface SignedOutPlannerRow {
  /** The runner whose login the row's action runs; also the key of its pending and failure state. */
  runner: string;
  label: string;
  onLogIn?: () => void;
  pending?: boolean;
  failure?: string;
}

interface EmptyStateProps {
  onLoadSession?: () => void;
  /** The user's autonomy level and run settings (ADR-0030); absent until the host sends them. */
  runSettings?: HostRunSettings | null;
  /**
   * Every coding agent whose own status command says it is signed out, the
   * active planner first. Each row's login runs that agent's own terminal
   * login; the other two are its progress and the reason it did not finish.
   */
  signedOut?: SignedOutPlannerRow[];
  /** The repositories and branches the host found; see {@link IsolationNotice}. */
  isolationPreview?: IsolationPreview | null;
}

/** One Setup row: what is set, and the command that changes it. */
function SetupRow({ label, value, command, warn }: { label: string; value: React.ReactNode; command: string; warn?: boolean }) {
  return (
    <div className="empty-state-setup-row">
      <span className="empty-state-setup-label">{label}</span>
      <span className={`empty-state-setup-value${warn ? ' warn' : ''}`}>{value}</span>
      <code className="empty-state-setup-command command-token">{command}</code>
    </div>
  );
}

function RunValue({ run }: { run: GlobalRunSettings }) {
  const level = `supervisor ${SUPERVISOR_LEVEL_LABEL[run.supervisorLevel]}`;
  return (
    <>
      {run.supervisorLevel === 'act' ? <span className="warn">{level}</span> : level}
      {` · auto-merge ${run.mergeAtGatesAutomatically ? 'on' : 'off'} · `}
      {run.autorun ? <span className="warn">autorun on</span> : 'autorun off'}
      {run.delegationTokens > 0 && <>{' · '}<span className="warn">delegation on</span></>}
    </>
  );
}

export default function EmptyState({ onLoadSession, runSettings, signedOut, isolationPreview }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-logo">
        <svg width="55" height="55" viewBox="0 0 512 512" fill="none">
          <path stroke="currentColor" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" d="M72 142C190 142 232 256 336 256" />
          <path stroke="currentColor" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" d="M72 256L336 256" />
          <path stroke="currentColor" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" d="M72 370C190 370 232 256 336 256" />
          <path fill="#0891b2" d="M432 256C432 278.09 414.09 296 392 296C369.91 296 352 278.09 352 256C352 233.91 369.91 216 392 216C414.09 216 432 233.91 432 256" />
        </svg>
        <svg width="193" height="43" viewBox="355 95 590 130" className="empty-state-wordmark">
          <defs>
            <g id="ow-glyph-o">
              <path d="M 45.15625 -82.34375 C 20.40625 -82.34375 5.25 -66 5.25 -39.453125 C 5.25 -12.75 20.40625 3.453125 45.296875 3.453125 C 70.046875 3.453125 85.34375 -12.75 85.34375 -38.84375 C 85.34375 -66.296875 70.5 -82.34375 45.15625 -82.34375 Z M 45.296875 -65.40625 C 56.84375 -65.40625 64.34375 -55.046875 64.34375 -39.15625 C 64.34375 -24 56.546875 -13.5 45.296875 -13.5 C 33.90625 -13.5 26.25 -23.84375 26.25 -39.453125 C 26.25 -55.046875 33.90625 -65.40625 45.296875 -65.40625 Z" />
            </g>
            <g id="ow-glyph-r">
              <path d="M 9.453125 -81 L 9.453125 0 L 30.453125 0 L 30.453125 -43.046875 C 30.453125 -55.34375 36.59375 -61.5 48.90625 -61.5 C 51.15625 -61.5 52.65625 -61.34375 55.5 -60.90625 L 55.5 -82.203125 C 54.296875 -82.34375 53.84375 -82.34375 52.953125 -82.34375 C 43.34375 -82.34375 35.09375 -76.046875 30.453125 -65.09375 L 30.453125 -81 Z" />
            </g>
            <g id="ow-glyph-d">
              <path d="M 60.75 0 L 81.75 0 L 81.75 -109.34375 L 60.75 -109.34375 L 60.75 -70.5 C 55.5 -78.59375 48.59375 -82.34375 38.40625 -82.34375 C 19.046875 -82.34375 4.34375 -63.75 4.34375 -39.296875 C 4.34375 -28.34375 7.65625 -17.25 13.046875 -9.453125 C 18.59375 -1.5 28.5 3.453125 38.40625 3.453125 C 48.59375 3.453125 55.5 -0.15625 60.75 -8.25 Z M 43.046875 -64.796875 C 53.703125 -64.796875 60.75 -54.59375 60.75 -39 C 60.75 -24.296875 53.546875 -14.09375 43.046875 -14.09375 C 32.546875 -14.09375 25.34375 -24.453125 25.34375 -39.296875 C 25.34375 -54.453125 32.546875 -64.796875 43.046875 -64.796875 Z" />
            </g>
            <g id="ow-glyph-e">
              <path d="M 78.59375 -33.90625 C 78.75 -35.703125 78.75 -36.453125 78.75 -37.5 C 78.75 -45.59375 77.546875 -53.09375 75.59375 -58.796875 C 70.203125 -73.5 57.15625 -82.34375 40.796875 -82.34375 C 17.546875 -82.34375 3.296875 -65.546875 3.296875 -38.40625 C 3.296875 -12.453125 17.40625 3.453125 40.34375 3.453125 C 58.5 3.453125 73.203125 -6.75 77.84375 -22.796875 L 57.15625 -22.796875 C 54.59375 -16.34375 48.75 -12.59375 41.09375 -12.59375 C 35.09375 -12.59375 30.296875 -15.15625 27.296875 -19.65625 C 25.34375 -22.65625 24.59375 -26.25 24.296875 -33.90625 Z M 24.59375 -47.84375 C 25.953125 -60.296875 31.203125 -66.296875 40.5 -66.296875 C 50.09375 -66.296875 55.796875 -59.84375 56.84375 -47.84375 Z" />
            </g>
            <g id="ow-glyph-w">
              <path d="M 91.953125 0 L 114.90625 -81 L 93.15625 -81 L 80.84375 -24.296875 L 68.703125 -81 L 47.703125 -81 L 35.40625 -24.296875 L 22.5 -81 L 0.75 -81 L 23.546875 0 L 45.15625 0 L 58.046875 -57.15625 L 70.203125 0 Z" />
            </g>
            <g id="ow-glyph-l">
              <path d="M 31.046875 -109.34375 L 10.046875 -109.34375 L 10.046875 0 L 31.046875 0 Z" />
            </g>
          </defs>
          <g fill="currentColor">
            <use xlinkHref="#ow-glyph-o" x="359" y="212.5" />
            <use xlinkHref="#ow-glyph-r" x="447.648438" y="212.5" />
            <use xlinkHref="#ow-glyph-d" x="503" y="212.5" />
            <use xlinkHref="#ow-glyph-e" x="591.648438" y="212.5" />
          </g>
          <g fill="#0891b2">
            <use xlinkHref="#ow-glyph-w" x="672.050781" y="212.5" />
            <use xlinkHref="#ow-glyph-e" x="785.75" y="212.5" />
            <use xlinkHref="#ow-glyph-l" x="866.148438" y="212.5" />
            <use xlinkHref="#ow-glyph-l" x="904.851562" y="212.5" />
          </g>
        </svg>
      </div>
      <div className="empty-state-hero">
        <h2>What would you like to build?</h2>
        <p className="empty-state-lead">Describe your goal.</p>
        <p className="empty-state-support">
          Ordewell will research your codebase, generate a structured task plan, and execute it.
        </p>
      </div>
      <PlanApprovalNote runSettings={runSettings} />
      <IsolationNotice preview={isolationPreview} />
      {runSettings && (
        <div className="empty-state-setup">
          <SetupRow label="Autonomy" value={runSettings.autonomous ? 'Full' : 'Guarded'} warn={runSettings.autonomous} command="/settings" />
          <SetupRow label="Run" value={<RunValue run={runSettings.run} />} command="/settings" />
        </div>
      )}
      {signedOut && signedOut.length > 0 && (
        <div className="planner-auth-rows" role="status" aria-live="polite">
          {signedOut.map((row) => (
            <div className="planner-auth-row" data-runner={row.runner} key={row.runner}>
              <span className="planner-auth-dot" aria-hidden="true" />
              <div className="planner-auth-warning-body">
                {/* One line per agent, always: the state before a login, the
                    last attempt's result after one. The retry is the same
                    button beside it. */}
                {row.failure
                  ? <span className="planner-auth-failure" title={row.failure}>{row.failure}</span>
                  : (
                    <span className="planner-auth-warning-text">
                      <span className="planner-auth-warning-agent">{row.label}</span>
                      {' not logged in.'}
                    </span>
                  )}
              </div>
              {row.onLogIn && (
                <PlannerLoginAction
                  className="planner-login-btn"
                  onLogIn={row.onLogIn}
                  pending={row.pending}
                  ariaLabel={row.pending ? `Signing in to ${row.label}` : `Log in to ${row.label}`}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {onLoadSession && (
        <button className="load-session-btn" onClick={onLoadSession}>
          Load Previous Session
        </button>
      )}
    </div>
  );
}
