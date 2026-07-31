export interface ITerminalSession {
  id: string;
  taskId: string;
  onOutput(callback: (text: string) => void): void;
  onExit(callback: (code: number) => void): void;
  kill(): void;
  getOutput(): string;
  write(text: string): void;
}

import type { RunnerRegistry } from '../plugins/RunnerRegistry';

export interface ITerminalRunner {
  spawn(opts: {
    taskId: string;
    runner: string;
    prompt: string;
    modelId?: string;
    thinkingEffort?: string;
    modelVariants?: string[];
    mode?: string;
    headless?: boolean;
    cwd: string;
    registry?: RunnerRegistry;
    /** Task order and title — surfaces use these to label task_started/output events. */
    order?: number;
    title?: string;
    /**
     * The owning plan session. Task ids are only unique within one plan, so
     * transports that key OS resources by task (tmux windows, log files) need
     * this to keep two plans' identically named tasks apart.
     */
    planSessionId?: string;
  }): Promise<ITerminalSession>;

  stop(sessionId: string): void;
  stopAll(): void;
  activeCount: number;
}
