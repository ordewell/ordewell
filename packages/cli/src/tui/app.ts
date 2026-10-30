import { render } from './render';
import { initialState, reduce, type Action, type Effect } from './reducer';
import { animating } from './layout';
import type { TuiState } from './state';

export interface AppDeps {
  initial?: Partial<TuiState>;
  /** Paint one frame; the array holds exactly one line per terminal row. */
  draw(frame: string[]): void;
  perform(effect: Effect): Promise<void>;
  onExit(): void;
  /** Called whenever the session on screen becomes a different one. */
  onSessionChange?(sessionId: string, state: TuiState): void;
}

export interface App {
  start(): void;
  dispatch(action: Action): void;
  getState(): TuiState;
}

/**
 * The most often a stream of incoming messages may repaint. Each paint walks
 * the whole frame, so a task log that arrives in hundreds of small batches
 * would otherwise ask for hundreds of paints a second and leave nothing of the
 * event loop for the daemon, the runner or the keyboard. A keystroke and a
 * resize still paint at once: the user must never wait behind a log flood.
 */
const FRAME_INTERVAL_MS = 33;

/**
 * The state loop: action → reduce → draw → run effects. Effects are fired and
 * forgotten; their results arrive as further actions, so a slow daemon call
 * never blocks a keystroke.
 *
 * Paints driven by messages are coalesced into the next frame slot, so a burst
 * of actions paints once with the final state instead of once per action.
 * Keystrokes and resizes bypass the budget and paint immediately.
 */
export function createApp(deps: AppDeps): App {
  let state = initialState(deps.initial);
  let exited = false;

  // Only while something animates: a repaint every tick is a cost a still screen should not pay.
  const spinnerInterval = setInterval(() => {
    if (animating(state)) dispatch({ type: 'spinnerTick' });
  }, 200);

  let renderPending = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPaint = 0;
  // A keystroke paints at once. A paste is one `data` chunk decoded into many
  // keys in one go, so only the first of a synchronous burst paints now and a
  // microtask after the burst paints its final state — never one paint per key.
  let keyBurst = false;
  let keyBurstDirty = false;

  function paint(): void {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderPending = false;
    lastPaint = Date.now();
    deps.draw(render(state));
  }

  function paintKey(): void {
    if (keyBurst) {
      keyBurstDirty = true;
      return;
    }
    keyBurst = true;
    keyBurstDirty = false;
    paint();
    queueMicrotask(() => {
      keyBurst = false;
      if (exited || !keyBurstDirty) return;
      keyBurstDirty = false;
      paint();
    });
  }

  function scheduleRender(immediate: boolean): void {
    if (immediate) {
      // This state already holds everything a pending paint would have shown.
      paint();
      return;
    }
    if (renderPending) return;
    renderPending = true;
    const since = Date.now() - lastPaint;
    const wait = since >= FRAME_INTERVAL_MS ? 0 : FRAME_INTERVAL_MS - Math.max(0, since);
    renderTimer = setTimeout(paint, wait);
  }

  function dispatch(action: Action): void {
    if (exited) return;

    const result = reduce(state, action);
    const previousSession = state.sessionId;
    state = result.state;
    if (state.sessionId && state.sessionId !== previousSession) deps.onSessionChange?.(state.sessionId, state);

    if (state.exiting) {
      exited = true;
      clearInterval(spinnerInterval);
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = null;
      renderPending = false;
      deps.onExit();
      return;
    }

    // Typing and a resize own the screen the moment they arrive; a log line
    // can wait for the next frame.
    if (action.type === 'key') paintKey();
    else scheduleRender(action.type === 'resize');
    for (const effect of result.effects) fire(effect);
  }

  function fire(effect: Effect): void {
    if (effect.type === 'exit') {
      exited = true;
      clearInterval(spinnerInterval);
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = null;
      renderPending = false;
      deps.onExit();
      return;
    }
    // A failing effect already reports itself as an error turn; swallow the
    // rejection here so one bad call cannot take the whole session down.
    void deps.perform(effect).catch(() => {});
  }

  return {
    start() {
      paint();
      fire({ type: 'refresh' });
    },
    dispatch,
    getState: () => state,
  };
}
