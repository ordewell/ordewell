import { underProtectedPath } from '../models/Delegation';
import type { Task } from '../models/Task';
import { BOARD_REF } from '../models/Board';
import { quotedLine } from '../models/lineBreaks';

/** How often a task hears from a landing at most (ADR-0057 R6). */
export const LINE_WINDOW_MS = 10 * 60_000;

/** How many paths and how long a path a line names: a sibling's branch chose them. */
const PATHS_NAMED = 5;
const PATH_CHARS = 120;
const TITLE_CHARS = 80;

/** What a landing tells a running task, to be said in one line. */
interface Moved {
  landed: string[];
  provides: Set<string>;
  paths: Set<string>;
}

export interface ScopeLinesHost {
  /** The tasks running now that declare a scope. */
  running(): readonly Task[];
  /** What a task's branch changed, by its place in the workspace. */
  changedPaths(taskId: string): Promise<string[]>;
  /** One line to a running task, marked `from: 'ordewell'`. False where it is no longer running. */
  send(taskId: string, line: string): boolean;
}

const quoted = (text: string, chars: number): string => quotedLine(text.length > chars ? `${text.slice(0, chars)}…` : text);

/** Items as a line lists them. */
function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Ordewell's own words, each thing an author or a branch named quoted, so it stays a value on this one line (ADR-0057 R3). */
function lineOf({ landed, provides, paths }: Moved): string {
  const named = [...paths].slice(0, PATHS_NAMED).map((file) => quoted(file, PATH_CHARS));
  const more = paths.size - named.length;
  return [
    `Ordewell: what you declared moved. ${listed(landed)} landed.`,
    ...(provides.size > 0 ? [`${landed.length > 1 ? 'They provide' : 'It provides'} ${[...provides].map((name) => quoted(name, PATH_CHARS)).join(', ')}.`] : []),
    ...(named.length > 0 ? [`${landed.length > 1 ? 'They changed' : 'It changed'} ${named.join(', ')}${more > 0 ? `, +${more} more` : ''}.`] : []),
    `Read "${BOARD_REF}" before you build on what you had.`,
  ].join(' ');
}

/** What is declared, as a landing looks it up: it costs the tasks that overlap, not the plan's. */
class ScopeIndex {
  private readonly consumers = new Map<string, Task[]>();
  private readonly byTop = new Map<string, { task: Task; rule: string }[]>();
  /** A rule that starts with a pattern can match anywhere, so every changed file looks at these. */
  private readonly anywhere: { task: Task; rule: string }[] = [];

  constructor(tasks: readonly Task[]) {
    for (const task of tasks) {
      for (const name of task.scope?.consumes ?? []) this.consumers.set(name, [...this.consumers.get(name) ?? [], task]);
      for (const rule of task.scope?.paths ?? []) {
        const top = rule.trim().replace(/^\.\//, '').split('/')[0];
        if (top.includes('*')) this.anywhere.push({ task, rule });
        else this.byTop.set(top, [...this.byTop.get(top) ?? [], { task, rule }]);
      }
    }
  }

  /** Whether any task here declared a path, which is what a landing's diff is read for. */
  get paths(): boolean {
    return this.byTop.size > 0 || this.anywhere.length > 0;
  }

  consumersOf(names: readonly string[]): { task: Task; name: string }[] {
    return names.flatMap((name) => (this.consumers.get(name) ?? []).map((task) => ({ task, name })));
  }

  /** Who declared `file`. */
  declaring(file: string): Task[] {
    const near = [...this.byTop.get(file.split('/')[0]) ?? [], ...this.anywhere];
    return near.filter(({ rule }) => underProtectedPath(file, rule)).map(({ task }) => task);
  }
}

/**
 * The one line a running task gets when a landing touches what it declared
 * (ADR-0057 R6), at its next step boundary. At most one per task per window:
 * the first goes at once and what follows it is coalesced into the next.
 * Advisory, as scopes are: a task it misses meets a merge conflict, which has a
 * repair (ADR-0015), so nothing here can fail a landing.
 */
export class ScopeLines {
  /** When each task last heard. */
  private readonly heard = new Map<string, number>();
  /** What waits for a window to close, by task. */
  private readonly held = new Map<string, { moved: Moved; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly host: ScopeLinesHost, private readonly now: () => number = Date.now) {}

  /** `task` landed. Reads git only for a landing some running task declared a path of. */
  async landed(task: Readonly<Task>): Promise<void> {
    const others = this.host.running().filter((one) => one.id !== task.id);
    if (others.length === 0) return;
    const index = new ScopeIndex(others);
    const reached = new Map<string, { task: Task; moved: Moved }>();
    const moved = (one: Task): Moved => {
      const entry = reached.get(one.id) ?? { task: one, moved: { landed: [quoted(task.title, TITLE_CHARS)], provides: new Set<string>(), paths: new Set<string>() } };
      reached.set(one.id, entry);
      return entry.moved;
    };
    for (const { task: one, name } of index.consumersOf(task.scope?.provides ?? [])) moved(one).provides.add(name);
    // What it changed, and not what it declared: a scope is advisory, so a landing can reach past its own.
    if (index.paths) {
      const changed = await this.host.changedPaths(task.id).catch((): string[] => []);
      for (const file of changed) for (const one of index.declaring(file)) moved(one).paths.add(file);
    }
    for (const [id, { moved: line }] of reached) this.owe(id, line);
  }

  private owe(taskId: string, moved: Moved): void {
    const last = this.heard.get(taskId);
    const left = last === undefined ? 0 : last + LINE_WINDOW_MS - this.now();
    if (left <= 0) {
      this.say(taskId, moved);
      return;
    }
    const waiting = this.held.get(taskId);
    if (waiting) {
      waiting.moved.landed.push(...moved.landed);
      for (const name of moved.provides) waiting.moved.provides.add(name);
      for (const file of moved.paths) waiting.moved.paths.add(file);
      return;
    }
    const timer = setTimeout(() => {
      const closing = this.held.get(taskId);
      this.held.delete(taskId);
      if (closing) this.say(taskId, closing.moved);
    }, left);
    timer.unref?.();
    this.held.set(taskId, { moved, timer });
  }

  private say(taskId: string, moved: Moved): void {
    if (this.host.send(taskId, lineOf(moved))) this.heard.set(taskId, this.now());
  }

  /** Nothing goes out after this. */
  dispose(): void {
    for (const { timer } of this.held.values()) clearTimeout(timer);
    this.held.clear();
  }
}
