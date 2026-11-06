import { ChatApp, ChatBridgeContext, type ChatBridge } from '@ordewell/ui';
import { vscodeBridge } from '../vscodeBridge';

// Module-level so every render hands the chat the same bridge: its listeners
// are keyed to it and would resubscribe on a new one.
const bridge: ChatBridge = vscodeBridge();

/** The chat as the VS Code webview draws it. */
export default function App() {
  return (
    <ChatBridgeContext.Provider value={bridge}>
      <ChatApp />
    </ChatBridgeContext.Provider>
  );
}
