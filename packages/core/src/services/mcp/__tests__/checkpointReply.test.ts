import { describe, it, expect } from 'vitest';
import { TASK_TOOLS, checkpointReply, toolListing } from '../tools';

/**
 * What a runner reads back from `checkpoint` (ADR-0022, V5). A checkpoint is
 * usually a yes/no question ("May I …?"), and a live Haiku task read a bare
 * "continue" as no answer to it and asked again.
 */
describe('checkpointReply', () => {
  it('says an approved checkpoint was approved, not only that the task may go on', () => {
    expect(checkpointReply({ kind: 'continue' })).toEqual({ text: 'approved: the user said yes — continue' });
  });

  it('says a rejected checkpoint was rejected, by whom, with the reason', () => {
    expect(checkpointReply({ kind: 'rejected', reason: 'keep the data' })).toEqual({ text: 'rejected: the user said no — keep the data' });
  });

  it('names the supervisor when it answered for the user, not the user', () => {
    expect(checkpointReply({ kind: 'continue', by: 'supervisor' })).toEqual({ text: 'approved: the supervisor said yes for the user — continue' });
    expect(checkpointReply({ kind: 'rejected', reason: 'keep the data', by: 'supervisor' })).toEqual({ text: 'rejected: the supervisor said no for the user — keep the data' });
  });
});

/**
 * The checkpoint tool's description is the only text some runners read at the
 * moment they choose to ask, so it carries when to ask, not only how.
 */
describe('the checkpoint tool as a runner is sent it', () => {
  const description = toolListing(TASK_TOOLS).find((t) => t.name === 'checkpoint')?.description ?? '';

  it('says a checkpoint stops the task and what waits on it, and when to ask', () => {
    expect(description).toContain('stops this task, and every task waiting on it, until someone answers');
    expect(description).toContain('ask only before an effect your brief did not authorise that cannot be undone or reaches outside the workspace');
    expect(description).toContain('never whether to keep waiting or to confirm what your brief says');
  });

  it('is one sentence', () => {
    expect(description.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });
});
