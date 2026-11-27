import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { LineBuffer, type AgentProcessDeps } from './AgentAdapter';
import { CodexRpc, type RpcMessage } from './codexRpc';
import { RunnerProcess } from './runnerProcess';
import { settleWithin } from './settleWithin';
import type { RunnerEnv } from '../../plugins/types';

/**
 * One raw model entry from an app-server `model/list` response. Field names are
 * the protocol's, not Ordewell's.
 */
export interface AppServerModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}

const DEFAULT_TIMEOUT_MS = 20_000;

export interface AppServerModelsOptions {
  /** How long the whole handshake gets before the call answers `null`. */
  timeout?: number;
  signal?: AbortSignal;
  /** The environment the runner is launched with, which can name its account and home; this process's when absent. */
  env?: RunnerEnv;
  /** Tests inject the process boundary; the real call stays on the defaults. */
  deps?: Partial<AgentProcessDeps>;
}

function definedOnly(env: RunnerEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** A protocol line, or null for the banners some CLIs print beside their JSON. */
function parseRpcLine(line: string): RpcMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as RpcMessage) : null;
  } catch {
    return null;
  }
}

/** A running `app-server`: its RPC client, a way to notify it, and the moment it can answer nothing more. */
export interface AppServerConnection {
  rpc: CodexRpc;
  /** A notification: no id, so no answer. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Resolves when the process ends or stops reading its input: no answer will come after it. */
  gone: Promise<void>;
  /** Takes the process down tree-wide; safe to call twice. */
  dispose(): void;
}

export interface AppServerLaunch {
  /** Where it runs. Neither caller has a workspace of its own, so neither pays a direnv round trip. */
  cwd: string;
  /** What the server sends that is not an answer: its notifications and its own requests. */
  onMessage?: (message: RpcMessage) => void;
  deps?: Partial<AgentProcessDeps>;
}

/**
 * Spawn a runner that speaks Codex's `app-server` protocol and wire its
 * stdout to a {@link CodexRpc}; null when it cannot be launched (a missing
 * binary, a vanished cwd). This is the adapter path's process and RPC
 * client, not a second copy of them: {@link RunnerProcess} owns the group
 * kill, the EPIPE-safe stdin, the stderr tail and UTF-8 decoding across chunk
 * boundaries, and {@link CodexRpc} owns the ids and the pending-response map.
 */
export async function openAppServer(command: string, args: string[], launch: AppServerLaunch): Promise<AppServerConnection | null> {
  const runner = new RunnerProcess({
    spawn: nodeSpawn,
    fetch: globalThis.fetch,
    // The cwd is no workspace, so it pays no direnv round trip before a spawn
    // with a deadline. Discovery and the account monitor pass the workspace's
    // environment themselves, since that can choose whose account is read.
    workspaceEnv: async () => ({}),
    ...launch.deps,
  });

  let child: ChildProcess | null = null;
  const write = (payload: unknown) => {
    try {
      child?.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The process is gone; `gone` is what answers the caller.
    }
  };
  const rpc = new CodexRpc(write);
  const lines = new LineBuffer();
  const deliver = (line: string) => {
    const message = parseRpcLine(line);
    if (message && !rpc.dispatch(message, () => {})) launch.onMessage?.(message);
  };

  // A server that stopped reading its input can keep running forever; the
  // write racing its death fails with EPIPE, and no answer will ever come, so
  // that failure ends the wait like the process ending does.
  let inputBroken!: () => void;
  const broken = new Promise<void>((resolve) => { inputBroken = resolve; });

  try {
    await runner.start(launch.cwd, () => ({ command, args }), (started) => {
      child = started;
      started.stdin?.on('error', () => inputBroken());
      runner.readStdout(
        (text) => lines.push(text, deliver),
        () => {
          const rest = lines.flush();
          if (rest) deliver(rest);
        },
      );
      return Promise.resolve();
    });
  } catch {
    runner.dispose();
    return null;
  }

  // A request still waiting when the process ends fails at once instead of
  // sitting out the deadline, and a late write is dropped.
  void runner.ended.then(() => rpc.close('The app-server process ended.'));

  return {
    rpc,
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    gone: Promise.race([runner.ended, broken]),
    dispose: () => {
      rpc.close('The app-server connection was closed.');
      runner.dispose();
    },
  };
}

/** What Ordewell calls itself in `initialize`. */
export const APP_SERVER_CLIENT_INFO = { name: 'ordewell', title: 'Ordewell', version: '0.1.0' };

/**
 * The live model catalog of a runner that speaks Codex's `app-server`
 * protocol: spawn it, run `initialize` → `model/list`, and take the list —
 * null on any failure (missing binary, an early exit, no answer before the
 * deadline, a malformed response) so the caller falls through to its cache.
 * The process is always taken down tree-wide, so a `codex` shim's
 * interpreter cannot outlive the call.
 */
export async function discoverAppServerModels(
  command: string,
  args: string[],
  options: AppServerModelsOptions = {},
): Promise<AppServerModel[] | null> {
  if (options.signal?.aborted) return null;
  const env = options.env;
  const server = await openAppServer(command, args, {
    cwd: process.cwd(),
    deps: { ...(env ? { workspaceEnv: async () => definedOnly(env) } : {}), ...options.deps },
  });
  if (!server) return null;
  if (options.signal?.aborted) { server.dispose(); return null; }
  const cancel = () => server.dispose();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const { rpc } = server;

  const asked = (async (): Promise<AppServerModel[] | null> => {
    const initialized = await rpc.call('initialize', { clientInfo: APP_SERVER_CLIENT_INFO });
    if (!initialized.ok) return null;
    const listed = await rpc.call('model/list', {});
    if (!listed.ok) return null;
    const data = listed.result.data;
    return Array.isArray(data) ? (data as AppServerModel[]) : null;
  })();

  try {
    return await settleWithin(asked, {
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
      onTimeout: () => null,
      ended: server.gone,
      onEnded: () => null,
    });
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    server.dispose();
  }
}
