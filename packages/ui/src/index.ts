export { default as ChatApp, type ChatLayout, type TaskSelection } from './chat/App';
export { INITIAL_HOST_STATE, reduceHost, runnersOn, type HostAction, type HostState } from './chat/hostState';
export { planSummaryLabel } from './chat/planDock';
export { API_PROVIDER_LABELS } from './chat/components/ModelSelector';
export { default as TaskLogApp } from './tasklog/TaskLogApp';
// A task's handoff and its verdict's checks, in the words the chat's cards use, for a host's own task view.
export { default as TaskHandoff } from './chat/components/TaskHandoff';
// A task's summary line, the same in every list, for a host that draws tasks its own way (the desktop's plan graph).
export { default as TaskSummary, type TaskSummaryDensity } from './chat/components/TaskSummary';
export { checkLabel, verdictSummary } from './chat/checkLabel';
// A running time that ticks on its own timer, so a host's card counts without being rebuilt every second.
export { default as ElapsedTime } from './chat/components/ElapsedTime';
export {
  ChatBridgeContext, TaskLogBridgeContext, useChatBridge, useTaskLogBridge,
  type ChatBridge, type HostBridge, type TaskLogBridge,
} from './bridge';
export * from './protocol';
