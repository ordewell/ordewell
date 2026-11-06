import React from 'react';
import { orNames } from '../runnerNames';
import type { IsolationPreview } from '@ordewell/core';
import IsolationNotice from './IsolationNotice';
import PlanApprovalNote, { type HostRunSettings } from './PlanApprovalNote';

interface GetStartedProps {
  /** Display names of the runners the host knows, in picker order. */
  runnerNames: string[];
  onConfigure: () => void;
  /** The user's run settings; absent until the host sends them. */
  runSettings?: HostRunSettings | null;
  /** The repositories and branches the host found; see {@link IsolationNotice}. */
  isolationPreview?: IsolationPreview | null;
}

/**
 * First-run state shown when nothing can plan yet — no coding agent on PATH and
 * no API key. Either one is enough (ADR-0009), so it offers both routes rather
 * than presenting a key as mandatory.
 */
export default function GetStarted({ runnerNames, onConfigure, runSettings, isolationPreview }: GetStartedProps) {
  return (
    <div className="empty-state get-started">
      <div className="empty-state-icon">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      </div>
      <h2>Ordewell needs something that can plan</h2>
      <p className="get-started-copy">
        Install a coding agent{runnerNames.length > 0 && <> (<strong>{orNames(runnerNames)}</strong>)</>}{' '}
        and Ordewell plans on the subscription you already have.
        No API key needed.
      </p>
      <p className="get-started-alt">Or add an API key instead; it is stored in your OS keychain.</p>
      <PlanApprovalNote runSettings={runSettings} />
      <IsolationNotice preview={isolationPreview} />
      <div className="get-started-actions">
        <button className="get-started-btn" onClick={onConfigure}>
          Add API key
        </button>
      </div>
    </div>
  );
}
