import { qwenCredentials } from '../../services/harness/qwenCredentials';
import type { RunnerManifest } from '../types';

/** How Qwen Code is started as an ACP agent; the profile runs it and discovery asks it with the same words. */
export const QWEN_ACP_ARGS = ['--acp'];

/**
 * Qwen Code over ACP. Its id is `qwen-code`: `qwen` is the API vendor id
 * (DashScope), and a runner and a vendor must never share an id.
 */
export const QWEN_CODE_MANIFEST: RunnerManifest = {
  name: 'qwen-code',
  displayName: 'Qwen Code',

  runner: { command: 'qwen' },

  // Ordewell's read-only mode runs in Qwen's own `default`, which asks before
  // every write and command, so the adapter can refuse each by its kind (ADR-0060, R3).
  features: { permissionModeValues: { plan: 'default' } },

  modelDiscovery: {
    // Qwen lists its configured models in `session/new`, so ACP answers and
    // there is no command to fall back to (ADR-0040: discovery never gates a pick).
    method: 'acp',
    // The key Ordewell holds lets discovery list the models a task would get (ADR-0060, R9).
    acp: { args: QWEN_ACP_ARGS, credentials: qwenCredentials },
    discoveryCommands: [],
  },

  // Qwen has no login or status command of its own: it signs in from its
  // settings file or the provider's key variable, and `qwen` itself opens its
  // sign-in on a first start. A signed-out agent is learned from ACP's
  // auth-required error, which the adapter words as "not signed in".
  auth: { loginArgs: [], signedOut: /Authentication required|not signed in/i },
  // Qwen's own mode ids; the profile sets them with `session/set_config_option`.
  // Its default session mode is `auto`, which asks an LLM classifier whether to
  // allow an action: that is not a decision the plan's mode may leave to a
  // model, so no Ordewell mode names it, and every start sets one of these.
  // `plan` is not Qwen's own plan mode, which the model can leave by asking to
  // switch modes: it is `default` under the profile's restricted start, which
  // the recordings show refusing a write and a command (ADR-0046).
  modes: [
    { id: 'default', label: 'Ask before actions', description: 'Edits and commands wait for your approval', safe: true },
    { id: 'auto-edit', label: 'Auto-approve edits', description: 'Qwen writes files without asking; commands still wait' },
    { id: 'yolo', label: 'Allow all', description: 'Qwen runs edits and commands without asking', autonomous: true },
    { id: 'plan', label: 'Read-only', description: 'Native reads and Ordewell commands; lands nothing', readOnly: true },
  ],
};
