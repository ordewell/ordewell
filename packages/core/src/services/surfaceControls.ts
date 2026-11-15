import type { SupervisorLevel } from '../models/Execution';
import type { LeaseHostKind } from '../utils/leaseRecord';
import { SUPERVISOR_LEVEL_LABEL } from './runSettingsText';

/**
 * The surface a person drives a session from. The terminal UI has commands and
 * keys, not buttons, and the command line only shell commands, so a planner
 * that names a control must name this surface's, or the user is told to press
 * something that is not there (ADR-0030).
 */
export type Surface = 'tui' | 'cli' | 'vscode' | 'desktop' | 'unknown';

/** A surface a client says it is when it sends the user's message; 'unknown' is only ever inferred. */
export type ClientSurface = Exclude<Surface, 'unknown'>;

export const CLIENT_SURFACES: readonly ClientSurface[] = ['tui', 'cli', 'vscode', 'desktop'];

/** The surface a request body states, read from untrusted JSON: anything else states none. */
export function clientSurface(value: unknown): ClientSurface | undefined {
  return CLIENT_SURFACES.find((surface) => surface === value);
}

/** Every action only the user takes, which a planner may suggest but never perform. */
export const USER_ACTIONS = [
  'merge',
  'answerCheckpoint',
  'approvePlan',
  'runPlan',
  'skipTask',
  'forceStart',
  'markComplete',
  'markNotDone',
  'revertTask',
  'interrupt',
  'forceSend',
  'takeBackQueued',
  'cancelResume',
  'approveReview',
  'compact',
] as const;

export type UserAction = (typeof USER_ACTIONS)[number];

/** How the user takes each action on one surface, worded to follow "with". */
export type SurfaceControls = Readonly<Record<UserAction, string>>;

const ACTION_LABEL: Readonly<Record<UserAction, string>> = {
  merge: 'Merge the run\'s landed work',
  answerCheckpoint: 'Approve or reject a checkpoint',
  approvePlan: 'Approve the plan',
  runPlan: 'Run the plan',
  skipTask: 'Skip a task',
  forceStart: 'Force start a task',
  markComplete: 'Mark a task complete',
  markNotDone: 'Mark a task not done',
  revertTask: 'Revert a task',
  interrupt: 'Interrupt a running task',
  forceSend: 'Force send a queued message',
  takeBackQueued: 'Take back a queued message',
  cancelResume: 'Cancel a scheduled resume',
  approveReview: 'Approve the review',
  compact: 'Compact your conversation',
};

