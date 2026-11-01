import { ORDEWELL_MCP_SERVER_NAME, PLANNER_TOOLS, READ_ONLY_TASK_TOOLS, TASK_TOOLS, taskToolSet, type McpCredential } from '../mcp';
import type { PlannerStartOptions } from './AgentAdapter';
import { settleWithin } from './settleWithin';

export class McpAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAttachError';
  }
}

/**
 * A runner whose process stayed up but which never reported the server
 * connected. Its task is held rather than failed: nothing was sent to it, and
 * a start on a less loaded machine can still run it.
 */
export class McpAttachTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAttachTimeout';
  }
}

/**
 * How long a runner that stays alive may keep reporting the server `pending`
 * before the spawn is called a missed connection. A machine under heavy load
 * can take well past ten seconds to schedule a CLI and finish an MCP
 * handshake, and giving up early turned a slow start into a failed task. Two
 * minutes is long enough for a loaded machine and short enough that a hung
 * process gives its slot back. A runner that reports `failed`, or whose
 * process exits, ends the wait at once instead of running to this cap.
 */
export const MCP_ATTACH_TIMEOUT_MS = 120_000;

/**
 * A runner that exited on its own while starting, in its own last words. It
 * refused what it was started with (a resume it cannot find, a flag it does
 * not know), so a respawn on the same arguments would only fail again.
 */
export class RunnerStartupExit extends Error {
  constructor(lastWords: string) {
    super(lastWords);
    this.name = 'RunnerStartupExit';
  }
}

/** Which token's tools a runner is handed (ADR-0022, A1); a read-only task's add `run_command`, `fetch` and `web_search` (ADR-0046). */
export type OrdewellToolRole = 'task' | 'readOnlyTask' | 'planner';

/** A runner's report on the Ordewell server's connection, in one vocabulary for every runner. */
export type AttachState = 'connected' | 'pending' | 'failed';

/**
 * How one runner is handed the Ordewell MCP server (ADR-0022): the names it
 * calls the server's tools by, which of its permission requests are for them,
 * and what its report of the connection means. Each runner's binding adds how
 * the server is written into that runner's launch or configuration, which has
 * no common shape.
 *
 * `Ask` is the runner's own permission request, as far as telling one for an
 * Ordewell tool needs it.
 */
export interface OrdewellToolBinding<Ask = never> {
  /** The name the runner calls an Ordewell tool by, and reports its calls and requests under. */
  toolName(tool: string): string;
  /** Every tool `role` is given, under the runner's names, in the server's order, less those its token hides. */
  toolNames(role: OrdewellToolRole, hidden?: readonly string[], extra?: readonly string[]): string[];
  /**
   * The planner tools this runner's planner token hides, by their names on
   * the server: those it carries natively (ADR-0027), which a model offered
   * both tends to take from Ordewell instead.
   */
  plannerHidden(start: PlannerStartOptions): string[];
  /**
   * Who receives the runner's own search when that search raises no
   * permission request and is set on or off for the whole session
   * (ADR-0027), so the web-read policy decides it at session start, as
   * {@link PlannerStartOptions.nativeSearch}. Absent for a runner whose
   * searches are asked one by one.
   */
  sessionSearchProvider?: string;
  /** Whether a permission request is for one of the server's tools, which is never refused or left waiting (ADR-0022, S3). */
  isOrdewellAsk(ask: Ask): boolean;
  /** What the runner's own status word for the server says about its connection. */
  attachState(status: string | null | undefined): AttachState;
}

/** The tools of a role, by their names on the server, less `hidden`. */
export function ordewellToolNames(role: OrdewellToolRole, hidden: readonly string[] = [], extra: readonly string[] = []): string[] {
  const tools = role === 'task' ? TASK_TOOLS : role === 'readOnlyTask' ? READ_ONLY_TASK_TOOLS : PLANNER_TOOLS;
  return [...tools.map((tool) => tool.name).filter((tool) => !hidden.includes(tool)), ...extra];
}

/** Every tool the server serves, under any role, by its name on the server. */
export const ORDEWELL_TOOL_NAMES: readonly string[] = [...new Set([...TASK_TOOLS, ...taskToolSet({ board: true }), ...READ_ONLY_TASK_TOOLS, ...PLANNER_TOOLS].map((tool) => tool.name))];

