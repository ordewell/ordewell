import { useEffect, useState } from 'react';
import type { WindowContext } from '../shared/bridge';
import { DaemonBar } from './DaemonBar';
import { useDaemonStatus } from './useDaemonStatus';
import { Welcome } from './Welcome';
import { Workspace } from './Workspace';

/** Main decides what this window is; the page only draws it (ADR-0060 H6). */
export function App(): JSX.Element {
  const [context, setContext] = useState<WindowContext>();
  const status = useDaemonStatus();
  useEffect(() => { void window.ordewell.app.context().then(setContext); }, []);

  const connected = status?.state === 'connected';
  return (
    <div className="app">
      <main className="app-body">
        {context?.kind === 'welcome' && <Welcome connected={connected} />}
        {context?.kind === 'workspace' && <Workspace path={context.path} connected={connected} />}
      </main>
      {status && <DaemonBar status={status} />}
    </div>
  );
}
