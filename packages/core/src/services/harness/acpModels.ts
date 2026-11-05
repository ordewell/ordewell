import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DiscoveredModel } from '../../models/Task';
import type { RunnerEnv } from '../../plugins/types';
import { openAppServer } from './appServerModels';
import { currentValue, findOption, optionValues } from './acpOptions';
import { ACP_INITIALIZE_PARAMS, newSessionResponseSchema, parseAcp, type AcpSessionState } from './acpSchema';
import { METHOD_NOT_FOUND } from './jsonRpc';
import { settleWithin } from './settleWithin';

const DEFAULT_TIMEOUT_MS = 20_000;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The models a new session offers, from its model option or, failing that, the
 * older `models` list. The effort option describes the model the session is on
 * and no other, so only that model carries its values as variants: naming them
 * on a model the agent never said accepts them would offer a choice that may
 * fail at spawn. Empty when the session offers no model choice.
 */
export function modelsFromSession(state: AcpSessionState): DiscoveredModel[] {
  const options = state.configOptions ?? [];
  const model = findOption(options, 'model');
  if (model) {
    const effort = findOption(options, 'effort');
    const variants = effort ? optionValues(effort).map(({ value }) => ({ id: value, label: titleCase(value) })) : [];
    const current = currentValue(model);
    return optionValues(model).map(({ value, name }) => ({
      modelId: value,
      modelLabel: name || value,
      variants: value === current ? variants : [],
    }));
  }
  return (state.models?.availableModels ?? []).map((m) => ({ modelId: m.modelId, modelLabel: m.name || m.modelId, variants: [] }));
}

export interface AcpModelsOptions {
  /** How long the whole handshake gets before the call answers `null`. */
  timeout?: number;
  /** The environment the agent is launched with, which can name its account and home. */
  env?: RunnerEnv;
}

function definedOnly(env: RunnerEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * What an ACP agent offers for a model: spawn it, `initialize`, then
 * `session/new` in an empty scratch directory with no MCP servers, and read
 * the session's options. No prompt is sent, so nothing is billed and nothing
 * is written to a workspace. Null on any failure, signed out included, so the
 * caller falls back to the manifest's other discovery; the process group is
 * always taken down.
 */
export async function discoverAcpModels(command: string, args: string[], options: AcpModelsOptions = {}): Promise<DiscoveredModel[] | null> {
  let scratch: string;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'ordewell-acp-models-'));
  } catch {
    return null;
  }
  const env = options.env;
  const agent = await openAppServer(command, args, {
    cwd: scratch,
    // The agent may ask the client for something; discovery grants nothing.
    onMessage: (message) => {
      if (message.method && message.id !== undefined) agent?.rpc.respondError(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    },
    deps: env ? { workspaceEnv: async () => definedOnly(env) } : {},
  });
  try {
    if (!agent) return null;
    const asked = (async (): Promise<DiscoveredModel[] | null> => {
      const initialized = await agent.rpc.call('initialize', { ...ACP_INITIALIZE_PARAMS });
      if (!initialized.ok) return null;
      const session = await agent.rpc.call('session/new', { cwd: scratch, mcpServers: [] });
      if (!session.ok) return null;
      const parsed = parseAcp(newSessionResponseSchema, session.result);
      return parsed.ok ? modelsFromSession(parsed.value) : null;
    })();
    return await settleWithin(asked, {
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
      onTimeout: () => null,
      ended: agent.gone,
      onEnded: () => null,
    });
  } finally {
    agent?.dispose();
    // Windows refuses to remove a directory a process still has as its cwd,
    // and the agent just killed lets go of it only once it has exited: the
    // retries outwait that rather than leave the directory behind.
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
