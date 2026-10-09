import { EventEmitter } from 'events';
import type { IRunner, IRunnerSession, QueuedTaskMessage, StructuredEvent, StructuredTurnEnd } from '../interfaces/IRunner';
import type { ApprovalDecision } from '../interfaces/IApproval';
import type { CheckpointAnswer, TaskCompleteArgs } from './mcp/tools';

/** One source for the spawn options, so a runner built on this base cannot drift from the interface. */
export type RunnerSpawnOptions = Parameters<IRunner['spawn']>[0];

export abstract class AbstractRunnerSession implements IRunnerSession {
  public id: string;
  public taskId: string;
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
  abstract getOutput(): string;
  abstract write(text: string): void;
  abstract turnState(): 'working' | 'idle';
  abstract onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void;
  abstract onEvent(listener: (event: StructuredEvent) => void): void;
  abstract sendMessage(text: string): string;
  abstract forceSend(text: string): string;
  abstract forceSendQueued(id: string): boolean;
  abstract removeQueued(id: string): boolean;
  abstract queued(): QueuedTaskMessage[];
  abstract interrupt(): Promise<void>;
  abstract nativeSessionId(): string | null;
  abstract answerPermission(id: string, decision: ApprovalDecision): boolean;
  abstract onTaskComplete(listener: (report: TaskCompleteArgs) => void): void;
  abstract onToolCheckpoint(handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void;
}

export abstract class AbstractRunner<S extends IRunnerSession> implements IRunner {
  protected sessions: Map<string, S> = new Map();

  get activeCount(): number { return this.sessions.size; }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.kill();
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const [, session] of this.sessions) {
      session.kill();
    }
    this.sessions.clear();
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
