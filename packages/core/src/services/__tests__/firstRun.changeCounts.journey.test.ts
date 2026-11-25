import { describe, expect, it } from 'vitest';
import { TASK_COMPLETION_CONTRACT, taskCompletionContract } from '../mcp';

/*
 * Machine B's first run (slug changeCounts), as the runner is told it. The
 * task that documented --shout also deleted the README's `# hello` heading,
 * which its brief never named, and its handoff did not say so. Decided: the
 * runner's completion contract tells it to leave content its brief does not
 * name as it is, and to say so in its handoff if it removes any. The counts the
 * user is shown are Ordewell's, from git (the terminal UI's file of this slug).
 */

/** The contract's sentences, so a phrase is matched within one instruction. */
const sentences = (text: string): string[] => text.split(/(?<=[.:;])\s+|\n+/).filter(Boolean);

describe('machine B, changeCounts: the runner\'s completion contract', () => {
  it.each([
    ['a task whose work lands as a commit', taskCompletionContract({ commits: true })],
    ['a task that commits nothing', taskCompletionContract({})],
    ['the contract itself', TASK_COMPLETION_CONTRACT],
  ])('for %s, tells the runner to leave content its brief does not name as it is', (_who, contract) => {
    expect(sentences(contract).some((s) => /\bbrief\b/i.test(s) && /\bas it is\b/i.test(s))).toBe(true);
  });

  it.each([
    ['a task whose work lands as a commit', taskCompletionContract({ commits: true })],
    ['a task that commits nothing', taskCompletionContract({})],
  ])('for %s, tells the runner to say so in its handoff if it removes any', (_who, contract) => {
    expect(sentences(contract).some((s) => /\bremov/i.test(s) && /\b(handoff|summary)\b/i.test(s))).toBe(true);
  });
});