/** The action as a phrase that follows "may", for a refusal that names it. */
export function actionPhrase(action: UserAction): string {
  const label = ACTION_LABEL[action];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

const SURFACE_NAME: Readonly<Record<Surface, string>> = {
  tui: 'the terminal UI, where every control is a slash command or a key',
  cli: 'the ordewell command line, where every control is a shell command',
  vscode: 'VS Code',
  desktop: 'the Ordewell desktop app',
  unknown: 'a surface Ordewell cannot tell',
};

// The names each surface shows: packages/cli/src/tui (slash.ts, planKeys.ts,
// reducers/taskView.ts), packages/cli/src/commands/registry.ts,
// packages/ui's shared cards, and packages/desktop's title bar and task tab.
const TUI: SurfaceControls = {
  merge: '/merge',
  answerCheckpoint: '/checkpoint <id> approve, or /checkpoint <id> reject <reason>',
  approvePlan: '/approve',
  runPlan: '/run',
  skipTask: '/skip <id>',
  forceStart: '/force-start <id>',
  markComplete: '/complete <id>',
  markNotDone: '/uncomplete <id>',
  revertTask: '/revert <id>',
  interrupt: 'ctrl-x in the task\'s view (/open <id>)',
  forceSend: 'ctrl-s on the queued message',
  takeBackQueued: 'ctrl-r on the queued message in the task\'s view (/open <id>)',
  cancelResume: 'the c key on the task in the plan',
  approveReview: '/approve',
  compact: '/compact',
};

// The command line has no command for these four: only the terminal UI's keys
// reach them, so it names those and says where they are.
const CLI: SurfaceControls = {
  merge: 'ordewell merge',
  answerCheckpoint: 'ordewell checkpoint <id> approve, or ordewell checkpoint <id> reject <reason>',
  approvePlan: 'ordewell run, which approves the plan as it executes it',
  runPlan: 'ordewell run',
  skipTask: 'ordewell skip <id>',
  forceStart: 'ordewell force-start <id>',
  markComplete: 'ordewell complete <id>',
  markNotDone: 'ordewell uncomplete <id>',
  revertTask: 'ordewell revert <id>',
  interrupt: 'no command; ctrl-x in the terminal UI (ordewell tui), in the task\'s view (/open <id>)',
  forceSend: 'no command; ctrl-s on the queued message in the terminal UI (ordewell tui)',
  takeBackQueued: 'no command; ctrl-r on the queued message in the terminal UI (ordewell tui), in the task\'s view (/open <id>)',
  cancelResume: 'no command; the c key on the task in the terminal UI\'s plan (ordewell tui)',
  approveReview: 'ordewell approve',
  compact: 'ordewell compact',
};

// Queued messages go as one, so the stack has one Send all now, not one per row
// (packages/ui PendingMessages).
const SHARED_CARDS = {
  answerCheckpoint: 'the Approve & Continue or Reject button on the task\'s checkpoint panel',
  forceSend: 'the Send all now button under the queued messages',
  takeBackQueued: 'the queued message\'s × button',
  compact: '/compact',
} as const;

const VSCODE: SurfaceControls = {
  ...SHARED_CARDS,
  // The handoff card's button reads Merge for one repository (packages/ui HandoffCard).
  merge: 'the Merge button on the run\'s handoff card (Merge all when the run spans several repositories)',
  approvePlan: 'the Execute Plan button, or the Ordewell: Approve Plan command',
  runPlan: 'the Execute Plan button',
  skipTask: 'the task card\'s Skip button',
  forceStart: 'the task card\'s Start button, or its Approve button when it waits for approval',
  markComplete: 'the task card\'s Mark complete button',
  markNotDone: 'the task card\'s Mark not done button',
  revertTask: 'the task card\'s Revert button',
  interrupt: 'the Interrupt button in the task\'s log, or Esc twice',
  cancelResume: 'the task card\'s Don\'t Resume button',
  approveReview: 'the Execute Plan button, or the Ordewell: Approve Plan command',
};

const DESKTOP: SurfaceControls = {
  ...SHARED_CARDS,
  merge: 'Review & Merge all in the title bar, or Merge all… in the Changes sidebar',
  approvePlan: 'the Approve plan button in the title bar',
  runPlan: 'the Run button in the title bar',
  skipTask: 'the task tab\'s Skip button',
  forceStart: 'the task tab\'s Start now button',
  markComplete: 'the task tab\'s Mark complete button',
  markNotDone: 'the task tab\'s Mark not done button',
  revertTask: 'the task tab\'s Revert… button',
  interrupt: 'the Interrupt button in the task tab, or Esc twice',
  cancelResume: 'the task tab\'s Don\'t resume button',
  approveReview: 'the Approve plan button in the title bar',
};

/** A host that does not say what it is gets every surface's name for the action, so the user finds theirs. */
function eachSurfaces(action: UserAction): string {
  return `${TUI[action]} in the terminal UI, ${CLI[action]} on the command line, ${VSCODE[action]} in VS Code, or ${DESKTOP[action]} in the desktop app`;
}

export const SURFACE_CONTROLS: Readonly<Record<Surface, SurfaceControls>> = {
  tui: TUI,
  cli: CLI,
  vscode: VSCODE,
  desktop: DESKTOP,
  unknown: Object.fromEntries(USER_ACTIONS.map((action) => [action, eachSurfaces(action)])) as Record<UserAction, string>,
};

/**
 * The surface a session's live host serves (ADR-0049): a daemon that watches
 * its parent is a TUI's private one; the desktop app marks the daemon it
 * forks. A shared daemon may serve any surface, so it says none. Only a
 * message whose client states no surface falls back to this (UserSurface).
 */
export function surfaceOf(host: LeaseHostKind | undefined): Surface {
  if (host?.kind === 'vscode') return 'vscode';
  if (host?.kind !== 'daemon') return 'unknown';
  if (host.app === 'desktop') return 'desktop';
  return host.ownerPid !== undefined ? 'tui' : 'unknown';
}

/**
 * The surface of the user who spoke last, which is where the planner's next
 * reply is read: the client that sent the message says which it is, and a wake
 * turn, which no one sent, keeps the last one's (ADR-0030).
 */
export class UserSurface {
  private stated: ClientSurface | undefined;

  constructor(private readonly host: () => LeaseHostKind | undefined) {}

  /** A message that states no surface comes from an older client, so the host's goes back to deciding. */
  heard(surface: ClientSurface | undefined): void {
    this.stated = surface;
  }

  current(): Surface {
    return this.stated ?? surfaceOf(this.host());
  }
}

/** The header the planner reads its standing facts under; other prompts point at it by this name. */
export const SURFACE_AND_SETTINGS = 'SURFACE AND SETTINGS:';

/**
 * What the planner is told about where its user is and how the run is set.
 * `held`: automatic merging is on, but something stops it for now, so the
 * user's merge is what lands the work.
 */
export interface SurfaceSettings {
  surface: Surface;
  automaticMerging: 'on' | 'off' | 'held';
  autorun: boolean;
  supervisorLevel: SupervisorLevel;
  parallelLimit: number;
}

function mergingLine(settings: SurfaceSettings): string {
  const merge = SURFACE_CONTROLS[settings.surface].merge;
  switch (settings.automaticMerging) {
    case 'on': return 'Automatic merging: on. Merges at merge gates and at the end of a run happen by themselves, so never ask the user to merge.';
    case 'held': return `Automatic merging: on, but held for now, so landed work waits for the user's merge (${merge}).`;
    case 'off': return `Automatic merging: off. Landed work waits for the user's merge (${merge}).`;
  }
}

/**
 * The facts block, sent with a turn rather than in the system prompt, which
 * stays the same for every surface and setting (ADR-0030).
 */
export function surfaceSettingsBlock(settings: SurfaceSettings): string {
  const controls = SURFACE_CONTROLS[settings.surface];
  return [
    SURFACE_AND_SETTINGS,
    `- The user is on ${SURFACE_NAME[settings.surface]}.`,
    `- ${mergingLine(settings)}`,
    `- Autorun: ${settings.autorun ? 'on' : 'off'}.`,
    `- Supervisor: ${SUPERVISOR_LEVEL_LABEL[settings.supervisorLevel]}.`,
    `- Parallel limit: ${settings.parallelLimit} ${settings.parallelLimit === 1 ? 'task' : 'tasks'} at once.`,
    '- The user\'s own controls here, which you name when you suggest one and never take yourself:',
    ...USER_ACTIONS.map((action) => `  - ${ACTION_LABEL[action]}: ${controls[action]}`),
  ].join('\n');
}
