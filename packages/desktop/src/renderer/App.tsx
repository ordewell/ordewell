import { useEffect, useState } from 'react';
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

  useEffect(() => {
    let live = true;
    void Promise.all([window.ordewell.app.info(), window.ordewell.prefs.get()]).then(([info, prefs]) => {
      if (!live) return;
      setStore(new FrameStore({
        workspace: path,
        platform: info.platform,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        layout: prefs.layouts[path],
        // Only this workspace's entry: main merges it into the others'.
        persistLayout: (saved) => { void window.ordewell.prefs.set('layouts', { [path]: saved }); },
      }));
    });
    return () => { live = false; };
  }, [path]);

  useEffect(() => {
    if (!store) return;
    const offCommands = registerFrameCommands(store);
    const offViews = registerViews(store.api);
    const offMenu = window.ordewell.app.onMenuCommand((id) => store.api.runCommand(id));
    return () => { offMenu(); offViews(); offCommands(); };
  }, [store]);

  if (!store) return null;
  return (
    <FrameProvider value={store}>
      <Frame daemon={status} />
    </FrameProvider>
  );
}

/** Main decides what this window is; the page only draws it (ADR-0063 H6). */
export function App(): JSX.Element | null {
  const [context, setContext] = useState<WindowContext>();
  const status = useDaemonStatus();
  useEffect(() => { void window.ordewell.app.context().then(setContext); }, []);

  if (context?.kind === 'workspace') return <WorkspaceWindow path={context.path} status={status} />;
  if (context?.kind !== 'welcome') return null;
  return <Welcome status={status} />;
}
