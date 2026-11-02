import { GUARANTEES, type Guarantee, type GuaranteeReport } from '../executionLease';
import { containersOffered } from '../runSettingsText';
import { CONTAINER_ASSUMPTIONS, inspectEngine, inspectReadiness, type ContainerProblem, type EngineFacts, type PreflightDeps, type ReadinessDeps } from './containerPreflight';
import { proveEngine } from './containerProof';
import { isImage, parseContainerSettings, type ContainerSettings } from './containerSettings';
import { CredentialBroker, parseLogin, type LeaseLogin } from './credentialBroker';
import { SpawnedDockerCli, type DockerCli } from './dockerCli';
import { SidecarEgress } from './egressSidecar';

/** One change a surface can make: the rest of the setting stays in the file. */
export type ContainerChange = { on: boolean } | { image: string } | { login: unknown };

export interface ContainerSettingStore {
  /** Handed what the file holds now; undefined, in or out, is off. */
  updateContainers(change: (saved: unknown) => unknown): void;
}

export interface ChangeDeps extends Partial<PreflightDeps> {
  settings: ContainerSettingStore;
}

/** A setting a person can read off a surface, and what the last check made of it. */
export interface ContainerGuaranteeLine {
  guarantee: Guarantee;
  proven: boolean;
  by: string;
  required: boolean;
}

export interface ContainerStatus {
  on: boolean;
  image?: string;
  /** Which login, by name: never a value. */
  login?: string;
  memory?: string;
  /** All a task can reach, past what its login needs. */
  allow?: readonly string[];
  /** No problem left that a check can see. A task still proves its own container at start (ADR-0059 L3). */
  ready: boolean;
  problems: ContainerProblem[];
  engine?: EngineFacts;
  /** Only from a check that ran: nothing is proven by a setting that reads well. */
  guarantees?: ContainerGuaranteeLine[];
  /** What is taken on trust, kept apart from what a probe measured. */
  assumptions: readonly string[];
}

export interface StatusDeps extends Partial<ReadinessDeps> {
  /** Ask a container too, and not only the engine. Without it nothing is started. */
  prove?: boolean;
  /** How, for a test: the proof a lease makes unless told otherwise. */
  proof?: (settings: ContainerSettings) => Promise<GuaranteeReport>;
}

/** Whose a surface's check is, for a clean-up to find what a host that died left of it. */
const CHECK_LABELS = ['--label', 'ordewell.probe=1'];

const proveHere = (cli: DockerCli) => (settings: ContainerSettings): Promise<GuaranteeReport> => proveEngine(settings, { cli, egress: new SidecarEgress(cli), labels: CHECK_LABELS });

const refusal = (code: string, message: string, remedy: string): ContainerProblem => ({ code, message, remedy });

const asSetting = (saved: unknown): Record<string, unknown> => (typeof saved === 'object' && saved !== null ? saved as Record<string, unknown> : {});

/**
 * The one way a surface changes the setting, and so the one place that holds it to
 * what a person is told (ADR-0059 L5): containers go on only over a Docker that
 * answers, and the image and login can wait, since `{}` is on and refuses every
 * task (never the host) until they are chosen. A choice needs no engine, as an
 * image may not be built yet, and it never turns containers on. What was chosen
 * goes with turning off, as the setting's presence is what is on. Empty means
 * done. A Session reads the setting once, so a change reaches new sessions.
 */
export async function changeContainers(change: ContainerChange, { settings, cli = new SpawnedDockerCli(), platform }: ChangeDeps): Promise<ContainerProblem[]> {
  if (!containersOffered()) return [refusal('not-offered', 'This build does not offer containers.', 'Run a git checkout of Ordewell with ORDEWELL_CONTAINERS=1.')];
  if ('on' in change) {
    if (!change.on) {
      settings.updateContainers(() => undefined);
      return [];
    }
    const { problems } = await inspectEngine({ cli, ...(platform ? { platform } : {}) });
    if (problems.length === 0) settings.updateContainers((saved) => saved ?? {});
    return problems;
  }
  let off = false;
  const choice = 'image' in change ? imageOf(change.image) : loginOf(change.login);
  if ('refused' in choice) return [refusal('setting-refused', choice.refused, 'Choose another.')];
  settings.updateContainers((saved) => {
    off = saved === undefined;
    return off ? undefined : { ...asSetting(saved), ...choice };
  });
  return off ? [refusal('containers-off', 'Containers are off.', 'Turn them on first.')] : [];
}

function imageOf(image: string): { image: string } | { refused: string } {
  return isImage(image) ? { image } : { refused: `"${image}" cannot name an image` };
}

function loginOf(login: unknown): { login: LeaseLogin } | { refused: string } {
  const parsed = parseLogin(login);
  return 'refused' in parsed ? parsed : { login: parsed };
}

function loginLimit(login: LeaseLogin): string {
  if (login.kind === 'own-sign-in') {
    return 'The runner can read your sign-in: each task works from its own copy, which stops it writing to the one you made, not reading it or sending it to an allowed host. The copy stays in the task\'s volume until its session is cleaned up, and signing out of the original does not reach it.';
  }
  return 'An API key stops at this host\'s gateway, and a task reaches it by a stand-in. Anything else handed over, a cloud provider\'s credentials above all, is in the container for the runner to read.';
}

