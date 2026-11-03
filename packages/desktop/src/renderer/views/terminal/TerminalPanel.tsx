import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** xterm.js over node-pty in main, under the terminal rule. Design slice 15 owns this file. */
function TerminalPanel(): JSX.Element {
  return <Stub what="The terminal" slice={15} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerPanel({ region: 'bottom', id: 'terminal', title: 'Terminal', render: () => <TerminalPanel /> });
}
