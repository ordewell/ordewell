import { useEffect, useRef, useState } from 'react';
import type { DaemonStatus, RecentGit, RecentSession, RecentWorkspace } from '../../shared/bridge';
import { parseSessions } from '../sessions';
import { gitFromRepos, needsYouCount } from './model';

/** What the daemon said about one recent workspace; a field it could not answer is left out. */
export interface LiveFacts {
  git?: RecentGit;
  /** Null: the daemon lists no session for it. */
  session?: RecentSession | null;
  needsYou?: number;
}

export type Live =
  | { state: 'loading' }
  | { state: 'ready'; facts: LiveFacts }
  /** The daemon is not reachable, or could not answer for this folder: the card keeps its stored lines. */
  | { state: 'unavailable' };

/** Only the newest few can be live in practice; asking every session would cost a call each for nothing. */
const LIVE_SESSIONS = 3;

/** The live facts to draw, and the last session as it is saved, which is all the store may keep. */
async function readLive(path: string): Promise<{ facts: LiveFacts; lastSession?: RecentSession } | undefined> {
  const call = window.ordewell.daemon.call;
  const [repos, sessions] = await Promise.all([
    call('git.repos', { workspace: path }),
    call('sessions.list', { workspace: path }),
  ]);
  const git = repos.ok ? gitFromRepos(repos.data) : undefined;
  const rows = sessions.ok ? parseSessions(sessions.data) : undefined;
  if (!git && !rows) return undefined;
  const facts: LiveFacts = { ...(git ? { git } : {}) };
  let lastSession: RecentSession | undefined;
  if (rows) {
    const newest = rows[0];
    if (newest) lastSession = { id: newest.id, goal: newest.goal, status: newest.status, updatedAt: newest.updatedAt };
    // A run's plan is saved approved while it lasts: the daemon's `run` says it is at work now. Stored, that word
    // would outlive the run, so the card draws it and the store keeps the saved status.
    facts.session = lastSession && newest?.run ? { ...lastSession, status: 'running' } : lastSession ?? null;
    const waits = await Promise.all(rows.slice(0, LIVE_SESSIONS).map((row) => call('plans.escalations', { sessionId: row.id })));
    const needsYou = needsYouCount(waits);
    if (needsYou !== undefined) facts.needsYou = needsYou;
  }
  return { facts, ...(lastSession ? { lastSession } : {}) };
}

/**
 * Each recent workspace's branch, last session and Needs you count, asked of
 * the daemon once it is connected and kept in the app's store through main,
 * so the next welcome window draws them before the daemon answers. The page
 * reaches the daemon only through the bridge's named routes (ADR-0063 H4).
 */
export function useLiveFacts(recents: RecentWorkspace[] | undefined, status: DaemonStatus | undefined): (path: string) => Live {
  const connected = status?.state === 'connected';
  const [answers, setAnswers] = useState<Record<string, LiveFacts | null>>({});
  const asked = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!connected) {
      asked.current.clear();
      return;
    }
    for (const entry of recents ?? []) {
      if (entry.missing || asked.current.has(entry.path)) continue;
      asked.current.add(entry.path);
      void readLive(entry.path).catch(() => undefined).then((read) => {
        if (read && (read.facts.git || read.lastSession)) {
          void window.ordewell.app.rememberRecent(entry.path, {
            ...(read.facts.git ? { git: read.facts.git } : {}),
            ...(read.lastSession ? { lastSession: read.lastSession } : {}),
          });
        }
        if (mounted.current) setAnswers((seen) => ({ ...seen, [entry.path]: read?.facts ?? null }));
      });
    }
  }, [connected, recents]);

  return (path) => {
    if (!connected && status !== undefined && status.state !== 'connecting') return { state: 'unavailable' };
    const answer = answers[path];
    if (answer) return { state: 'ready', facts: answer };
    if (answer === null) return { state: 'unavailable' };
    return { state: 'loading' };
  };
}
