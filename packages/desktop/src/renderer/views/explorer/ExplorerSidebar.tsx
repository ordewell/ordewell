import type { FrameApi, Unregister } from '../../frame/api';
import { all, Stub } from '../Stub';

/**
 * The file tree in the chosen view scope (W8), and quick open. Design slice 11
 * owns this file; a click opens `{ kind: 'file', id: path, scope }` as a
 * preview, a double click keeps it.
 */
function ExplorerTree(): JSX.Element {
  return <Stub what="The file tree" slice={11} />;
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerSidebar({ activity: 'explorer', id: 'files', title: 'Files', render: () => <ExplorerTree /> }),
    api.registerCommand({
      id: 'explorer.quickOpen',
      title: 'Go to file',
      keys: 'Mod+P',
      run: () => { api.showActivity('explorer'); api.announce('Quick open is not built yet.'); },
    }),
  );
}