/** The naming half of a binding for a runner that names a server's tool `<prefix><tool>`. */
export function prefixedToolNames(prefix: string): Pick<OrdewellToolBinding, 'toolName' | 'toolNames'> & { isToolName(name: string): boolean } {
  const names = new Set(ORDEWELL_TOOL_NAMES.map((tool) => `${prefix}${tool}`));
  return {
    toolName: (tool) => `${prefix}${tool}`,
    toolNames: (role, hidden, extra) => ordewellToolNames(role, hidden, extra).map((tool) => `${prefix}${tool}`),
    // Exact, never by prefix: a server whose name extends Ordewell's (`ordewell__x`, `ordewell_x`) names its tools under the same prefix.
    isToolName: (name) => names.has(name),
  };
}

/** `mcp__<server>__<tool>`: how Claude Code names an MCP tool, and the name Codex's `exec` tool lists one under too. */
export const MCP_CLIENT_TOOL_NAMES = prefixedToolNames(`mcp__${ORDEWELL_MCP_SERVER_NAME}__`);

/** `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** An adapter as {@link spawnAttached} handles it. */
interface SpawnedAdapter {
  dispose(): void;
  /**
   * Absent: the runner cannot be handed the server at all. `false` is the old
   * boolean answer for a runner that has not attached (a timeout), kept for
   * simple test adapters; the real adapters say `pending` or `failed`.
   */
  mcpAttached?(): Promise<boolean | AttachState>;
}

/** A runner spawned with the Ordewell server connected, and the token it was spawned with. */
export interface AttachedSpawn<A> {
  adapter: A;
  token: string;
}

/** What {@link spawnAttached} needs of the runner it spawns and the server it hands it. */
export interface SpawnAttachSteps<A extends SpawnedAdapter> {
  /** The runner as failures name it. */
  runner: string;
  create(): A;
  issueToken(): Promise<McpCredential>;
  revoke(token: string): void;
  /** Start `adapter` on `credential`. A throw means the runner cannot be spawned at all, so it is not respawned. */
  start(adapter: A, credential: McpCredential): Promise<void>;
  /** Defaults to the adapter's own `dispose`. */
  dispose?(adapter: A): void;
  /**
   * Aborted once nobody wants the runner any more: what was spawned is taken
   * back and nothing is returned. Neither a start nor an attach check is waited
   * for: a dispose before the start has launched its process stops the launch.
   */
  cancelled?: AbortSignal;
  /**
   * How a process that exited while starting ended, in its own words; null
   * while it runs. Its attach report is not believed, and it is not respawned.
   */
  startupExit?(): string | null;
  /** Why the first spawn failed, told before the respawn. */
  onRespawn?(failure: string): void;
  /** The {@link McpAttachError}'s or {@link McpAttachTimeout}'s message once the respawn failed too. */
  failed(first: string, second: string): string;
}

const CANCELLED = Symbol('cancelled');

/**
 * Why one spawn did not attach. `failed` is the runner's own report that the
 * server cannot connect (a configuration problem); `unreachable` is a wait
 * that ran out while the runner was still starting.
 */
interface SpawnFailure {
  kind: 'failed' | 'unreachable';
  message: string;
}

/** `report`, with the old boolean answer read as connected or still pending. */
function attachReport(report: boolean | AttachState): AttachState {
  return report === true ? 'connected' : report === false ? 'pending' : report;
}

