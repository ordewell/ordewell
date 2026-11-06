import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createTask, type HandoffDigest, type HandoffPatch, type RunTask } from '@ordewell/core';
import App from '../../test/ChatApp';
import { api, post } from './webview';

const task = createTask({ id: 't1', order: 1, title: 'Review boundary', status: 'completed', attempted: true });
const handoff: HandoffDigest = {
  summary: 'Keep the token scoped.\nMore context.', findingCount: 28,
  findings: [{ id: 'F1', severity: 'blocker', title: 'Sibling read', detail: 'The token can read a sibling.', evidence: [{ kind: 'file', path: 'src/token.ts', line: 42 }] }],
  artifacts: [{ kind: 'file', path: 'docs/review.md' }],
};

// An open card folds its handoff to one line; the digest shows once that fold opens.
const unfoldHandoff = (): void => { fireEvent.click(screen.getByRole('button', { name: /^Handoff/ })); };

function update(runTask: RunTask): void {
  post({ type: 'runView', view: { tasks: [runTask], runMerge: null, handoff: null, mergeResult: null } });
}

describe('task handoffs in the plan dock (ADR-0047)', () => {
  beforeEach(() => {
    render(<App />);
    api.post.mockClear();
    post({ type: 'planUpdated', plan: {
      tasks: [task], generatedAt: '', lastUpdated: '', status: 'approved', runners: [],
    } });
  });

  it('keeps the digest out of a collapsed card and shows it when expanded', () => {
    update({ ...task, handoff });
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    expect(document.body).not.toHaveTextContent('Keep the token scoped.');
    fireEvent.click(screen.getByText('Review boundary'));
    expect(document.querySelector('.task-handoff')).toBeNull();
    expect(screen.getByRole('button', { name: /^Handoff/ })).toHaveTextContent('Keep the token scoped. · 28 findings');
    unfoldHandoff();
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    expect(screen.getByText(/Keep the token scoped\./)).toBeTruthy();
    expect(screen.getByText('F1 · Blocker · Sibling read')).toBeTruthy();
    expect(screen.getByText('The token can read a sibling.')).toBeTruthy();
    expect(screen.getByText(/src\/token.ts:42 \(unresolved\)/)).toBeTruthy();
    expect(screen.getByText("+27 more findings, in the attempt's log")).toBeTruthy();
    expect(screen.getByText('docs/review.md (unresolved)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read full handoff' }));
    expect(api.post).toHaveBeenCalledWith({ type: 'openTaskLog', taskId: 't1' });
    update({ ...task, status: 'in_progress', handoff: undefined });
    expect(document.querySelector('.task-fold-handoff')).toBeNull();
    fireEvent.click(screen.getByText('Review boundary'));
    expect(document.body).not.toHaveTextContent('Keep the token scoped.');
  });

  it('starts the summary at its first line with words', () => {
    update({ ...task, handoff: { ...handoff, summary: '\n\n  Keep the token scoped.\nMore context.' } });
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    expect(document.body).not.toHaveTextContent('Keep the token scoped.');
    fireEvent.click(screen.getByText('Review boundary'));
    expect(screen.getByText(/Keep the token scoped\./)).toBeTruthy();
  });

  it('shows the commit before the summary, and a handoff with only a commit, when expanded', () => {
    update({ ...task, handoff: { ...handoff, commit: { subject: 'Scope the token', body: 'Reads stay in the tenant.' } } });
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    fireEvent.click(screen.getByText('Review boundary'));
    unfoldHandoff();
    const section = document.querySelector('.task-handoff')!;
    expect(section.querySelector('.task-handoff-commit')).toHaveTextContent('Commit: Scope the token Reads stay in the tenant.');
    expect(section.querySelector('.task-handoff-commit')!.compareDocumentPosition(section.querySelector('.task-handoff-summary')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.click(screen.getByText('Review boundary'));
    update({ ...task, handoff: { summary: '', findings: [], findingCount: 0, commit: { subject: 'Only a commit' } } });
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    fireEvent.click(screen.getByText('Review boundary'));
    unfoldHandoff();
    expect(document.querySelector('.task-handoff-commit-subject')).toHaveTextContent('Commit: Only a commit');
    expect(document.querySelector('.task-handoff-summary')).toBeNull();
  });

  it('shows a script handoff from a saved plan with no findings, and opens its chat', () => {
    post({ type: 'planUpdated', plan: {
      tasks: [{ ...task, type: 'script', handoff: { summary: 'Finished', findings: [], findingCount: 0 } }],
      generatedAt: '', lastUpdated: '', status: 'approved', runners: [],
    } });
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    expect(document.body).not.toHaveTextContent('Finished');
    fireEvent.click(screen.getByText('Review boundary'));
    unfoldHandoff();
    expect(screen.getByText('Handoff · no findings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read full handoff' }));
    expect(api.post).toHaveBeenCalledWith({ type: 'openTaskLog', taskId: 't1' });
  });

  it('shows a manual handoff without offering a chat it never had', () => {
    post({ type: 'planUpdated', plan: {
      tasks: [{ ...task, type: 'user', attempted: undefined, handoff: { summary: 'Finished', findings: [], findingCount: 0 } }],
      generatedAt: '', lastUpdated: '', status: 'approved', runners: [],
    } });
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    expect(document.body).not.toHaveTextContent('Finished');
    fireEvent.click(screen.getByText('Review boundary'));
    unfoldHandoff();
    expect(screen.getByText('Handoff · no findings')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Read full handoff' })).toBeNull();
  });

  it('shows the saved patch its attempt kept, and opens it in an editor tab (ADR-0050)', () => {
    const patch: HandoffPatch = {
      kind: 'patch', path: '.ordewell/sessions/s1/tasks/t1/1.patch', attempt: 1,
      base: 'a'.repeat(40), files: 2, added: 9, removed: 1, binary: 0, bytes: 900, sha256: 'f'.repeat(64),
      flags: [{ kind: 'excluded', count: 1, paths: ['docs/link'] }],
    };
    update({ ...task, handoff: { ...handoff, artifacts: [patch] } });

    expect(document.querySelector('.task-handoff-peek')).toBeNull();
    expect(document.body).not.toHaveTextContent('Tried it.');
    fireEvent.click(screen.getByText('Review boundary'));
    unfoldHandoff();
    const block = document.querySelector('.task-handoff-patch')!;
    expect(block).toHaveTextContent('Patch · 2 files, +9 -1, 900 B');
    expect(block).toHaveTextContent('saved as .ordewell/sessions/s1/tasks/t1/1.patch (attempt 1)');
    expect(block).toHaveTextContent('from commit aaaaaaaaaaaa');
    expect(block).toHaveTextContent('not carried (links and submodules): 1 file (docs/link)');
    fireEvent.click(screen.getByRole('button', { name: 'Open patch' }));
    expect(api.post).toHaveBeenCalledWith({ type: 'openFile', path: '.ordewell/sessions/s1/tasks/t1/1.patch' });
  });

  it('keeps the loop badge and status beside a handoff', () => {
    const check = { ...task, status: 'failed' as const, loop: { body: ['fix'], maxRounds: 3 }, loopRound: 1,
      verdict: { outcome: 'fail' as const, reported: 'failed' as const, reason: 'Found problems', checks: [], decidedAt: '' } };
    post({ type: 'planUpdated', plan: {
      tasks: [check, createTask({ id: 'fix', order: 2, title: 'Fix', dependencies: ['t1'] })],
      generatedAt: '', lastUpdated: '', status: 'running', runners: [],
    } });
    update({ ...check, handoff });
    expect(document.querySelector('.loop')).toHaveTextContent(/round 1 of 3/i);
    expect(document.querySelector('.status-failed')).toBeNull();
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
  });
});
