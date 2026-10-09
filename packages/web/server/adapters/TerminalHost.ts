import { hasTmux, TmuxRunner, type ITerminalRunner, type ITerminalSession, type RunnerSpawnOptions } from '@ordewell/core';

export const TMUX_MISSING_ADVICE =
  'tmux is not installed, so tasks on a runner with no structured connector run without a terminal window you can open or type into. Install tmux to get one.';

export interface TerminalHostDeps {
  hasTmuxImpl?: () => boolean;
  createTmuxRunner?: (port: number) => TmuxRunner;
}

export interface TerminalHost {
  /** Undefined when the host has no tmux: each plan then falls back to its own headless runner. */
  runner?: TmuxRunner;
  /** Set only when a terminal-transport run will lack what tmux gives it; structured runs never need it. */
  advice?: string;
}

/**
 * The daemon's start-up check for tmux. A missing tmux is never fatal and is
 * not reported here: the structured transport (the default) needs none, so the
 * word only reaches the user, via {@link AdvisingRunner}, if a run actually
 * uses the terminal.
 */
export function startTerminalHost(port: number, deps: TerminalHostDeps = {}): TerminalHost {
  const hasTmuxImpl = deps.hasTmuxImpl ?? hasTmux;
  if (!hasTmuxImpl()) return { advice: TMUX_MISSING_ADVICE };
  const runner = (deps.createTmuxRunner ?? ((p) => new TmuxRunner({ port: p })))(port);
  // Failure is not fatal here: ensureSession is memoized and each spawn
  // re-awaits it, so the next task retries the setup rather than giving up.
  runner.ensureSession().catch((err) => {
    console.error(`[web] tmux session setup failed (will retry on next task spawn): ${err?.message ?? err}`);
  });
  return { runner };
}

/**
 * Wraps the runner a plan's terminal-transport tasks run on, so the first one
 * says what the host lacks. It sits below the transport router, which only
 * sends terminal-transport spawns here.
 */
export class AdvisingRunner implements ITerminalRunner {
  private advised = false;

  constructor(
    private readonly inner: ITerminalRunner,
    private readonly advice: string,
    private readonly advise: (message: string) => void,
  ) {}

  get activeCount(): number { return this.inner.activeCount; }

  spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession> {
    if (!this.advised) {
      this.advised = true;
      this.advise(this.advice);
    }
    return this.inner.spawn(opts);
  }

  stop(sessionId: string): void { this.inner.stop(sessionId); }

  stopAll(): void { this.inner.stopAll(); }
}