/** `work`'s outcome, or {@link CANCELLED} as soon as `signal` aborts, whichever comes first. */
function unlessCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof CANCELLED> {
  if (!signal) return work;
  // Settles after the adapter it belongs to was taken back, for nobody.
  work.catch(() => {});
  return new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(CANCELLED); return; }
    const onAbort = () => resolve(CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One runner with Ordewell's tools attached (ADR-0025): a spawn that does not
 * report the server connected is killed with its token and respawned once on
 * a fresh one. A second wait that ran out throws {@link McpAttachTimeout}, so
 * the task can be held; a runner that reported the server failed, or could
 * not be checked, throws {@link McpAttachError} instead. One that exited while
 * starting throws {@link RunnerStartupExit}. Null once
 * {@link SpawnAttachSteps.cancelled}, with nothing left running.
 */
export async function spawnAttached<A extends SpawnedAdapter>(steps: SpawnAttachSteps<A>): Promise<AttachedSpawn<A> | null> {
  const first = await spawnOnce(steps);
  if (!isSpawnFailure(first)) return first;
  steps.onRespawn?.(first.message);
  const second = await spawnOnce(steps);
  if (!isSpawnFailure(second)) return second;
  const message = steps.failed(first.message, second.message);
  // One real failure is enough: a respawn cannot configure the server either.
  if (first.kind === 'failed' || second.kind === 'failed') throw new McpAttachError(message);
  throw new McpAttachTimeout(message);
}

function isSpawnFailure<A>(spawned: AttachedSpawn<A> | SpawnFailure | null): spawned is SpawnFailure {
  return spawned !== null && 'kind' in spawned;
}

async function spawnOnce<A extends SpawnedAdapter>(steps: SpawnAttachSteps<A>): Promise<AttachedSpawn<A> | SpawnFailure | null> {
  let credential: McpCredential;
  try {
    credential = await steps.issueToken();
  } catch (err) {
    return { kind: 'failed', message: `Ordewell's MCP server could not issue a token (${errorText(err)})` };
  }
  const { token } = credential;
  const signal = steps.cancelled;
  if (signal?.aborted) {
    steps.revoke(token);
    return null;
  }
  let adapter: A;
  try {
    adapter = steps.create();
  } catch (err) {
    steps.revoke(token);
    throw err;
  }
  let takenBack = false;
  const takeBack = () => {
    if (takenBack) return;
    takenBack = true;
    signal?.removeEventListener('abort', takeBack);
    if (steps.dispose) steps.dispose(adapter);
    else adapter.dispose();
    steps.revoke(token);
  };
  if (!adapter.mcpAttached) {
    takeBack();
    return { kind: 'failed', message: `${steps.runner} cannot be handed Ordewell's MCP server` };
  }
  try {
    // A start that hangs must not outlive the Stop that cancelled it.
    if (await unlessCancelled(steps.start(adapter, credential), signal) === CANCELLED) {
      takeBack();
      return null;
    }
  } catch (err) {
    takeBack();
    throw err;
  }
  if (signal?.aborted) {
    takeBack();
    return null;
  }
  // In the abort itself: whoever cancelled already reports the runner gone,
  // and the check can wait out its whole deadline.
  signal?.addEventListener('abort', takeBack, { once: true });
  const failure = `${steps.runner} did not report Ordewell's MCP server connected`;
  let state: AttachState = 'pending';
  try {
    const report = await unlessCancelled(adapter.mcpAttached(), signal);
    if (report === CANCELLED) return null;
    state = attachReport(report);
    const exit = steps.startupExit?.() ?? null;
    if (exit !== null) {
      takeBack();
      throw new RunnerStartupExit(exit);
    }
  } catch (err) {
    if (err instanceof RunnerStartupExit) throw err;
    takeBack();
    return { kind: 'failed', message: `${steps.runner} could not check Ordewell's MCP attach state (${errorText(err)})` };
  }
  if (signal?.aborted) return null;
  if (state === 'connected') {
    signal?.removeEventListener('abort', takeBack);
    return { adapter, token };
  }
  takeBack();
  return { kind: state === 'failed' ? 'failed' : 'unreachable', message: failure };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the runner until it reports the server connected or failed, or the
 * deadline passes. `probe` gets the time left and answers with the runner's
 * latest report, waiting for one however it must. Running out of time is
 * `pending`: the runner was still starting when the wait ended. Each probe is
 * raced against that time and against `ended`, so a request that never
 * answers cannot outlast the cap, and a process that exits (`failed`: no
 * answer will ever come) ends the wait at once.
 */
export async function awaitAttach(
  probe: (msLeft: number) => Promise<AttachState>,
  timeoutMs: number,
  pollMs: number,
  ended?: Promise<unknown>,
): Promise<AttachState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return 'pending';
    const onTimeout = (): AttachState => 'pending';
    const state = await settleWithin(probe(left), ended
      ? { timeoutMs: left, onTimeout, ended, onEnded: (): AttachState => 'failed' }
      : { timeoutMs: left, onTimeout });
    if (state !== 'pending') return state;
    if (pollMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
      });
    }
  }
}
