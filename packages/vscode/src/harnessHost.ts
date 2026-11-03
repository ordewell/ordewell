/**
 * The vscode-free surface of the extension host, for tooling that drives the
 * chat webview outside VS Code (bench/live/webview-harness.mjs). Bundled as
 * its own tsup entry (see tsup.config.ts) so importing it never pulls in
 * `require('vscode')`, which only `extension.ts`'s bundle can resolve.
 *
 * `ConversationViewHost` lives in `@ordewell/ui/host`, vscode-free by design;
 * this entry exists to give the harness a stable, non-extension import path.
 */
export { ConversationViewHost, type SavedConversation } from '@ordewell/ui/host';
