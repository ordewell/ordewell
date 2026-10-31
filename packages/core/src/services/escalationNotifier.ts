import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { killTree, onHostTeardown } from '../utils/processTree';
import { augmentedPath } from '../utils/shellPath';
import { runnerEnv } from './harness/runnerEnv';
import type { Escalation } from './escalations';

/** Runs the command with `env` added to its environment; rejects when it fails. */
export type NotifyRun = (command: readonly string[], env: Record<string, string>) => Promise<void>;

export interface EscalationNotifierDeps {
  /** The user's command, read as each new escalation appears; empty when there is none. */
  command: () => readonly string[];
  run: NotifyRun;
  log: (message: string) => void;
}

/** How long a command has before it is stopped: a notification is sent in moments, or it is not coming. */
const NOTIFY_TIME_LIMIT_MS = 10_000;

/** How many commands run at once: a stop can raise many escalations together, and each would be a process. */
const NOTIFY_CONCURRENCY = 2;

/** How many wait their turn: past this, a command that hangs would be telling of a stop long over. The list still holds what is dropped. */
const NOTIFY_QUEUE_CAP = 32;

/** Longest a variable runs, in characters: enough to read, and no way for a runner to fill a process's environment. */
const TEXT_CAP = 500;

/**
 * Text fit to hand a process: part of an escalation is written by a runner, so
 * it is untrusted. Control and format characters go, so a line break or a bidi
 * override cannot forge what a notification shows, and a cut never splits a
 * character.
 */
function plainText(text: string): string {
  const chars = [...text.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').trim()];
  return chars.length > TEXT_CAP ? `${chars.slice(0, TEXT_CAP - 1).join('')}…` : chars.join('');
}

/** Every variable is always set, so a script reading one under `set -u` still runs on a wait of the run itself. */
function notifyEnv({ id, kind, task, reason }: Escalation): Record<string, string> {
  return {
    ORDEWELL_ESCALATION_ID: plainText(id),
    ORDEWELL_ESCALATION_KIND: kind,
    ORDEWELL_ESCALATION_TASK: task ? plainText(`${task.ref} ${task.title}`) : '',
    ORDEWELL_ESCALATION_REASON: plainText(reason),
  };
}

/** One telling, read as its escalation appeared, whenever its turn comes. */
interface NotifySend {
  command: readonly string[];
  env: Record<string, string>;
}

/**
 * Tells the user's notify command of each new escalation, once (ADR-0053). It
 * sees the list as it goes out, so nothing here is a second reading of the run,
 * and it remembers only ids, in memory: what a run waits on stays derived.
 * Nothing it does reaches the run: the command is started and left, and a
 * failure ends here. A few run at a time and the rest wait in a bounded queue,
 * so an id dropped from a full queue still counts as told: it stays on the list.
 */
export class EscalationNotifier {
  /** The ids told of in this plan; null while a plan changes hands. */
  private told: Set<string> | null = new Set();
  private failureLogged = false;
  private dropLogged = false;
  private running = 0;
  private readonly queue: NotifySend[] = [];

  constructor(private readonly deps: EscalationNotifierDeps) {}

  /** The list as a status update carries it. */
  changed(list: readonly Escalation[]): void {
    const { told } = this;
    if (!told) return;
    const fresh = list.filter((escalation) => !told.has(escalation.id));
    for (const escalation of fresh) {
      told.add(escalation.id);
      this.tell(escalation);
    }
  }

  /**
   * A plan is on its way out, and nothing it says now is news: a run stopped
   * by leaving its session raises waits nobody is there for. Lasts until the
   * next {@link baseline}, so a plan on its way in says nothing either.
   */
  hush(): void {
    this.told = null;
  }

  /** What waits as a plan is adopted counts as told, so a restart does not send what was sent before it. */
  baseline(list: readonly Escalation[]): void {
    this.told = new Set(list.map(({ id }) => id));
  }

  private tell(escalation: Escalation): void {
    let send: NotifySend;
    try {
      send = { command: this.deps.command(), env: notifyEnv(escalation) };
    } catch (err) {
      this.failed([], err);
      return;
    }
    if (send.command.length === 0) return;
    if (this.running < NOTIFY_CONCURRENCY) void this.send(send);
    else if (this.queue.length < NOTIFY_QUEUE_CAP) this.queue.push(send);
    else this.dropped();
  }

  private async send({ command, env }: NotifySend): Promise<void> {
    this.running += 1;
    try {
      await this.deps.run(command, env);
    } catch (err) {
      this.failed(command, err);
    } finally {
      this.running -= 1;
      const next = this.queue.shift();
      if (next) void this.send(next);
    }
  }

  private failed(command: readonly string[], err: unknown): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    // The program alone: an argument can hold a webhook's token.
    const program = command[0] ? `${command[0]} ` : '';
    this.deps.log(`The notify command ${program}failed, and is not retried: ${err instanceof Error ? err.message : String(err)}`);
  }

  private dropped(): void {
    if (this.dropLogged) return;
    this.dropLogged = true;
    this.deps.log(`The notify command was not run for every escalation: more than ${NOTIFY_QUEUE_CAP} were waiting for it. The list still holds them.`);
  }
}

