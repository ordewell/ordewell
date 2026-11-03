import { createContext, useContext } from 'react';
import type { HostToWebview, WebviewToHost } from './shared/protocol';
import type { HostToTaskLog, TaskLogToHost } from './shared/taskLogProtocol';

/**
 * How a surface talks to the host that draws it: the VS Code webview over
 * `acquireVsCodeApi`, a desktop window over its own channel. The components
 * see only this, so each host supplies one and none of them is assumed.
 * `getState`/`setState` hold what the surface keeps across a reload of itself,
 * and nothing the host owns.
 */
export interface HostBridge<Out, In> {
  post(message: Out): void;
  /** Returns the unsubscribe. */
  subscribe(listener: (message: In) => void): () => void;
  getState(): unknown;
  setState(state: unknown): void;
}

export type ChatBridge = HostBridge<WebviewToHost, HostToWebview>;
export type TaskLogBridge = HostBridge<TaskLogToHost, HostToTaskLog>;

/**
 * Null outside a provider, so a component that only listens when there is a
 * chat (the task commands) can tell, and one that needs it fails loudly.
 */
export const ChatBridgeContext = createContext<ChatBridge | null>(null);
export const TaskLogBridgeContext = createContext<TaskLogBridge | null>(null);

export function useChatBridge(): ChatBridge {
  const bridge = useContext(ChatBridgeContext);
  if (!bridge) throw new Error('The chat needs a ChatBridgeContext provider from its host.');
  return bridge;
}

export function useTaskLogBridge(): TaskLogBridge {
  const bridge = useContext(TaskLogBridgeContext);
  if (!bridge) throw new Error('The task log needs a TaskLogBridgeContext provider from its host.');
  return bridge;
}
