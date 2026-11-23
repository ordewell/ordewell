import type { RunnerMode } from '../plugins/types';
import type { ModeRefused } from './harness/AgentAdapter';

/**
 * A runner that starts in another mode than the plan asked for (ADR-0018 B2):
 * Claude Code given `--permission-mode auto` on a model or account without
 * Auto starts in `default` and says nothing. The task fails rather than run in
 * a mode nobody chose, since the mode is the user's safety choice (ADR-0001).
 * What it offers instead is the mode the runner did start in, the one it is
 * known to offer here, and only as the user's own switch.
 */

/** The non-read-only mode a runner's own word for a mode names; read-only shares its word on some runners, and is never what a task is switched to. */
function modeOfWord(modes: readonly RunnerMode[], word: string): RunnerMode | undefined {
  return modes.find((m) => (m.cliValue ?? m.id) === word && !m.readOnly);
}

/** A mode's name as the user picks it, or the runner's word where the manifest has none. */
function modeWordLabel(modes: readonly RunnerMode[], word: string): string {
  return modeOfWord(modes, word)?.label ?? word;
}

/** What the runner said, in the user's words: what it started in, what was asked, and that it gives no reason. */
export function modeRefusedMessage(runner: string, modes: readonly RunnerMode[], refused: ModeRefused): string {
  const asked = modeWordLabel(modes, refused.asked);
  return `${runner} started in ${modeWordLabel(modes, refused.started)} mode, not ${asked}, the mode this task asked for. `
    + `${runner} offers ${asked} only on some models and accounts, and it does not say why it was not offered here.`;
}

/** A mode as the plan names it and the user reads it. */
export interface NamedMode {
  mode: string;
  label: string;
}

/** The task's failure as the plan keeps it, named in the user's words so every surface can say it without the runner's manifest. */
export interface ModeRefusal {
  runner: string;
  runnerLabel: string;
  /** The task's mode. */
  asked: NamedMode;
  /** The mode the runner did start in, absent when it is none the task may be switched to. */
  offered?: NamedMode;
}

/** The runner as a refusal reads it: its id, its name, and its modes. */
export interface RefusingRunner {
  name: string;
  displayName: string;
  modes?: readonly RunnerMode[];
}

/** The refusal of a task in `asked` mode, with the mode it started in offered when that is another the runner lists. */
export function modeRefusalOf(runner: RefusingRunner, asked: string, refused: ModeRefused): ModeRefusal {
  const modes = runner.modes ?? [];
  const started = modeOfWord(modes, refused.started);
  const askedLabel = modes.find((m) => m.id === asked)?.label ?? asked;
  return {
    runner: runner.name,
    runnerLabel: runner.displayName,
    asked: { mode: asked, label: askedLabel },
    ...(started && started.id !== asked ? { offered: { mode: started.id, label: started.label } } : {}),
  };
}

/** What a refused task's verdict says first, for the user; the offer, when there is one, is its next step. */
export function modeRefusedReason(said: string, refusal: ModeRefusal): string {
  if (!refusal.offered) return `${said} Pick another mode for this task, then retry it.`;
  return `${said} Switch this task to ${refusal.offered.label} and retry it.`;
}

/** What a task's mode refusal is told by: a task alike runs on the same runner, in the same mode, on the same model. */
interface Alike {
  id: string;
  type?: string;
  status: string;
  assignedRunner?: string;
  taskMode?: string;
  assignedModel?: { modelId: string } | null;
}

/**
 * Whether `task` would meet the same refusal as `failed`: the runner decides
 * what it offers by model and account, so a task on another model may run.
 */
export function refusedAlike(task: Alike, failed: Alike & { refusal: ModeRefusal }): boolean {
  return task.id !== failed.id
    && task.type === 'ai'
    && task.assignedRunner === failed.refusal.runner
    && task.taskMode === failed.refusal.asked.mode
    && (task.assignedModel?.modelId ?? null) === (failed.assignedModel?.modelId ?? null);
}

/** Why a task alike is held (ADR-0018 B2), as "On hold: …" reads it: who was refused, and the way out. */
export function refusedAlikeHold(refusal: ModeRefusal, failedRef: string): string {
  const out = refusal.offered ? `switch it to ${refusal.offered.label}` : 'pick another mode for it';
  return `${refusal.runnerLabel} did not start ${failedRef} in ${refusal.asked.label} mode, so this task would fail the same way: ${out}, or retry it`;
}

/** `A`, `A and B`, `A, B and C`. */
export function andList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('');
}

/** The run's one notice of the tasks held behind a refusal, by reference and title. */
export function refusedAlikeNotice(refusal: ModeRefusal, held: readonly string[]): string {
  const [noun, verb, them] = held.length === 1 ? ['Task', 'uses', 'it is'] : ['Tasks', 'use', 'they are'];
  return `${noun} ${andList(held)} ${verb} ${refusal.asked.label} on ${refusal.runnerLabel} too, so ${them} on hold rather than failing the same way.`;
}

/**
 * The tasks not started held behind `failed`'s refusal: alike, and held for
 * that refusal, not for a reason of their own, which a refusal never replaces.
 */
export function heldBehindRefusal<T extends Alike>(
  failed: Alike & { refusal: ModeRefusal },
  failedRef: string,
  tasks: Iterable<T>,
  holdReason: (taskId: string) => string | null | undefined,
): T[] {
  const hold = refusedAlikeHold(failed.refusal, failedRef);
  return [...tasks].filter((t) => (t.status === 'pending' || t.status === 'approved') && holdReason(t.id) === hold && refusedAlike(t, failed));
}
