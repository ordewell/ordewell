import { posix } from 'path';
import { TASK_ROOT } from './taskWorkspace';

/*
 * Which runners have been proven in a container, and what each needs there
 * (ADR-0059 L5, L7). The lease reads this, never a name it recognises on its
 * own: a runner missing here refuses at start rather than running with a login
 * or a home it was not given.
 */

/** Where a person's own sign-in for one runner is kept, and what a task does with it. */
export interface RunnerSignIn {
  /** The volume a person signs in to, made inside a container and never read on this host. */
  volume: string;
  /** Where a helper mounts that volume, read-only, to copy from. */
  mounted: string;
  /** The task's own copy, the only one its runner ever sees. */
  copy: string;
  /** What tells the runner to read its copy, set over anything the workspace has. */
  env: Readonly<Record<string, string>>;
  /** Where the runner's own sign-in talks, and refreshes it: opened for an own-sign-in lease. */
  hosts: readonly string[];
}

export interface ContainerRunner {
  id: string;
  /** What the image must have on its PATH, which readiness asks for before a worktree is made. */
  binary: string;
  signIn: RunnerSignIn;
}

const claudeCode: ContainerRunner = {
  id: 'claude-code',
  binary: 'claude',
  signIn: {
    volume: 'ordewell-login-claude-code',
    mounted: '/login/claude',
    copy: posix.join(TASK_ROOT, 'login', 'claude'),
    env: { CLAUDE_CONFIG_DIR: posix.join(TASK_ROOT, 'login', 'claude') },
    hosts: ['api.anthropic.com', 'claude.ai', 'platform.claude.com'],
  },
};

/**
 * OpenCode keeps every provider's login in its data directory, so the copy is
 * the directory itself and `XDG_DATA_HOME` names its parent. It signs in to
 * whichever provider a person chose, so the list covers the providers its own
 * login flow offers and the API each one calls; another provider needs its
 * hosts in `containers.allow` (docs/containers.md).
 */
const openCode: ContainerRunner = {
  id: 'opencode',
  binary: 'opencode',
  signIn: {
    volume: 'ordewell-login-opencode',
    mounted: '/login/opencode',
    copy: posix.join(TASK_ROOT, 'login', 'opencode'),
    env: { XDG_DATA_HOME: posix.join(TASK_ROOT, 'login') },
    hosts: [
      'opencode.ai',
      'api.anthropic.com', 'claude.ai', 'platform.claude.com',
      'api.openai.com', 'auth.openai.com', 'chatgpt.com',
      'api.individual.githubcopilot.com', 'api.githubcopilot.com',
      'generativelanguage.googleapis.com', 'cloudcode-pa.googleapis.com',
      'openrouter.ai',
    ],
  },
};

export const CONTAINER_RUNNERS: ReadonlyMap<string, ContainerRunner> = new Map([claudeCode, openCode].map((runner) => [runner.id, runner]));

/** A runner proven in a container, or null: a name nothing here has proven runs nowhere. */
export const containerRunner = (id: string | undefined): ContainerRunner | null => (id === undefined ? null : CONTAINER_RUNNERS.get(id) ?? null);

export const CONTAINER_RUNNER_IDS: readonly string[] = [...CONTAINER_RUNNERS.keys()];

/** Every runner's sign-in hosts, for a surface's check, which knows no task's runner. */
export const ALL_SIGN_IN_HOSTS: readonly string[] = [...new Set(CONTAINER_RUNNER_IDS.flatMap((id) => CONTAINER_RUNNERS.get(id)!.signIn.hosts))];

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
