import type { RunnerManifest } from '../types';
import { parsePiModels } from './piModels';

/**
 * Pi, driven over its own RPC mode (`pi --mode rpc`). Pi has no permission
 * modes: what it may do is the tool set it starts with, so a mode here picks
 * that set and asks for nothing at run time.
 */
export const PI_MANIFEST: RunnerManifest = {
  name: 'pi',
  displayName: 'Pi',

  runner: { command: 'pi' },

  features: {},

  modelDiscovery: {
    method: 'command',
    // Lists the models of every provider with credentials, as a table; no
    // fallback list, so the picker shows only what this user can run.
    discoveryCommands: [{ command: 'pi', args: ['--list-models'], parser: parsePiModels }],
    providerQualifiedIds: true,
  },

  contextFile: 'AGENTS.md',

  // Pi signs in per provider, and `pi auth check` needs one named, so there is
  // no single status to ask.
  signIn: 'run pi auth login <provider>, or set the provider\'s API key',

  modes: [
    { id: 'agent', label: 'Agent', description: 'All of Pi\'s tools, run without asking: Pi has no per-tool approval', autonomous: true, safe: true },
    { id: 'plan', label: 'Read-only', description: 'Reads inside the workspace and Ordewell commands; lands nothing', readOnly: true },
  ],
};
