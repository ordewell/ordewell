import { posix } from 'path';
import type { RunnerLaunch } from '../executionLease';
import { SIGN_IN_HOSTS } from './credentialBroker';
import { ANTHROPIC_API, OPENAI_API, type ModelApi } from './modelGateway';
import { ASK_SIGN_IN, COPY_CODEX_SIGN_IN, COPY_OPENCODE_SIGN_IN, COPY_SIGN_IN, CODEX_SIGN_IN_FILE, OPENCODE_SIGN_IN_COPY, SIGN_IN_COPY, TASK_ROOT } from './taskWorkspace';

/** Where a person's own sign-in to a runner is kept: theirs, made in a container, and never read here (ADR-0059 L7). */
export const LOGIN_VOLUME = 'ordewell-login-claude-code';
export const CODEX_LOGIN_VOLUME = 'ordewell-login-codex';
export const OPENCODE_LOGIN_VOLUME = 'ordewell-login-opencode';

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
  /** A helper's command that says, with no network, whether the volume holds a sign-in: exit 0 for one, 1 for none. Absent, only {@link copy} says. */
  ask?: readonly string[];
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

/**
 * OpenCode keeps every provider's login in its data directory, so the copy is
 * the directory itself and `XDG_DATA_HOME` names its parent. It signs in to
 * whichever provider a person chose, so the list covers the providers its own
 * login flow offers and the API each one calls; another provider needs its
 * hosts in `containers.allow` (docs/containers.md).
 */
const OPENCODE_HOSTS: readonly string[] = [
  'opencode.ai',
  'api.anthropic.com', 'claude.ai', 'platform.claude.com',
  'api.openai.com', 'auth.openai.com', 'chatgpt.com',
  'api.individual.githubcopilot.com', 'api.githubcopilot.com',
  'generativelanguage.googleapis.com', 'cloudcode-pa.googleapis.com',
  'openrouter.ai',
];

export const CONTAINER_RUNNERS: readonly ContainerRunner[] = [
  {
    id: 'claude-code',
    binary: 'claude',
    api: ANTHROPIC_API,
    signIn: { volume: LOGIN_VOLUME, hosts: SIGN_IN_HOSTS, copy: ['sh', '-c', COPY_SIGN_IN], ask: ['sh', '-c', ASK_SIGN_IN], path: SIGN_IN_COPY, env: { CLAUDE_CONFIG_DIR: SIGN_IN_COPY } },
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
  {
    id: 'opencode',
    binary: 'opencode',
    // Its own login is for whichever provider a person chose. An Anthropic key stops at the lease's gateway, an OpenAI key is Codex's and stays on this host, and any other is handed over (ADR-0059 L7).
    api: ANTHROPIC_API,
    // The copy is the runner's data directory, which `XDG_DATA_HOME` names the parent of.
    signIn: { volume: OPENCODE_LOGIN_VOLUME, hosts: OPENCODE_HOSTS, copy: ['sh', '-c', COPY_OPENCODE_SIGN_IN], path: OPENCODE_SIGN_IN_COPY, env: { XDG_DATA_HOME: posix.join(TASK_ROOT, 'login') } },
    args: (launch) => launch.args,
  },
];

export const containerRunner = (id: string | undefined): ContainerRunner | undefined => CONTAINER_RUNNERS.find((runner) => runner.id === id);

export const CONTAINER_RUNNER_IDS: readonly string[] = CONTAINER_RUNNERS.map(({ id }) => id);

/** Every runner's sign-in hosts, for a surface's check, which knows no task's runner. */
export const ALL_SIGN_IN_HOSTS: readonly string[] = [...new Set(CONTAINER_RUNNERS.flatMap(({ signIn }) => signIn.hosts))];

export const signInRemedy = ({ volume }: ContainerSignIn): string => `Sign in as docs/containers.md shows, so it is kept in the ${volume} volume.`;

/**
 * Where a model's own API is, by the provider id of the task's assigned model.
 * A broker's key that stops at this host's gateway reaches no host; one handed
 * over, and a person's own sign-in, reaches its provider. An unknown provider
 * adds nothing: `containers.allow` is where a person names it.
 */
const MODEL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com'],
  opencode: ['opencode.ai'],
  'opencode-go': ['opencode.ai'],
  openrouter: ['openrouter.ai'],
  google: ['generativelanguage.googleapis.com'],
  'google-vertex': ['aiplatform.googleapis.com'],
  'github-copilot': ['api.individual.githubcopilot.com'],
  groq: ['api.groq.com'],
  mistral: ['api.mistral.ai'],
  deepseek: ['api.deepseek.com'],
  xai: ['api.x.ai'],
};

/** The provider id of a flat `provider/model` id, or null for one with no slash. */
const providerOf = (model: string): string | null => {
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1 ? model.slice(0, slash) : null;
};

/** What a model's traffic reaches directly, which a gateway or an allowlist may make unnecessary. */
export function modelHosts(model: string | undefined): readonly string[] {
  if (!model) return [];
  const provider = providerOf(model);
  return provider ? MODEL_HOSTS[provider] ?? [] : [];
}