const LOGIN_NAME = { 'own-sign-in': 'your own sign-in', broker: 'broker' } as const;

const nameLogin = (login: LeaseLogin): string => (login.kind === 'broker' ? `${LOGIN_NAME.broker}: ${login.variables.join(', ')}` : LOGIN_NAME['own-sign-in']);

function chosen(raw: unknown): Pick<ContainerStatus, 'image' | 'login' | 'memory' | 'allow'> {
  const { image } = asSetting(raw);
  const settings = parseContainerSettings(raw);
  if ('refused' in settings) return typeof image === 'string' ? { image } : {};
  return { image: settings.image, login: nameLogin(settings.login), memory: settings.memory, allow: settings.allow };
}

function unprovenProblem(required: readonly Guarantee[], report: GuaranteeReport): ContainerProblem[] {
  // Only a container that holds the lease's login can answer for it, and this one holds none.
  const unproven = required.filter((guarantee) => guarantee !== 'cred.unreadable' && !report[guarantee].proven);
  if (unproven.length === 0) return [];
  const said = unproven.map((guarantee) => `${guarantee} (${report[guarantee].by})`).join('; ');
  return [refusal('guarantee-unproven', `Required of a container, and not proven here: ${said}.`, 'Every task refuses until it can be, or take it out of containers.required if you accept that.')];
}

/**
 * What a surface shows of the setting: its choices, what stands in a task's way,
 * and, kept apart, what was proven and what is only assumed. It starts nothing
 * unless asked to `prove`. A check holds no login, so it stops short of what a
 * lease proves, and a lease proves its own in any case.
 */
export async function containerStatus(raw: unknown, { prove, proof, cli = new SpawnedDockerCli(), broker = new CredentialBroker(process.env), ...rest }: StatusDeps = {}): Promise<ContainerStatus> {
  const deps = { cli, broker, ...rest };
  if (raw === undefined) {
    const { problems, engine } = await inspectEngine(deps);
    return { on: false, ready: false, problems, ...(engine ? { engine } : {}), assumptions: CONTAINER_ASSUMPTIONS };
  }
  const { problems, engine, settings } = await inspectReadiness(raw, deps);
  const base = { on: true, ...chosen(raw), ...(engine ? { engine } : {}) };
  const assumptions = settings ? [...CONTAINER_ASSUMPTIONS, loginLimit(settings.login)] : CONTAINER_ASSUMPTIONS;
  const measure = proof ?? (prove ? proveHere(cli) : undefined);
  if (!settings || !measure) return { ...base, ready: problems.length === 0, problems, assumptions };
  try {
    const report = await measure(settings);
    const proofProblems = unprovenProblem(settings.required, report);
    const guarantees = GUARANTEES.map((guarantee) => ({ guarantee, proven: report[guarantee].proven, by: report[guarantee].by, required: settings.required.includes(guarantee) }));
    return { ...base, ready: proofProblems.length === 0, problems: proofProblems, guarantees, assumptions };
  } catch (err) {
    return { ...base, ready: false, problems: [refusal('proof-failed', `A container could not be proven here: ${err instanceof Error ? err.message : String(err)}`, 'Check that the image starts and has node on it, as docs/containers.md says.')], assumptions };
  }
}

const list = (title: string, lines: readonly string[]): string[] => (lines.length > 0 ? [title, ...lines.map((line) => `  ${line}`)] : []);

const lineOf = ({ guarantee, by, required }: ContainerGuaranteeLine): string => `${guarantee}${required ? ' (required)' : ''}: ${by}`;

/** A status as lines for a person, the same on every surface. */
export function describeContainers(status: ContainerStatus): string[] {
  const { on, ready, engine, image, login, memory, allow, problems, guarantees, assumptions } = status;
  const state = !on ? 'off' : ready ? 'on, and nothing stands in the way of a task' : 'on, and every task refuses until this is fixed';
  return [
    `Containers: ${state}. A change reaches new sessions.`,
    ...(engine ? [`Engine: Docker ${engine.version} at ${engine.endpoint}.`] : []),
    ...(on ? [`Image: ${image ?? 'not chosen'}.`, `Login: ${login ?? 'not chosen'}.`] : []),
    ...(memory ? [`Memory: ${memory} for each container.`] : []),
    ...(allow ? [`Network: ${allow.length > 0 ? `a task reaches ${allow.join(', ')}, and what its login needs` : 'a task reaches only what its login needs'}.`] : []),
    ...list(on ? 'What stands in the way:' : 'What stands in the way of turning them on:', problems.map(({ message, remedy }) => `${message} ${remedy}`.trim())),
    ...(guarantees
      ? [...list('Proven by this check:', guarantees.filter(({ proven }) => proven).map(lineOf)), ...list('Not proven:', guarantees.filter(({ proven }) => !proven).map(lineOf))]
      : (on ? ['Nothing has been proven yet: a check starts a throwaway container and measures. Every task measures its own at start.'] : [])),
    ...list('Assumed or left uncovered, and never proven:', assumptions),
  ];
}
