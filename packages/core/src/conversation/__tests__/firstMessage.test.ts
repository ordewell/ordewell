import { describe, it, expect } from 'vitest';
import { replayTaskLog } from '../taskLog';
import type { MessageBlock } from '../blocks';
import { hasHiddenDetail } from '../detail';
import { composeAttemptPrompt } from '../../services/attemptKind';
import { withBoardPins } from '../../services/promptAugment';
import { promptPartSpans, type PromptPartSpan } from '../../models/PromptPart';
import type { TaskLogEvent } from '../../models/TaskLog';
import { PROMPT_SCENARIOS } from '../../services/__tests__/fixtures/promptScenarios';

const HANDOFFS = 'Handoffs from earlier tasks';
const INSTRUCTIONS = 'Ordewell\'s instructions to the runner';

/** The first turn as the recorder logs it: the message the runner was sent, and where its parts sit. */
function firstTurn(name: string, pins: readonly string[] = []): Extract<TaskLogEvent, { type: 'turn_start' }> {
  const scenario = PROMPT_SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  const { prompt, parts = [] } = withBoardPins(composeAttemptPrompt(scenario.kind, scenario.src), pins);
  const spans = promptPartSpans(prompt, parts);
  return { type: 'turn_start', message: prompt, ...(spans ? { parts: spans } : {}) };
}

function firstMessage(events: readonly TaskLogEvent[]): MessageBlock {
  const block = replayTaskLog(events).blocks[0];
  if (block?.type !== 'message') throw new Error('no message first');
  return block;
}

/** Each group's title and its sections' titles, in the order a surface draws them. */
function outline(block: MessageBlock): Array<[string, string[]]> {
  return (block.sections ?? []).map((g) => [g.title, g.sections.map((s) => s.title)]);
}

