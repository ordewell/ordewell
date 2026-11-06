import React from 'react';
import App from '../chat/App';
import { ChatBridgeContext } from '../bridge';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { testBridge } from './hostApi';

const bridge = testBridge<WebviewToHost, HostToWebview>();

/** The chat as a host mounts it, wired to the test's host. */
export default function ChatApp() {
  return <ChatBridgeContext.Provider value={bridge}><App /></ChatBridgeContext.Provider>;
}
