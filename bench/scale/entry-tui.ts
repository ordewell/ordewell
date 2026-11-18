/*
 * What the terminal-UI benchmark reaches for: the reducer, the renderer and the
 * inbound folding exactly as the TUI runs them, with `createApp`'s coalescing.
 * Bundled by build-tui.mjs into one file, core's source included, so the
 * measurement needs no dist.
 */
export { createApp } from '../../packages/cli/src/tui/app';
export { createInbound } from '../../packages/cli/src/tui/inbound';
export { initialState, reduce } from '../../packages/cli/src/tui/reducer';
export { render } from '../../packages/cli/src/tui/render';
