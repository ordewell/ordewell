import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { EMPTY_TASK_LOG, EMPTY_TASK_LOG_FOLLOW, taskLogHeaderView, type DisplayBlock } from '@ordewell/core';
import TaskLogApp from '../../test/TaskLogApp';
import type { HostToTaskLog, TaskLogStatus } from '../../shared/taskLogProtocol';

/*
 * The shared message renderer serves the task log too, but its own patch seam
 * is the place a streamed block is replaced — so one focused case guards the
 * same selection fix there. jsdom only: see App.copyShortcut.test.tsx.
 */

import { hostApi as api } from '../../test/hostApi';

function send(msg: HostToTaskLog): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

function status(): TaskLogStatus {
  const follow = { ...EMPTY_TASK_LOG_FOLLOW, view: { ...EMPTY_TASK_LOG, working: true }, attempts: [1], attempt: 1 };
  return {
    taskId: 't1', order: 1, title: 'Parse JSON', runner: 'claude-code',
    header: taskLogHeaderView({ status: 'in_progress', resumeAt: null, continuable: false, attemptUsage: [] }, follow, 0, 1),
    queued: [], attempts: [1], attempt: 1,
  };
}

const agent = (text: string, streaming = false): DisplayBlock => ({ type: 'message', id: 'b1', role: 'agent', text, streaming });
const body = () => document.querySelector('.task-log-body .chat-msg-content') as HTMLElement;
const codeText = () => body().querySelector('code')!.firstChild as Text;
const selected = () => window.getSelection()?.toString() ?? '';

function select(node: Node, start = 0, end = node.textContent?.length ?? 0): string {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}

describe('selection retention in a task log', () => {
  beforeEach(() => {
    render(<TaskLogApp />);
    send({ type: 'init', status: status(), blocks: [agent('Run `npm test` before you commit.', true)] });
    api.post.mockClear();
  });

  it('keeps the exact selection inside a streaming agent message when the next patch arrives', () => {
    expect(select(codeText())).toBe('npm test');
    const active = document.activeElement;

    send({ type: 'patch', order: ['b1'], changed: [agent('Run `npm test` before you commit. Then open the pull request.', true)] });

    expect(selected()).toBe('npm test');
    expect(document.activeElement).toBe(active);
  });
});
