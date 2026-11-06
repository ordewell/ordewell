import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ActionResult, ShellTarget } from '../shared/bridge';

/**
 * "Open in editor" and "Reveal" for a file of the user's checkout (design W8).
 * A page names a repository and a path from its root, the way the read routes
 * do; this resolves them inside the window's own workspace and refuses
 * anything that leaves it, so the page cannot make main open or reveal a path
 * of its choosing. Electron's calls are injected, so the rules are testable.
 */

export interface ShellActions {
  /** Electron's `shell.openPath`: the OS default; resolves to an error text, '' on success. */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  /** Starts the configured editor detached; rejects when the program cannot start. */
  launch(program: string, args: string[]): Promise<void>;
}

/** A relative path made of real segments: no root, no `..`, no NUL. */
function plainRelative(value: string): boolean {
  if (value.includes('\0') || isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '..');
}

/** git's own directory and the daemon's state are never the user's files; its skills are (ADR-0024). */
function hiddenSegments(path: string): boolean {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('.git')) return true;
  const state = segments.indexOf('.ordewell');
  return state !== -1 && segments[state + 1] !== 'skills';
}

export type Resolved = { ok: true; path: string } | { ok: false; message: string };

/** The absolute path a target names, only if it exists inside the workspace once links are followed. */
export function resolveTarget(workspace: string, target: unknown): Resolved {
  if (typeof target !== 'object' || target === null) return { ok: false, message: 'Name a file.' };
  const { repo, path } = target as Partial<ShellTarget>;
  if (typeof repo !== 'string' || repo === '' || !plainRelative(repo)) return { ok: false, message: 'That repository is not in this workspace.' };
  if (path !== undefined && (typeof path !== 'string' || !plainRelative(path))) return { ok: false, message: 'That path is not inside the repository.' };
  const inside = join(repo, path ?? '');
  if (hiddenSegments(inside)) return { ok: false, message: 'That path is not one the Explorer shows.' };
  try {
    const root = realpathSync(workspace);
    const real = realpathSync(join(root, inside));
    const rel = relative(root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ok: false, message: 'That path leads out of the workspace.' };
    return { ok: true, path: real };
  } catch {
    return { ok: false, message: 'That file is gone from the checkout.' };
  }
}

/** Split on spaces, keeping a double-quoted run whole: enough for `code --goto "{file}:{line}"`. */
function tokens(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|(\S+)/g)) out.push(match[1] ?? match[2] ?? '');
  return out;
}

/**
 * The program and arguments of the configured editor command. `{file}` and
 * `{line}` are filled in where they stand; with no `{file}` the path is
 * appended. No shell reads it, so a file name cannot add a command.
 */
export function editorInvocation(command: string, file: string, line: number | undefined): { program: string; args: string[] } | undefined {
  const [program, ...rest] = tokens(command);
  if (!program) return undefined;
  const placed = rest.some((token) => token.includes('{file}'));
  const args = rest.map((token) => token.split('{file}').join(file).split('{line}').join(String(line ?? 1)));
  if (!placed) args.push(file);
  return { program, args };
}

function lineOf(target: unknown): number | undefined {
  const line = (target as Partial<ShellTarget>).line;
  return typeof line === 'number' && Number.isInteger(line) && line >= 1 && line < 1e7 ? line : undefined;
}

export class Shell {
  constructor(
    private readonly actions: ShellActions,
    private readonly editorCommand: () => string,
  ) {}

  async openInEditor(workspace: string, target: unknown): Promise<ActionResult> {
    const resolved = resolveTarget(workspace, target);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    const command = this.editorCommand().trim();
    if (command) {
      const invocation = editorInvocation(command, resolved.path, lineOf(target));
      if (!invocation) return { ok: false, message: 'The editor command in the preferences is empty.' };
      try {
        await this.actions.launch(invocation.program, invocation.args);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: `Could not start “${invocation.program}”: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const failure = await this.actions.openPath(resolved.path);
    return failure ? { ok: false, message: failure } : { ok: true };
  }

  reveal(workspace: string, target: unknown): ActionResult {
    const resolved = resolveTarget(workspace, target);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    this.actions.showItemInFolder(resolved.path);
    return { ok: true };
  }
}
