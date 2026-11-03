import { EMPTY_RUN, reduceRun, type RunView, type SessionMessage } from '@ordewell/core';
import type { HostToWebview } from '@ordewell/ui/protocol';

/**
 * The run the chat webview draws (#S8c), held on the host: every
 * `SessionMessage` folds through core's `reduceRun` here, and the webview only
 * ever mirrors the result. A webview that joins mid-run is sent the session's
 * `runSnapshot()` through `adopt`, so a task blocked on a runner approval — or
 * waiting at a checkpoint — is drawn without waiting for the next update.
 */
export class RunViewHost {
  private view: RunView = EMPTY_RUN;

  constructor(private readonly post: (msg: HostToWebview) => void) {}

  get current(): RunView {
    return this.view;
  }

  receive(msg: SessionMessage): void {
    this.show(reduceRun(this.view, msg));
  }

  /** What a client that had folded every message would hold, for one that joins now. */
  adopt(view: RunView): void {
    this.show(view);
  }

  reset(): void {
    this.show(EMPTY_RUN);
  }

  /**
   * A new run is starting on a plan whose last one left its cards up: the
   * same fold the Session's `run_closed` gives, since no message says a run
   * was replaced.
   */
  clearIsolation(): void {
    this.show(reduceRun(this.view, { type: 'run_closed' }));
  }

  private show(view: RunView): void {
    if (view === this.view) return;
    this.view = view;
    this.post({ type: 'runView', view });
  }
}
