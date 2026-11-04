import type { RunnerManifest } from '../types';

/** How Cursor's CLI is started as an ACP agent, the words discovery asks it with. */
export const CURSOR_ACP_ARGS = ['acp'];

/**
 * Cursor's CLI agent over ACP. Its id is its command's name, `cursor-agent`,
 * never a bare `cursor`, which would read as an editor or a model vendor
 * rather than this agent. The installer also links the same binary as
 * `agent`, a name too generic to look up on a PATH, so the longer name is the
 * one started.
 */
export const CURSOR_AGENT_MANIFEST: RunnerManifest = {
  name: 'cursor-agent',
  displayName: 'Cursor',

  runner: { command: 'cursor-agent' },

  features: {},

  modelDiscovery: {
    // Cursor lists its models in `session/new`'s `model` option, so ACP
    // answers and there is no command to fall back to (ADR-0040: discovery
    // never gates a pick).
    method: 'acp',
    acp: { args: CURSOR_ACP_ARGS },
    discoveryCommands: [],
  },

  // `cursor-agent status` exits 0 signed in or out, so it cannot be the
  // status check. A signed-out agent refuses `session/new` with ACP's
  // auth-required error, which the adapter words as "not signed in".
  auth: { loginArgs: ['login'], signedOut: /Authentication required|not signed in/i },
  // `--force` is Cursor's allow-all switch, given at spawn (the profile). Its
  // default mode asks before a command or MCP tool outside the user's Cursor
  // allowlist, and writes a file edit without asking, as recorded, so the
  // description promises no ask before an edit. Cursor's `plan` and `ask`
  // modes are not offered as the read-only mode: no recording shows either
  // refusing a write and a command (ADR-0046).
  modes: [
    { id: 'default', label: 'Ask before commands', description: 'Commands and MCP tools outside your Cursor allowlist wait for approval; Cursor writes file edits without asking', safe: true },
    { id: 'force', label: 'Allow all', description: 'Cursor runs commands and tools without asking (--force)', autonomous: true },
  ],
};
