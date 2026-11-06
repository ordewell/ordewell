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

async function readLive(path: string): Promise<LiveFacts | undefined> {
  const call = window.ordewell.daemon.call;
  const [repos, sessions] = await Promise.all([
    call('git.repos', { workspace: path }),
    call('sessions.list', { workspace: path }),
  ]);
  const git = repos.ok ? gitFromRepos(repos.data) : undefined;
  const rows = sessions.ok ? parseSessions(sessions.data) : undefined;
  if (!git && !rows) return undefined;
  const facts: LiveFacts = { ...(git ? { git } : {}) };
  if (rows) {
    const newest = rows[0];
    facts.session = newest ? { id: newest.id, goal: newest.goal, status: newest.status, updatedAt: newest.updatedAt } : null;
    const waits = await Promise.all(rows.slice(0, LIVE_SESSIONS).map((row) => call('plans.escalations', { sessionId: row.id })));
    const needsYou = needsYouCount(waits);
    if (needsYou !== undefined) facts.needsYou = needsYou;
  }
  return facts;
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
      void readLive(entry.path).catch(() => undefined).then((facts) => {
        if (facts && (facts.git || facts.session)) {
          void window.ordewell.app.rememberRecent(entry.path, {
            ...(facts.git ? { git: facts.git } : {}),
            ...(facts.session ? { lastSession: facts.session } : {}),
          });
        }
        if (mounted.current) setAnswers((seen) => ({ ...seen, [entry.path]: facts ?? null }));
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
