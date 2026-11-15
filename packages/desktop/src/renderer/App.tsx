import { useEffect, useState } from 'react';
import { Button, EmptyState, LoadingState } from '@ordewell/ui/design';
import type { DaemonStatus, WindowContext } from '../shared/bridge';
import { registerFrameCommands } from './frame/commands';
import { Frame } from './frame/Frame';
import { FrameProvider, FrameStore } from './frame/store';
import { useDaemonStatus } from './useDaemonStatus';
import { registerViews } from './views';
import { Welcome } from './Welcome';

/** A workspace window: the frame, with every view module registered into it. */
function WorkspaceWindow({ path, status }: { path: string; status: DaemonStatus | undefined }): JSX.Element | null {
  const [store, setStore] = useState<FrameStore>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(undefined);
    void Promise.all([window.ordewell.app.info(), window.ordewell.prefs.get()]).then(([info, prefs]) => {
      if (!live) return;
      setStore(new FrameStore({
        workspace: path,
        platform: info.platform,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        layout: prefs.layouts[path],
        // Only this workspace's entry: main merges it into the others'.
        persistLayout: (saved) => { void window.ordewell.prefs.set('layouts', { [path]: saved }); },
        projects: {
          recents: () => window.ordewell.app.recentWorkspaces(),
          onRecentsChange: (cb) => window.ordewell.app.onRecentsChange(cb),
          // Main answers with a dialog of its own when it cannot; nothing comes back for the page to show.
          open: (folder, options) => { void window.ordewell.app.openWorkspace(folder, options).catch(() => undefined); },
          newWindow: () => { void window.ordewell.app.newWindow().catch(() => undefined); },
          openDropped: (file) => window.ordewell.app.openDroppedFolder(file),
        },
      }));
    }).catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [path, attempt]);

  useEffect(() => {
    if (!store) return;
    const offCommands = registerFrameCommands(store);
    const offViews = registerViews(store.api);
    const offMenu = window.ordewell.app.onMenuCommand((id) => store.api.runCommand(id));
    return () => { offMenu(); offViews(); offCommands(); };
  }, [store]);

  if (!store) return error
    ? <EmptyState title="The project could not open" body={error} action={<Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>} />
    : <LoadingState label="Opening project…" />;
  return (
    <FrameProvider value={store}>
      <Frame daemon={status} />
    </FrameProvider>
  );
}

/** Main decides what this window is; the page only draws it (ADR-0063 H6). */
export function App(): JSX.Element | null {
  const [context, setContext] = useState<WindowContext>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const status = useDaemonStatus();
  useEffect(() => {
    let live = true;
    setError(undefined);
    void window.ordewell.app.context().then((value) => { if (live) setContext(value); }, (reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { live = false; };
  }, [attempt]);

  if (context?.kind === 'workspace') return <WorkspaceWindow path={context.path} status={status} />;
  if (context?.kind !== 'welcome') return error
    ? <EmptyState title="Ordewell could not open" body={error} action={<Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>} />
    : <LoadingState label="Opening Ordewell…" />;
  return <Welcome status={status} />;
}
