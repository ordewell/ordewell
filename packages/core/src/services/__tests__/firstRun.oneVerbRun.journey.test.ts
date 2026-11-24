import { describe, expect, it } from 'vitest';
import { buildConversationSystemPrompt } from '../PlanPrompts';
import { surfaceSettingsBlock, type Surface } from '../surfaceControls';

/*
 * Machine B's first run (slug oneVerbRun), as the planner is told it: Claude
 * Code plans, autorun is off, supervisor at Watch. The planner wrote an outline,
 * waited for the user to confirm it, and then told them to approve the plan,
 * which they could not tell apart from running it. Decided: the planner writes
 * the outline and submits the plan in one reply, still asking first when the
 * goal is vague; starting a drafted plan is the run control, and no surface's
 * controls name a plan-level approve.
 */

const GOAL = 'Add a --shout option to hello.py that prints the greeting in upper case, with a test';

const prompts = [
  ['a harness planner (Claude Code)', buildConversationSystemPrompt(GOAL, '', {}, ['claude-code'], undefined, { harness: true, runner: 'claude-code', execution: true, autorun: false })],
  ['an API planner', buildConversationSystemPrompt(GOAL, '', {}, ['claude-code'], undefined, { harness: false, execution: true, autorun: false })],
] as const;

describe('machine B, oneVerbRun: the planner\'s prompt with autorun off', () => {
  it.each(prompts)('for %s, has the outline written and the plan submitted in the same reply', (_who, prompt) => {
    expect(prompt).toMatch(/outline[^\n]*in the same reply/i);
  });

  it.each(prompts)('for %s, still has the planner ask first when the goal is vague', (_who, prompt) => {
    expect(prompt).toMatch(/goal is vague[^\n]*ask/i);
  });

  it.each(prompts)('for %s, nowhere has the planner wait for the user to confirm the outline', (_who, prompt) => {
    expect(prompt).not.toMatch(/confirms? the outline/i);
    expect(prompt).not.toMatch(/wait for the user to confirm/i);
    expect(prompt).not.toMatch(/after the user confirms/i);
  });

  it.each(prompts)('for %s, nowhere has the planner tell the user to approve anything', (_who, prompt) => {
    expect(prompt).not.toMatch(/\b(tell|ask) (the user|them) to approve/i);
    expect(prompt).not.toMatch(/\buser (must|should|needs to|has to) approve/i);
    expect(prompt).not.toMatch(/\/approve\b|ordewell approve/);
  });
});

describe('machine B, oneVerbRun: the controls the planner is told for every surface', () => {
  const surfaces: Surface[] = ['tui', 'cli', 'vscode', 'desktop', 'unknown'];
  const block = (surface: Surface) => surfaceSettingsBlock({ surface, automaticMerging: 'off', autorun: false, supervisorLevel: 'watch', parallelLimit: 3 });
  const controlLines = (surface: Surface) => block(surface).split('\n').filter((line) => line.startsWith('  - '));

  it.each(surfaces)('on %s, name no plan-level approve control: starting a drafted plan is the run control', (surface) => {
    const lines = controlLines(surface);
    expect(lines.some((line) => /^ {2}- Run the plan: /.test(line))).toBe(true);
    expect(lines.filter((line) => /^ {2}- Approve (the plan|the review)\b/i.test(line))).toEqual([]);
    expect(block(surface)).not.toMatch(/\/approve\b|ordewell approve|Approve plan button|Approve Plan command|approves the plan/);
  });

  it.each(surfaces)('on %s, still name the checkpoint control, approve or reject a task\'s checkpoint', (surface) => {
    expect(controlLines(surface).some((line) => /checkpoint/i.test(line) && /approve/i.test(line) && /reject/i.test(line))).toBe(true);
  });
});