describe('a task\'s first message, its parts told apart', () => {
  it('shows a first attempt\'s brief, Ordewell\'s instructions and the handoffs folded into sections', () => {
    const block = firstMessage([firstTurn('attended change')]);

    expect(block).toMatchObject({ role: 'user', text: 'Wire the parser in.' });
    expect(outline(block)).toEqual([
      [HANDOFFS, ['Prior task outputs']],
      [INSTRUCTIONS, ['Human-in-the-loop checkpoints', 'Task skills']],
    ]);
    const skills = block.sections?.[1].sections[1];
    expect(skills).toEqual({
      kind: 'skills', title: 'Task skills',
      text: 'This task comes with the skills below. Follow them while you work on it.\n\n### Skill: tdd\n\nRED then GREEN.',
    });
    expect(block.sections?.[0].sections[0].text.startsWith('`read` reads any of these tasks in full')).toBe(true);
  });

  it('puts a retry\'s note before its brief, as what this attempt was told to do differently', () => {
    const block = firstMessage([firstTurn('change, beside and retried')]);

    expect(block.text).toBe([
      '## The supervisor\'s note for this attempt',
      '',
      'The last attempt at this task ended without passing, and the supervisor retried it with this note for this attempt. The task below is unchanged; read the note as a correction to how you go about it:',
      '',
      'Run the parser tests before you finish.',
      '',
      'Wire the parser into the CLI.',
      '',
      'Done when `cli parse` works.',
    ].join('\n'));
    expect(outline(block)).toEqual([
      [HANDOFFS, ['Prior task outputs']],
      [INSTRUCTIONS, ['Unattended run', 'Task skills', 'Work landing beside yours']],
    ]);
    expect(block.sections?.[1].sections[0].text.startsWith('Nobody is watching this task as it runs')).toBe(true);
  });

  it('shows a repair\'s merge as its brief', () => {
    const block = firstMessage([firstTurn('repair')]);

    expect(block.text).toBe('Merge the integration branch into your worktree and resolve the conflict in src/parse.ts.');
    expect(outline(block)).toEqual([[HANDOFFS, ['Prior task outputs']], [INSTRUCTIONS, ['Unattended run']]]);
  });

  it('folds a read-only task\'s notes and the board\'s pins with the instructions', () => {
    const block = firstMessage([firstTurn('read-only', ['[pin] Use pnpm.'])]);

    expect(block.text).toBe('Read the code.');
    expect(outline(block)).toEqual([[INSTRUCTIONS, ['Unattended run', 'Task skills', 'Read-only task', 'Board pins']]]);
    expect(block.sections?.[0].sections[2].text).toMatch(/^This task is read-only and its worktree is thrown away[^]*\n\nRead the web with the `fetch` and `web_search` tools/);
    expect(block.sections?.[0].sections[3]).toEqual({ kind: 'boardPins', title: 'Board pins', text: '[pin] Use pnpm.' });
  });

  it('shows a loop\'s check its brief, its last round among the handoffs and what its status means among the instructions', () => {
    const block = firstMessage([firstTurn('loop check, next round')]);

    expect(block.text).toBe('Review src/parse.ts.');
    expect(outline(block)).toEqual([
      [HANDOFFS, ['Prior task outputs', 'Since your last round']],
      [INSTRUCTIONS, ['Unattended run', 'Task skills', 'Read-only task', 'You are this loop\'s check']],
    ]);
    expect(block.sections?.[1].sections[3].text.startsWith('Ordewell reads your `task_complete` status as this check\'s verdict.')).toBe(true);
  });

  it('shows an ops retry\'s previous attempt and a carry-over\'s work among the handoffs', () => {
    expect(outline(firstMessage([firstTurn('ops')]))[0]).toEqual([HANDOFFS, ['Prior task outputs', 'Previous attempt']]);
    expect(outline(firstMessage([firstTurn('carried over')]))[0]).toEqual([HANDOFFS, ['Prior task outputs', 'Work carried over']]);
  });

  it('reads a first message without parts as one message, as every log saved before them was', () => {
    const { message } = firstTurn('change, beside and retried');

    const block = firstMessage([{ type: 'turn_start', message }]);

    expect(block).toEqual({ type: 'message', id: 'b1', role: 'user', text: message, streaming: false });
    expect(hasHiddenDetail([block])).toBe(false);
  });

  it('reads parts that do not fit their message as none', () => {
    const { message } = firstTurn('repair');

    const block = firstMessage([{ type: 'turn_start', message, parts: [{ kind: 'brief', title: 'Brief', start: 0, end: message.length + 5 }] }]);

    expect(block.text).toBe(message);
    expect(block.sections).toBeUndefined();
  });

  it('reads overlapping spans, or two briefs, as none', () => {
    const message = 'Note.\n\nDo it';

    for (const parts of [
      [{ kind: 'unattended', title: 'Unattended run', start: 0, end: 9 }, { kind: 'brief', title: 'Brief', start: 7, end: 12 }],
      [{ kind: 'brief', title: 'Brief', start: 0, end: 5 }, { kind: 'brief', title: 'Brief', start: 7, end: 12 }],
    ] as const) {
      expect(firstMessage([{ type: 'turn_start', message, parts: [...parts] }])).toEqual({ type: 'message', id: 'b1', role: 'user', text: message, streaming: false });
    }
  });

  it('folds a part a newer Ordewell added with the instructions, and shows a brief alone with no sections', () => {
    const message = 'Note.\n\nDo it';
    // A kind this build does not know, as a log a newer one wrote holds it.
    const newer = JSON.parse('{"kind":"budget","title":"Budget","start":0,"end":5}') as PromptPartSpan;

    expect(firstMessage([{ type: 'turn_start', message, parts: [newer, { kind: 'brief', title: 'Brief', start: 7, end: 12 }] }]).sections)
      .toEqual([{ title: INSTRUCTIONS, sections: [{ kind: 'budget', title: 'Budget', text: 'Note.' }] }]);
    const alone = firstMessage([{ type: 'turn_start', message: 'Do it', parts: [{ kind: 'brief', title: 'Brief', start: 0, end: 5 }] }]);
    expect(alone).toEqual({ type: 'message', id: 'b1', role: 'user', text: 'Do it', streaming: false });
  });

  it('is hidden detail: the one fold key covers the sections', () => {
    expect(hasHiddenDetail(replayTaskLog([firstTurn('repair')]).blocks)).toBe(true);
  });
});
