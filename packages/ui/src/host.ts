/*
 * The view a host assembles for the surfaces, from a session that runs in its
 * own process or behind a daemon's socket, with no React in it: the extension
 * host bundles it into its CommonJS file, and a desktop renderer folds a
 * daemon's frames with it, so a surface draws the same view in either.
 */
export { ConversationViewHost, type SavedConversation } from './host/ConversationViewHost';
export { RunViewHost } from './host/RunViewHost';
export { SessionView, type SessionCue, type SessionSnapshot } from './host/SessionView';
export { ChildView } from './host/ChildView';
export { DaemonSessionStream, type DaemonSessionHooks, type DaemonSessionState } from './host/DaemonStream';
export type { ConnectedFrame, DaemonFrame } from '@ordewell/core/plan-utils';
export * from './host/confirmations';
