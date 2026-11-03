import { useCallback, useEffect, useState } from 'react';
import type { RecentWorkspace } from '../shared/bridge';
import { parseRunners, RUNNER_NAMES, type RunnerLine } from './runners';

/** The welcome window (design W1): recents, Open folder, and which runners this machine has. */
export function Welcome({ connected }: { connected: boolean }): JSX.Element {
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [runners, setRunners] = useState<RunnerLine[] | 'error'>();

  useEffect(() => { void window.ordewell.app.recentWorkspaces().then(setRecents); }, []);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void window.ordewell.daemon.call('runners.list').then((result) => {
      if (!live) return;
      const parsed = result.ok ? parseRunners(result.data) : undefined;
      setRunners(parsed ?? 'error');
    });
    return () => { live = false; };
  }, [connected]);

  const open = useCallback(async (path?: string) => {
    await window.ordewell.app.openWorkspace(path);
    setRecents(await window.ordewell.app.recentWorkspaces());
  }, []);
  const forget = useCallback(async (path: string) => {
    setRecents(await window.ordewell.app.forgetWorkspace(path));
  }, []);

  return (
    <div className="welcome">
      <header className="welcome-head">
        <h1>Ordewell</h1>
        <button type="button" className="primary" onClick={() => { void open(); }}>Open folder…</button>
      </header>

      <section>
        <h2>Recent</h2>
        {recents.length === 0 && <p className="muted">No workspace opened yet.</p>}
        <ul className="recents">
          {recents.map((entry) => (
            <li key={entry.path} className={entry.missing ? 'missing' : undefined}>
              <button type="button" className="recent-open" disabled={entry.missing} onClick={() => { void open(entry.path); }}>
                <span className="recent-name">{entry.name}</span>
                <span className="recent-path">{entry.missing ? `${entry.path} (folder not found)` : entry.path}</span>
              </button>
              <button type="button" className="recent-forget" aria-label={`Forget ${entry.name}`} onClick={() => { void forget(entry.path); }}>×</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="runners">
        <h2>Runners</h2>
        {!connected && <p className="muted">Waiting for the daemon…</p>}
        {connected && runners === undefined && <p className="muted">Checking…</p>}
        {connected && runners === 'error' && <p className="muted">The daemon did not list its runners.</p>}
        {connected && Array.isArray(runners) && (
          <ul className="runner-line">
            {runners.map((runner) => (
              <li key={runner.id} className={`runner runner-${runner.state}`} title={runner.detail}>
                {RUNNER_NAMES[runner.id] ?? runner.id}: {runner.state === 'missing' ? 'not installed' : runner.state}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
