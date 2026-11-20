import { describe, it, expect } from 'vitest';
import { attemptPrompt, composeAttemptPrompt } from '../attemptKind';
import { joinPromptParts, promptPartSpans } from '../../models/PromptPart';
import { withBoardPins } from '../promptAugment';
import { PROMPT_SCENARIOS } from './fixtures/promptScenarios';
import firstMessages from './fixtures/firstMessages.json';

const golden: Record<string, string> = firstMessages;

describe('a first message told apart into parts', () => {
  it.each(PROMPT_SCENARIOS.map((s) => [s.name, s] as const))('sends the %s attempt the bytes it was sent before', (name, { kind, src }) => {
    const composed = composeAttemptPrompt(kind, src);

    expect(attemptPrompt(kind, src)).toBe(golden[name]);
    expect(composed.prompt).toBe(golden[name]);
    expect(joinPromptParts(composed.parts ?? [])).toBe(golden[name]);
  });
});

describe('the parts of a first message', () => {
  const scenario = (name: string) => {
    const found = PROMPT_SCENARIOS.find((s) => s.name === name);
    if (!found) throw new Error(`no scenario ${name}`);
    return composeAttemptPrompt(found.kind, found.src);
  };

  it('names each part, in the order the runner reads them, the brief last', () => {
    expect(scenario('change, beside and retried').parts?.map((p) => [p.kind, p.title])).toEqual([
      ['unattended', 'Unattended run'],
      ['priorOutputs', 'Prior task outputs'],
      ['skills', 'Task skills'],
      ['landingBeside', 'Work landing beside yours'],
      ['retryNote', 'The supervisor\'s note for this attempt'],
      ['brief', 'Brief'],
    ]);
    expect(scenario('attended change').parts?.map((p) => p.kind)).toEqual(['priorOutputs', 'skills', 'checkpoint', 'brief']);
    expect(scenario('read-only').parts?.map((p) => [p.kind, p.title])).toEqual([
      ['unattended', 'Unattended run'], ['skills', 'Task skills'], ['readOnly', 'Read-only task'], ['brief', 'Brief'],
    ]);
    expect(scenario('loop check, next round').parts?.map((p) => [p.kind, p.title])).toEqual([
      ['unattended', 'Unattended run'], ['sinceLastRound', 'Since your last round'], ['priorOutputs', 'Prior task outputs'],
      ['skills', 'Task skills'], ['readOnly', 'Read-only task'], ['loopCheck', 'You are this loop\'s check'], ['brief', 'Brief'],
    ]);
    expect(scenario('ops').parts?.map((p) => p.kind)).toEqual(['unattended', 'priorOutputs', 'previousAttempt', 'skills', 'brief']);
    expect(scenario('carried over').parts?.map((p) => p.kind)).toEqual(['unattended', 'priorOutputs', 'carriedOver', 'skills', 'landingBeside', 'retryNote', 'brief']);
  });

  it('makes a repair\'s brief what it is asked to merge', () => {
    const { parts } = scenario('repair');

    expect(parts?.map((p) => p.kind)).toEqual(['unattended', 'priorOutputs', 'brief']);
    expect(parts?.at(-1)?.text).toBe('Merge the integration branch into your worktree and resolve the conflict in src/parse.ts.');
  });

  it('gives a continue and a subplanner\'s goal no parts: each is one text', () => {
    const src = PROMPT_SCENARIOS[0].src;

    expect(composeAttemptPrompt({ kind: 'continuation', work: 'change', message: 'go on', resumeSessionId: 's' }, src).parts).toBeUndefined();
    expect(composeAttemptPrompt({ kind: 'delegated', readOnly: false }, { ...src, task: { ...src.task, goal: 'Ship it' } })).toEqual({ prompt: 'Ship it' });
  });

  it.each(PROMPT_SCENARIOS.map((s) => [s.name, s] as const))('spans the %s message in order, without overlap, to its last byte', (name, { kind, src }) => {
    const { prompt, parts = [] } = composeAttemptPrompt(kind, src);

    const spans = promptPartSpans(prompt, parts) ?? [];

    expect(spans.map((s) => s.kind)).toEqual(parts.map((p) => p.kind));
    expect(spans[0].start).toBe(0);
    expect(spans.at(-1)?.end).toBe(golden[name].length);
    for (let i = 1; i < spans.length; i++) expect(golden[name].slice(spans[i - 1].end, spans[i].start)).toBe('\n\n');
    expect(spans.map((s) => golden[name].slice(s.start, s.end))).toEqual(parts.map((p) => p.text));
  });

  it('spans nothing of a message the parts do not join to', () => {
    const { prompt, parts = [] } = scenario('ops');

    expect(promptPartSpans(`Contract first.\n\n${prompt}`, parts)).toBeUndefined();
    expect(promptPartSpans(prompt, [])).toBeUndefined();
  });

  it('puts the board\'s pins after the brief as their own part, the message as it was sent before', () => {
    const composed = scenario('read-only');

    const pinned = withBoardPins(composed, ['[pin] Use pnpm.', '[pin] Port 4000.']);

    expect(pinned.prompt).toBe(`${golden['read-only']}\n\n[pin] Use pnpm.\n[pin] Port 4000.`);
    expect(pinned.parts?.at(-1)).toEqual({ kind: 'boardPins', title: 'Board pins', text: '[pin] Use pnpm.\n[pin] Port 4000.' });
    expect(promptPartSpans(pinned.prompt, pinned.parts ?? [])?.map((s) => s.kind).slice(-2)).toEqual(['brief', 'boardPins']);
    expect(withBoardPins(composed, [])).toBe(composed);
    expect(withBoardPins({ prompt: 'go on' }, ['[pin] x'])).toEqual({ prompt: 'go on\n\n[pin] x' });
  });
});
