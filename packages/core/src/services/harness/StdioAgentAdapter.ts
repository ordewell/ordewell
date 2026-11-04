import { ProcessLifecycle } from './ProcessLifecycle';
import { LineBuffer, type AgentAdapter, type AgentEvent, type AgentProcessDeps, type AgentStartOptions } from './AgentAdapter';

/** An idle agent that chatters must not grow the between-turn buffer without bound. */
const BETWEEN_TURN_EVENT_CAP = 50;

/**
 * Event kinds never carried across a turn boundary. Reply text belongs to the
 * turn that produced it, and the two terminal kinds would settle the *next*
 * turn the moment it opened — a trailing `turn/completed` after a fatal error
 * would leave the following message answered by nothing at all.
 */
const TURN_SCOPED_EVENTS = new Set(['assistant_text', 'turn_end', 'error']);

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Names the launch must not inherit from the host or the workspace (ADR-0036 N2.2). */
  envDrop?: (name: string) => boolean;
  /** Paths on this host, named in `args`, that the process reads. */
  files?: readonly string[];
  /** Where the process starts, when not in the workspace. */
  cwd?: string;
}

/**
 * Shared plumbing for the agents that speak newline-delimited JSON over stdio.
 *
 * One long-lived process per planner session (ADR-0009, T3): spawned at
 * `start`, fed one message per turn, disposed at the session boundary. The
 * alternative — respawning per turn — pays a cold start on every message
 * *including each corrective re-emit*, and re-reads the repository from
 * scratch when it cannot resume.
 *
 * Subclasses own their agent's protocol: what to spawn, how to phrase a user
 * turn, and how to read one protocol line. Everything below — line framing,
 * turn lifecycle, abort — is the same for all of them; the process and what it
 * owns are {@link ProcessLifecycle}'s.
 */
export abstract class StdioAgentAdapter extends ProcessLifecycle implements AgentAdapter {
  abstract readonly agentId: string;

  protected sessionId: string | null = null;
  private readonly stdout = new LineBuffer();
  /** Set for the duration of a turn. Outside one, events are buffered rather than dropped. */
  private turnEmit: ((event: AgentEvent) => void) | null = null;
  /** Set for the duration of a turn. Pinged on every raw line, whether or not `handleLine` turns it into an event. */
  private turnActivity: (() => void) | null = null;
  /**
   * Events the agent produced before its first turn — in practice the startup
   * warnings that arrive during the handshake. Dropping them hid the one
   * diagnostic that explains a planner which cannot read the workspace, so they
   * are held until a turn exists to show them in.
   *
   * Only before the *first* turn. Once one has run, anything arriving outside a
   * turn is that closed turn's straggling work — a backgrounded subagent
   * finishing, a late read — and replaying it into the next turn presents it as
   * research done for the user's new message.
   */
  private betweenTurns: AgentEvent[] = [];
  /** Set once a turn has ended: after that, out-of-turn events are stale, not startup. */
  private hadTurn = false;
  /** A task's session, which wants what the agent says on its own after a turn closed; a planner registers none and drops it. */
  private outOfTurnListener: ((event: AgentEvent) => void) | null = null;

  constructor(deps: AgentProcessDeps) {
    super(deps);
    // One listener for the process lifetime; completed turns retain no exit closure.
    void this.runner.ended.then(() => this.turnEmit?.({ type: 'error', message: this.exitMessage() }));
  }

  /**
   * The command line that starts this agent in its read-only mode, given the
   * workspace's own variables (ADR-0016) the process will run under.
   */
  protected abstract spawnSpec(opts: AgentStartOptions, workspace: Record<string, string>): SpawnSpec | Promise<SpawnSpec>;

  /** The bytes written to stdin to open one user turn. Must end with a newline. */
  protected abstract turnPayload(message: string): string;

  /**
   * Interpret one line of the agent's protocol, emitting normalized events.
   * Emitting `turn_end` ends the turn; emitting `error` ends it as a failure.
   */
  protected abstract handleLine(line: string, emit: (event: AgentEvent) => void): void;

  /** Protocol handshake, if the agent needs one before it accepts a turn. */
  protected async handshake(_opts: AgentStartOptions): Promise<void> {}

  async start(opts: AgentStartOptions): Promise<void> {
    this.role = opts.kind;
    await this.launch(opts.cwd, (workspace) => this.spawnSpec(opts, workspace), () => this.handshake(opts));
  }

