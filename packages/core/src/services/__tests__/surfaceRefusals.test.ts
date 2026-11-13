import { describe, expect, it, vi } from 'vitest';
import type { ExecutionActor } from '../../models/Execution';
import { ExecutionCommands, type ApprovalReads, type ExecutionHost, type RunReads } from '../ExecutionCommands';
import type { RunControls } from '../SessionSaves';
import { rootAuthority } from '../Mandate';
import { SURFACE_CONTROLS, type Surface } from '../surfaceControls';

/**
 * A refusal that tells a planner what the user does names the action as the
 * user's surface takes it, and never asks for a merge automatic merging makes
 * by itself (ADR-0030).
 */

const PLANNER: ExecutionActor = { kind: 'planner-turn' };

function seam(surface: Surface, mergesByThemselves = false): ExecutionCommands {
  const host = {
    autonomous: () => false,
    autorun: () => false,
    userControls: () => SURFACE_CONTROLS[surface],
    mergesByThemselves: () => mergesByThemselves,
  } as unknown as ExecutionHost;
  return new ExecutionCommands({ orchestrator: {} as RunReads, controls: {} as RunControls, approvals: {} as ApprovalReads, host, consent: { request: vi.fn() }, authority: rootAuthority(() => ({ autorun: false, autonomous: false, delegationTokens: 0, runners: [], models: {} })) });
}

function refusal(commands: ExecutionCommands, actor: ExecutionActor, command: Parameters<ExecutionCommands['consent']>[1]): string {
  const consent = commands.consent(actor, command);
  if (consent.kind !== 'refuse') throw new Error(`expected a refusal, got ${consent.kind}`);
  return consent.reason;
}

describe('a planner refused the user\'s merge', () => {
  it('is told the terminal UI user merges with /merge', () => {
    expect(refusal(seam('tui'), PLANNER, 'merge_all')).toBe('Merging the run\'s landed work is the user\'s: they are in this conversation, and merge it themselves (/merge). Tell them the work is ready to merge.');
  });

  it('is told, with automatic merging on, that the merge happens by itself', () => {
    const reason = refusal(seam('tui', true), PLANNER, 'merge_all');
    expect(reason).toBe('Merging is the user\'s, and automatic merging is on: landed work merges by itself at its merge gate and at the end of the run. Do not ask the user to merge.');
  });
});

describe('a planner refused one of the user\'s own controls', () => {
  it('is told the control the user\'s surface has for it', () => {
    expect(refusal(seam('vscode'), PLANNER, 'force_start')).toBe('Only the user may force start a task: they are in this conversation, and do it themselves (the task card\'s Start button, or its Approve button when it waits for approval). Suggest it to them, with why.');
  });

  it('names no button to a terminal UI user', () => {
    for (const command of ['force_start', 'mark_not_done', 'revert_task', 'interrupt_task', 'force_send_queued', 'remove_queued', 'cancel_resume', 'approve_review'] as const) {
      expect(refusal(seam('tui'), PLANNER, command), command).not.toMatch(/button|card|press/i);
    }
  });

  it('tells a planner how a terminal UI user answers a checkpoint', () => {
    const reason = refusal(seam('tui'), PLANNER, 'answer_checkpoint');
    expect(reason).toContain('The user answers it themselves (/checkpoint <id> approve, or /checkpoint <id> reject <reason>)');
    expect(reason).not.toMatch(/button|card/i);
  });

  it('tells a supervisor at Watch how the user answers a checkpoint', () => {
    expect(refusal(seam('desktop'), { kind: 'supervisor', level: 'watch' }, 'answer_checkpoint'))
      .toContain('The user answers it themselves (the Approve & Continue or Reject button on the task\'s checkpoint panel)');
  });

  it('tells a planner how the user skips a task', () => {
    expect(refusal(seam('tui'), PLANNER, 'skip_task')).toContain('and skip it themselves (/skip <id>)');
  });
});
