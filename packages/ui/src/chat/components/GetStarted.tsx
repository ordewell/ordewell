import React from 'react';
import type { IsolationPreview } from '@ordewell/core';
import { AGENT_SIGN_IN_NOTE, agentInstallRoutes } from '@ordewell/core/plan-utils';
import { orNames } from '../runnerNames';
import IsolationNotice from './IsolationNotice';
import PlanApprovalNote, { type HostRunSettings } from './PlanApprovalNote';

/** Where a Detect again stands: not asked, waiting on the host, or answered with still nothing. */
export type RedetectState = 'idle' | 'running' | 'none-found';

interface GetStartedProps {
  /** Display names of the runners the host knows, in picker order. */
  runnerNames: string[];
  onConfigure: () => void;
  /** Run agent detection again, PATH included, for an agent installed while the window was open. */
  onDetectAgain: () => void;
  redetect: RedetectState;
  /** Open a web page in the user's browser: a desktop window does not follow a link itself. */
  onOpenLink: (url: string) => void;
  /** The user's run settings; absent until the host sends them. */
  runSettings?: HostRunSettings | null;
  /** The repositories and branches the host found; see {@link IsolationNotice}. */
  isolationPreview?: IsolationPreview | null;
}

const PLATFORM = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent) ? 'windows' : 'posix';

/**
 * First-run state shown when nothing can plan yet — no coding agent on PATH and
 * no API key. Either one is enough (ADR-0009), so it offers both routes rather
 * than presenting a key as mandatory, and each route ends somewhere: the agent
 * route with the exact install command and a Detect again, the key route with
 * the key entry.
 */
export default function GetStarted({ runnerNames, onConfigure, onDetectAgain, redetect, onOpenLink, runSettings, isolationPreview }: GetStartedProps) {
  const routes = agentInstallRoutes(PLATFORM);
  const others = runnerNames.filter((name) => !routes.some((route) => route.label === name));
  return (
    <div className="empty-state get-started">
      <div className="empty-state-icon">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      </div>
      <h2>Ordewell needs something that can plan</h2>
      <p className="get-started-copy">
        Install a coding agent and Ordewell plans on the subscription you already have. No API key needed.
      </p>
      <ul className="get-started-installs">
        {routes.map((route) => (
          <li key={route.runner} className="get-started-install">
            <strong>{route.label}</strong>
            <code className="get-started-command">{route.command}</code>
            <a
              href={route.docs}
              aria-label={`${route.label} install guide`}
              onClick={(event) => { event.preventDefault(); onOpenLink(route.docs); }}
            >
              Install guide
            </a>
          </li>
        ))}
      </ul>
      <p className="get-started-signin">{AGENT_SIGN_IN_NOTE} Then click Detect again.</p>
      {others.length > 0 && <p className="get-started-alt">Any other agent Ordewell knows plans too once installed: {orNames(others)}.</p>}
      {redetect === 'none-found' && (
        <p className="get-started-status" role="status">
          Still no coding agent found. Check that it starts in a new terminal, then detect again.
        </p>
      )}
      <PlanApprovalNote runSettings={runSettings} />
      <IsolationNotice preview={isolationPreview} />
      <div className="get-started-actions">
        <button className="get-started-btn" onClick={onDetectAgain} disabled={redetect === 'running'}>
          {redetect === 'running' ? 'Detecting…' : 'Detect again'}
        </button>
        <button className="get-started-btn secondary" onClick={onConfigure}>
          Add API key
        </button>
      </div>
      {/* Worded for every host: where a key is kept differs (VS Code's secret storage, the desktop's ~/.ordewell/.env). */}
      <p className="get-started-alt">Or add a provider's API key instead: Ordewell plans on it and, where the provider lists its models, runs tasks on its built-in runner. You pick the planner model right after.</p>
    </div>
  );
}
