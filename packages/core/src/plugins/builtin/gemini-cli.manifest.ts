import type { RunnerManifest } from '../types';

/** How Gemini CLI is started as an ACP agent, the words discovery asks it with. */
export const GEMINI_ACP_ARGS = ['--acp'];

/**
 * Google's Gemini CLI over ACP. Its id is `gemini-cli`, never `gemini`:
 * `google` is the API vendor whose models are Gemini, and a bare `gemini`
 * would read as that vendor's models rather than this agent.
 */
export const GEMINI_CLI_MANIFEST: RunnerManifest = {
  name: 'gemini-cli',
  displayName: 'Gemini CLI',

  runner: { command: 'gemini' },

  features: { permissionModeValues: { plan: 'default' } },

  modelDiscovery: {
    // Gemini lists its models in `session/new`, so ACP answers and there is no
    // command to fall back to (ADR-0040: discovery never gates a pick).
    // Discovery hands it no server and writes nothing, so it runs untrusted,
    // as it was recorded doing; the task's start adds the trust (the profile).
    method: 'acp',
    acp: { args: GEMINI_ACP_ARGS },
    discoveryCommands: [],
  },

  // Gemini has no login or status command: `gemini` itself offers its sign-in
  // on a first start, and a key may come from its settings or the environment.
  // A signed-out agent refuses `session/new` with ACP's auth-required error,
  // which the adapter words as "not signed in"; Gemini's own words are kept
  // for a message that reaches the person unworded.
  auth: { loginArgs: [], signedOut: /API key is missing or not configured|Authentication required|not signed in/i },
  // Gemini's own session mode ids, set with `session/set_mode`. Its default
  // mode runs a command it deems safe (`echo`) without asking, as recorded, so
  // the description does not promise that every command waits. The read-only
  // mode keeps the id `plan` a plan names, but runs Gemini's `default` under
  // Ordewell's policy (the profile's `restricted`): Gemini's own plan mode
  // denies Ordewell's tools and allows writing a `.md` file, so it is never
  // set (ADR-0046).
  modes: [
    { id: 'default', label: 'Ask before actions', description: 'Edits and commands wait for your approval, except commands Gemini deems safe', safe: true },
    { id: 'autoEdit', label: 'Auto-approve edits', description: 'Gemini writes files without asking; commands still wait' },
    { id: 'yolo', label: 'Allow all', description: 'Gemini runs edits and commands without asking', autonomous: true },
    { id: 'plan', label: 'Read-only', description: 'Ordewell commands with Gemini\'s own writes, shell and web off; lands nothing', readOnly: true },
  ],
};
