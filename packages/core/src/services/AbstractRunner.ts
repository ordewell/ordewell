import { EventEmitter } from 'events';
import type { IRunner, IRunnerSession, QueuedTaskMessage, ScriptExit, StructuredEvent, StructuredTurnEnd, TaskMessageFrom } from '../interfaces/IRunner';
import type { ApprovalDecision } from '../interfaces/IApproval';
import type { RunnerCommand } from '../models/RunnerCommand';
import type { CheckpointAnswer, TaskCompleteArgs } from './mcp/tools';
import { HeldSecrets } from './HeldSecrets';

/** One source for the spawn options, so a runner built on this base cannot drift from the interface. */
export type RunnerSpawnOptions = Parameters<IRunner['spawn']>[0];

export abstract class AbstractRunnerSession implements IRunnerSession {
  public id: string;
  public taskId: string;
  readonly secrets = new HeldSecrets();
  protected exited = false;
  protected outputEmitter = new EventEmitter();
  protected exitEmitter = new EventEmitter();

  constructor(id: string, taskId: string) {
    this.id = id;
    this.taskId = taskId;
  }

  protected baseHandleExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitEmitter.emit('exit', code);
  }

  onOutput(callback: (text: string) => void): void {
    this.outputEmitter.on('output', callback);
  }

  onExit(callback: (code: number) => void): void {
    this.exitEmitter.on('exit', callback);
  }

  abstract kill(): void;
  abstract stop(): Promise<void>;
  abstract getOutput(): string;
  abstract write(text: string): void;
  abstract turnState(): 'working' | 'idle';
  abstract onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void;
  abstract onEvent(listener: (event: StructuredEvent) => void): void;
  abstract sendMessage(text: string, from?: TaskMessageFrom): string;
  abstract forceSend(text: string): string;
  abstract forceSendQueued(id: string): boolean;
  abstract removeQueued(id: string): boolean;
  abstract queued(): QueuedTaskMessage[];
  abstract interrupt(): Promise<void>;
  abstract nativeSessionId(): string | null;
  abstract commands(): RunnerCommand[];
  abstract invokeCommand(name: string, args?: string): string;
  abstract answerPermission(id: string, decision: ApprovalDecision): boolean | Promise<boolean>;
  abstract onTaskComplete(listener: (report: TaskCompleteArgs) => void): void;
  abstract onToolCheckpoint(handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void;
  abstract onScriptExit(listener: (exit: ScriptExit) => void): void;
}

export abstract class AbstractRunner<S extends IRunnerSession> implements IRunner {
  protected sessions: Map<string, S> = new Map();

  get activeCount(): number { return this.sessions.size; }

  /** A session winding down stays registered until it exits, so a second stop gets the same wind-down. */
  stop(sessionId: string): Promise<void> {
    return this.sessions.get(sessionId)?.stop() ?? Promise.resolve();
  }

  stopAll(): void {
    for (const session of this.sessions.values()) void session.stop();
  }

  protected registerSession(id: string, session: S): void {
    this.sessions.set(id, session);
    // A replaced session's late exit must not unregister its successor.
    session.onExit(() => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
  }

  abstract spawn(opts: RunnerSpawnOptions): Promise<IRunnerSession>;
}
