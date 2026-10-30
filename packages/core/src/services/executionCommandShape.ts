import type { ExecutionCommandName } from '../models/Execution';
import type { ExecutionCommand } from './ExecutionCommands';

type Field =
  | { kind: 'string'; required?: true }
  /** Words a person wrote: blank is no message, as it was no message at the routes this replaced. */
  | { kind: 'text'; required?: true }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'strings' }
  | { kind: 'commandLines' }
  | { kind: 'oneOf'; values: readonly string[]; required?: true };

const task: Field = { kind: 'string', required: true };
const id: Field = { kind: 'string', required: true };

/**
 * Each command's fields, which the seam reads without checking: it takes an
 * `ExecutionCommand` the compiler vouched for. A body from a socket has no such
 * voucher, so it is checked against this table before it reaches the seam.
 * Keyed by every command name, so a command added to the union fails to compile
 * until its shape is written here.
 */
const SHAPES: Record<ExecutionCommandName, Record<string, Field>> = {
  run_plan: {},
  run_task: { task },
  stop_task: { task },
  stop_run: {},
  retry_task: { task, from: { kind: 'oneOf', values: ['fresh', 'session'], required: true }, message: { kind: 'string' } },
  message_task: { task, text: { kind: 'text', required: true }, force: { kind: 'boolean' } },
  // `answer` is free text here: the seam refuses an `allow` with its reason, and that refusal is worth keeping.
  answer_approval: { task, approval: { kind: 'string' }, answer: { kind: 'string', required: true }, note: { kind: 'string' } },
  merge_all: {},
  skip_task: { task, reason: { kind: 'string' } },
  force_start: { task },
  // `seen` is the status the user was asked about; the seam compares it, so any string is kept.
  mark_complete: { task, confirmed: { kind: 'boolean' }, seen: { kind: 'string' } },
  mark_not_done: { task, confirmed: { kind: 'boolean' }, seen: { kind: 'string' } },
  // `seen` is the task ids the user was shown; the seam compares them, so a stale yes is refused.
  revert_task: { task, confirmed: { kind: 'boolean' }, seen: { kind: 'strings' } },
  interrupt_task: { task },
  force_send_queued: { task, id },
  remove_queued: { task, id },
  cancel_resume: { task },
  answer_checkpoint: { task, answer: { kind: 'oneOf', values: ['approve', 'reject'], required: true }, reason: { kind: 'string' } },
  approve_review: {},
  run_script: {
    title: { kind: 'string', required: true },
    commands: { kind: 'commandLines' },
    script: { kind: 'string' },
    timeoutMs: { kind: 'number' },
    dependencies: { kind: 'strings' },
  },
};

function holds(field: Field, value: unknown): boolean {
  switch (field.kind) {
    case 'string': return typeof value === 'string';
    case 'text': return typeof value === 'string' && value.trim() !== '';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'strings': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'commandLines': return Array.isArray(value) && value.every((line) => Array.isArray(line) && line.every((v) => typeof v === 'string'));
    case 'oneOf': return typeof value === 'string' && field.values.includes(value);
  }
}

export type ParsedCommand = { ok: true; command: ExecutionCommand } | { ok: false; message: string };

function isCommandName(name: unknown): name is ExecutionCommandName {
  return typeof name === 'string' && Object.hasOwn(SHAPES, name);
}

/**
 * An `ExecutionCommand` out of a request body, or the sentence saying what is
 * wrong with it. Only the command's own fields are kept, so a body cannot carry
 * anything the seam does not read.
 */
export function parseExecutionCommand(body: unknown): ParsedCommand {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: 'The command must be a JSON object.' };
  const given = body as Record<string, unknown>;
  const name = given.command;
  if (!isCommandName(name)) return { ok: false, message: `"command" must be one of: ${Object.keys(SHAPES).join(', ')}.` };

  const kept: Record<string, unknown> = { command: name };
  for (const [field, shape] of Object.entries(SHAPES[name])) {
    const value = given[field];
    if (value === undefined || value === null) {
      if ('required' in shape && shape.required) return { ok: false, message: `${name} needs "${field}".` };
      continue;
    }
    if (!holds(shape, value)) return { ok: false, message: `${name}: "${field}" is not valid.` };
    kept[field] = value;
  }
  // Safe: `kept` holds exactly the fields SHAPES requires of this command, each checked above.
  return { ok: true, command: kept as unknown as ExecutionCommand };
}
