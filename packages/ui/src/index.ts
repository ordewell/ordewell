export { default as ChatApp, type ChatLayout, type TaskSelection } from './chat/App';
export { INITIAL_HOST_STATE, reduceHost, runnersOn, type HostAction, type HostState } from './chat/hostState';
export { planSummaryLabel } from './chat/planDock';
export { default as TaskLogApp } from './tasklog/TaskLogApp';
// A task's handoff and its verdict's checks, in the words the chat's cards use, for a host's own task view.
export { default as TaskHandoff } from './chat/components/TaskHandoff';
export { checkLabel } from './chat/checkLabel';
export {
  ChatBridgeContext, TaskLogBridgeContext, useChatBridge, useTaskLogBridge,
  type ChatBridge, type HostBridge, type TaskLogBridge,
} from './bridge';
export * from './protocol';
