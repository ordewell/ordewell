import type { RunnerLaunch } from '../executionLease';
import { SIGN_IN_HOSTS } from './credentialBroker';
import { ANTHROPIC_API, OPENAI_API, type ModelApi } from './modelGateway';
import { COPY_CODEX_SIGN_IN, COPY_SIGN_IN, CODEX_SIGN_IN_FILE, SIGN_IN_COPY } from './taskWorkspace';

/** Where a person's own sign-in to Claude Code is kept: theirs, made in a container, and never read here (ADR-0059 L7). */
export const LOGIN_VOLUME = 'ordewell-login-claude-code';
export const CODEX_LOGIN_VOLUME = 'ordewell-login-codex';

/** What a task's container holds for its runner to find. */
export interface PlacedRunner {
  /** The gateway's port on the container's loopback, under a key the gateway holds. */
  gatewayPort: number | null;
  signedIn: boolean;
}

/** A person's own sign-in for one runner, and how a task gets its copy of it: a runner never sees the volume (ADR-0059 L7). */
export interface ContainerSignIn {
  /** The kept volume, which a helper mounts read-only at `/login`. */
  volume: string;
  /** Where the runner talks to its service once it holds that sign-in. */
  hosts: readonly string[];
  /** The helper's command, which leaves the task's copy in its volume and exits 3 for a sign-in that is no use. */
  copy: readonly string[];
  /** The copy, which the runner can read: a probe's proof that `cred.unreadable` does not hold. */
  path: string;
  env: Readonly<Record<string, string>>;
}

/** One runner a container has been proven with: all a lease knows of it. A protocol that needs this host's loopback or its own sandbox has not. */
export interface ContainerRunner {
  id: string;
  /** What the image has to hold. */
  binary: string;
  /** The model API its login is for: a key for any other stays on this host. */
  api: ModelApi;
  signIn: ContainerSignIn;
  /** Its launch's arguments, for what it cannot be told by a variable. */
  args(launch: RunnerLaunch, placed: PlacedRunner): readonly string[];
}

/*
 * `app-server` reads neither OPENAI_API_KEY nor OPENAI_BASE_URL: only a provider
 * of its own in `-c` reaches a base URL with a key, and it names the variable
 * that holds the key, which is the gateway's token here. Not over WebSockets,
 * which the gateway does not carry.
 */
function codexArgs(launch: RunnerLaunch, { gatewayPort, signedIn }: PlacedRunner): readonly string[] {
  if (launch.args[0] !== 'app-server') return launch.args;
  const { keyVariable, basePath } = OPENAI_API;
  const gateway = gatewayPort === null ? [] : [
    '-c', `model_providers.gateway={name="gateway",base_url="http://127.0.0.1:${gatewayPort}${basePath}",env_key="${keyVariable}",wire_api="responses",supports_websockets=false}`,
    '-c', 'model_provider="gateway"',
  ];
  // No keyring in a container, and a task's copy is the file a helper wrote.
  const store = signedIn ? ['-c', 'cli_auth_credentials_store="file"'] : [];
  return [...launch.args, ...gateway, ...store];
}

export const CONTAINER_RUNNERS: readonly ContainerRunner[] = [
  {
    id: 'claude-code',
    binary: 'claude',
    api: ANTHROPIC_API,
    signIn: { volume: LOGIN_VOLUME, hosts: SIGN_IN_HOSTS, copy: ['sh', '-c', COPY_SIGN_IN], path: SIGN_IN_COPY, env: { CLAUDE_CONFIG_DIR: SIGN_IN_COPY } },
    args: (launch) => launch.args,
  },
  {
    id: 'codex',
    binary: 'codex',
    api: OPENAI_API,
    // Without auth.openai.com: no task's copy holds a refresh token to spend there (ADR-0059 L7).
    signIn: { volume: CODEX_LOGIN_VOLUME, hosts: ['chatgpt.com'], copy: ['node', '-e', COPY_CODEX_SIGN_IN], path: CODEX_SIGN_IN_FILE, env: {} },
    args: codexArgs,
  },
];

export const containerRunner = (id: string | undefined): ContainerRunner | undefined => CONTAINER_RUNNERS.find((runner) => runner.id === id);

export const signInRemedy = ({ volume }: ContainerSignIn): string => `Sign in as docs/containers.md shows, so it is kept in the ${volume} volume.`;