  /**
   * Spawn `spec`, read its protocol, then run `handshake`. {@link start} is a
   * planner's or a task's launch; a launch that is neither — a query that
   * never opens a turn — comes through here with its own command line.
   */
  protected async launch(cwd: string, spec: (workspace: Record<string, string>) => SpawnSpec | Promise<SpawnSpec>, handshake: () => Promise<void>): Promise<void> {
    await this.startProcess(cwd, async (workspace) => {
      const { command, args, env, envDrop, files, cwd: startIn } = await spec(workspace);
      return { command, args, env: () => env ?? {}, ...(envDrop ? { envDrop } : {}), ...(files ? { files } : {}), ...(startIn ? { cwd: startIn } : {}) };
    }, () => {
      this.readProtocol();
      return handshake();
    });
  }

  /**
   * Every protocol line goes to `handleLine`, turn or no turn: an agent's
   * handshake and its session-id announcement both arrive before the first
   * message is sent, and dropping them left the handshake waiting on a reply
   * that had already come and gone.
   */
  private readProtocol(): void {
    const deliver = (line: string) => {
      // Ahead of `handleLine`, which some agents (Claude Code's subagent
      // transcript) deliberately parse into nothing at all — the process is
      // still working even on a line that yields no event.
      this.turnActivity?.();
      this.handleLine(line, (event) => this.announce(event));
    };
    this.runner.readStdout(
      (text) => this.stdout.push(text, deliver),
      // The pipe can close with a final line complete but unterminated. The
      // process's own last line is often the one that matters — a failure or a
      // turn end — so it is delivered rather than dropped.
      () => {
        const rest = this.stdout.flush();
        if (rest) deliver(rest);
      },
    );
  }

  /**
   * Deliver an event that no protocol line carries, the way a line's would be:
   * to the open turn, or held for the first one.
   */
  protected announce(event: AgentEvent): void {
    if (this.turnEmit) this.turnEmit(event);
    else if (this.hadTurn && this.outOfTurnListener) this.outOfTurnListener(event);
    else if (!this.hadTurn && !TURN_SCOPED_EVENTS.has(event.type) && this.betweenTurns.length < BETWEEN_TURN_EVENT_CAP) {
      this.betweenTurns.push(event);
    }
  }

  /** The environment the agent was spawned under, for any side process a handshake needs. */
  protected get spawnEnv(): NodeJS.ProcessEnv { return this.runner.env; }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.process) throw new Error(`${this.agentId} ${this.role} session is not started`);
    if (this.runner.exit) {
      onEvent({ type: 'error', message: this.exitMessage() });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const release = () => {
        settled = true;
        this.turnEmit = null;
        this.turnActivity = null;
        this.hadTurn = true;
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = () => {
        if (settled) return;
        release();
        resolve();
      };
      // A consumer that throws is Ordewell's own failure, not the runner's: it
      // ends the turn and reaches the caller as a rejection, rather than
      // escaping the stdout listener as an uncaught host exception.
      const fail = (err: unknown) => {
        if (settled) return;
        release();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const emit = (event: AgentEvent) => {
        if (settled) return;
        try {
          onEvent(event);
        } catch (err) {
          fail(err);
          return;
        }
        if (event.type === 'turn_end' || event.type === 'error') finish();
      };

      const onAbort = () => {
        if (settled) return;
        // Stop means stop: the agent is holding real context we are abandoning,
        // so the process goes with the turn rather than being left running.
        this.dispose();
        finish();
      };

      this.turnEmit = emit;
      this.turnActivity = onActivity ?? null;
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });

      const buffered = this.betweenTurns;
      this.betweenTurns = [];
      for (const event of buffered) {
        emit(event);
        if (settled) return;
      }

      try {
        this.process!.stdin!.write(this.turnPayload(message));
      } catch (err) {
        emit({ type: 'error', message: `Could not send to ${this.agentId}: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  onOutOfTurn(listener: (event: AgentEvent) => void): void {
    this.outOfTurnListener = listener;
  }

  nativeSessionId(): string | null { return this.sessionId; }

  override dispose(): void {
    if (this.isDisposed) return;
    this.turnEmit = null;
    this.outOfTurnListener = null;
    super.dispose();
  }

  /** Write one raw protocol line to the agent. */
  protected writeLine(payload: unknown): void {
    this.process?.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  protected exitMessage(): string {
    return this.runner.withStderrTail(`The ${this.agentId} ${this.role === 'task' ? 'task runner' : 'planner'} ${this.runner.describeExit()}.`);
  }

  /** Parse a protocol line, ignoring the non-JSON banners some CLIs print. */
  protected static parse<T>(line: string): T | null {
    try {
      const value = JSON.parse(line);
      return typeof value === 'object' && value !== null ? (value as T) : null;
    } catch {
      return null;
    }
  }
}
