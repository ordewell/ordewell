import { describe, it, expect } from 'vitest';
import type { ApprovalKind } from '../../interfaces/IApproval';
import type { ApprovalSource } from '../../services/ApprovalPolicy';
import { approvalKindText, approvalStatusText, compactionText, handoffFindingsText, handoffPeekParts, planMarkerParts } from '../labels';

describe('what a conversation block says', () => {
  it.each([
    ['shell_command', 'Run a command'],
    ['url_fetch', 'Fetch a URL'],
    ['web_search', 'Search the web'],
    ['external_path', 'Read outside the workspace'],
    ['mcp_tool', 'Use an MCP tool'],
    ['mcp_server', 'Start a project MCP server'],
    ['runner_tool', 'Use a tool'],
    ['task_start', 'Start work'],
  ] as [ApprovalKind, string][])('names the %s request as "%s"', (kind, text) => {
    expect(approvalKindText(kind)).toBe(text);
  });

  it('says what every approval state is, in one phrase', () => {
    expect(approvalStatusText({ status: 'pending' })).toBe('Waiting for you');
    expect(approvalStatusText({ status: 'granted' })).toBe('Approved');
    expect(approvalStatusText({ status: 'granted', forTask: true })).toBe('Approved for this task');
    expect(approvalStatusText({ status: 'denied' })).toBe('Denied');
    expect(approvalStatusText({ status: 'withdrawn' })).toBe('Withdrawn');
    expect(approvalStatusText({ status: 'timed_out' })).toBe('Timed out');
    expect(approvalStatusText({ status: 'withdrawn' })).toBe('Withdrawn');
  });

  it('names the policy when nobody was asked, and stays plain when the user answered', () => {
    expect(approvalStatusText({ status: 'granted', decidedBy: 'asked' })).toBe('Approved');
    expect(approvalStatusText({ status: 'denied', decidedBy: 'asked' })).toBe('Denied');
    expect(approvalStatusText({ status: 'granted', decidedBy: 'mode', forTask: true })).toBe('Auto-approved (policy)');
    expect(approvalStatusText({ status: 'denied', decidedBy: 'guard' })).toBe('Auto-denied (blocked address)');
  });

  it.each([
    ['pre-approved', 'Auto-approved (pre-approved)'],
    ['remembered', 'Auto-approved (remembered)'],
    ['no-channel', 'Auto-approved (no approval channel)'],
    ['excluded', 'Auto-approved (excluded)'],
    ['secret', 'Auto-approved (secret check)'],
    ['budget', 'Auto-approved (web-read budget)'],
    ['unsupported', 'Auto-approved (not usable on this runner version)'],
  ] as [Exclude<ApprovalSource, 'asked' | 'mode' | 'guard'>, string][])('words the %s source as "%s"', (source, text) => {
    expect(approvalStatusText({ status: 'granted', decidedBy: source })).toBe(text);
  });

  it('words a denied request by the same policy source a granted one names', () => {
    expect(approvalStatusText({ status: 'denied', decidedBy: 'mode' })).toBe('Auto-denied (policy)');
    expect(approvalStatusText({ status: 'denied', decidedBy: 'secret' })).toBe('Auto-denied (secret check)');
  });

  it('says how big a plan became, in the one wording both surfaces join', () => {
    expect(planMarkerParts({ status: 'generated', taskCount: 3 })).toEqual(['Plan generated', '3 tasks']);
    expect(planMarkerParts({ status: 'updated', taskCount: 1 })).toEqual(['Plan updated', '1 task']);
    expect(planMarkerParts({ status: 'updated' })).toEqual(['Plan updated']);
    expect(planMarkerParts({ status: 'building', taskCount: 2 })).toEqual(['Building plan…']);
  });

  it('counts a handoff\'s findings, singular and none included', () => {
    expect(handoffFindingsText(0)).toBe('no findings');
    expect(handoffFindingsText(1)).toBe('1 finding');
    expect(handoffFindingsText(2)).toBe('2 findings');
  });

  it('peeks at a handoff count first, then severity, commit and summary', () => {
    expect(handoffPeekParts({ summary: 'Keep the token scoped.', findingCount: 2, severity: 'blocker' }))
      .toEqual(['2 findings', 'Blocker', 'Keep the token scoped.']);
    expect(handoffPeekParts({ summary: 'Finished', findingCount: 0, severity: null })).toEqual(['no findings', 'Finished']);
    expect(handoffPeekParts({ summary: 'What changed.', findingCount: 3, severity: 'minor', commit: { subject: ' Add the route ' } }))
      .toEqual(['3 findings', 'Minor', 'Commit: Add the route', 'What changed.']);
    expect(handoffPeekParts({ summary: '', findingCount: 1, severity: 'info', commit: { subject: 'Only a commit' } }))
      .toEqual(['1 finding', 'Info', 'Commit: Only a commit']);
  });

  it('names a saved patch before the commit, so a row shows the prototype it kept (ADR-0050)', () => {
    expect(handoffPeekParts({ summary: 'Tried it.', findingCount: 0, severity: null, patch: { peek: 'patch: 2 files, +9 -1' } }))
      .toEqual(['no findings', 'patch: 2 files, +9 -1', 'Tried it.']);
  });

  it('says what a done task changed, Ordewell\'s count, before the runner\'s own words', () => {
    expect(handoffPeekParts({ summary: 'Only added lines.', findingCount: 0, severity: null, change: '1 file, +1 -1', commit: { subject: 'Document --shout' } }))
      .toEqual(['no findings', '1 file, +1 -1', 'Commit: Document --shout', 'Only added lines.']);
  });

  it('takes the summary\'s first non-blank line, never a leading blank one', () => {
    expect(handoffPeekParts({ summary: '\n\n  Keep it scoped.  \nMore context.', findingCount: 0, severity: null }))
      .toEqual(['no findings', 'Keep it scoped.']);
    expect(handoffPeekParts({ summary: '\n \n', findingCount: 0, severity: null })).toEqual(['no findings']);
  });
});

describe('what a compaction says', () => {
  const planner = { type: 'compaction', id: 'b1', trigger: 'manual', origin: 'ordewell' } as const;

  it('reads as a status while it runs, and quietly once it is over', () => {
    expect(compactionText({ ...planner, status: 'running' })).toBe('Compacting context…');
    expect(compactionText({ ...planner, status: 'condensed' })).toBe('Context compacted');
    expect(compactionText({ ...planner, trigger: 'auto', status: 'condensed' })).toBe('Context compacted automatically');
    expect(compactionText({ ...planner, status: 'stopped' })).toBe('Compaction stopped · nothing changed');
    expect(compactionText({ ...planner, status: 'failed' })).toBe('Compaction failed · nothing changed');
  });

  it('says the sizes only when both were reported, and names who compacted', () => {
    expect(compactionText({ ...planner, origin: 'native', trigger: 'auto', status: 'condensed', preTokens: 150_000, postTokens: 9_000 }))
      .toBe('The planner compacted its context on its own · 150k → 9k tokens');
    expect(compactionText({ ...planner, origin: 'native', status: 'condensed', preTokens: 150_000 })).toBe('The planner compacted its context');
    expect(compactionText({ type: 'compaction', id: 'b2', trigger: 'auto' })).toBe('Context compacted by the runner on its own');
    expect(compactionText({ type: 'compaction', id: 'b2', trigger: 'manual', preTokens: 2_000, postTokens: 900 })).toBe('Context compacted · 2k → 900 tokens');
  });
});
