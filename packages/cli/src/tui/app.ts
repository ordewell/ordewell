import { render } from './render';
import { initialState, reduce, type Action, type Effect } from './reducer';
import { anyTaskRunning, type TuiState } from './state';

export interface AppDeps {
  initial?: Partial<TuiState>;
  /** Paint one frame; the array holds exactly one line per terminal row. */
  draw(frame: string[]): void;
  perform(effect: Effect): Promise<void>;
  onExit(): void;
}

export interface App {
  start(): void;
  dispatch(action: Action): void;
  getState(): TuiState;
}

/**
 * The state loop: action → reduce → draw → run effects. Effects are fired and
 * forgotten; their results arrive as further actions, so a slow daemon call
 * never blocks a keystroke.
 *
 * Renders are batched via a microtask: when multiple actions arrive in the
 * same synchronous burst (a `status_update` that fans out into per-task
 * dispatches, a rapid key sequence), only the final state is painted. The
 * initial `start()` render and the exit path render synchronously.
 */
export function createApp(deps: AppDeps): App {
  let state = initialState(deps.initial);
  let exited = false;

  const spinnerInterval = setInterval(() => {
    if (anyTaskRunning(state)) dispatch({ type: 'spinnerTick' });
  }, 120);

  let renderPending = false;
  function scheduleRender(): void {
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => {
      renderPending = false;
      deps.draw(render(state));
    });
  }

  function dispatch(action: Action): void {
    if (exited) return;

    const result = reduce(state, action);
    state = result.state;

    if (state.exiting) {
      exited = true;
      clearInterval(spinnerInterval);
      deps.onExit();
      return;
    }

    scheduleRender();
    for (const effect of result.effects) fire(effect);
  }

  function fire(effect: Effect): void {
    if (effect.type === 'exit') {
      exited = true;
      clearInterval(spinnerInterval);
      deps.onExit();
      return;
    }
    // A failing effect already reports itself as an error turn; swallow the
    // rejection here so one bad call cannot take the whole session down.
    void deps.perform(effect).catch(() => {});
  }

  return {
    start() {
      deps.draw(render(state));
      fire({ type: 'refresh' });
    },
    dispatch,
    getState: () => state,
  };
}