/**
 * A command as the user wrote it: a whole argument vector, or none. A string is
 * refused, not split, because splitting one is a shell's job and there is none.
 */
export function notifyCommandOf(value: unknown): string[] {
  const usable = Array.isArray(value) && value.every((word) => typeof word === 'string') && value[0]?.trim();
  return usable ? [...value as string[]] : [];
}

const warnedNotifyValues = new Set<string>();

/** `ORDEWELL_NOTIFY_COMMAND`: an environment variable holds one string, so the vector is written as a JSON array. */
export function parseNotifyCommand(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const command = notifyCommandOf(parsed);
  if (command.length === 0 && !warnedNotifyValues.has(text)) {
    warnedNotifyValues.add(text);
    console.warn('[EscalationNotifier] Ignored ORDEWELL_NOTIFY_COMMAND: it must be a JSON array of strings, with the program first.');
  }
  return command;
}

function stop(proc: ChildProcess): void {
  if (process.platform === 'win32' || proc.pid === undefined) {
    // No grace: its timer would go with a host on its way out.
    killTree(proc, { setTimeoutImpl: (force) => { force(); return {}; } });
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // It ended as the limit passed.
  }
}

/**
 * Runs the command as a {@link NotifyRun} does: never through a shell, and with
 * the escalation in its environment only, because part of its text comes from
 * a runner. It runs in the user's home with the host's environment, not the
 * workspace's: it belongs to the user.
 *
 * It leads a process group so the limit reaches what it started, but not through
 * `spawnInOwnGroup`: a host's recorded runner groups hold the session against
 * another host (ADR-0049), and this command must never have a say in a run.
 * Neither the process nor the limit keeps a host from exiting, and the limit
 * goes with the host, so the host's teardown stops what is still running.
 */
export async function runNotifyCommand(command: readonly string[], env: Record<string, string>, { timeLimitMs = NOTIFY_TIME_LIMIT_MS } = {}): Promise<void> {
  const [file, ...args] = command;
  const proc = spawn(file, args, {
    cwd: os.homedir(),
    env: runnerEnv(await augmentedPath(), {}, env),
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  proc.unref();
  const leaveTeardown = onHostTeardown(() => stop(proc));
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      clearTimeout(limit);
      leaveTeardown();
    };
    const limit = setTimeout(() => {
      leaveTeardown();
      stop(proc);
      reject(new Error(`no answer within ${timeLimitMs} ms, so it was stopped`));
    }, timeLimitMs);
    limit.unref();
    proc.once('error', (err) => {
      settle();
      reject(err);
    });
    proc.once('exit', (code, signal) => {
      settle();
      if (code === 0) resolve();
      else reject(new Error(code === null ? `ended on ${signal}` : `exited with code ${code}`));
    });
  });
}
