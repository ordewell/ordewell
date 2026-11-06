import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ApprovalBlock, DisplayBlock, MessageBlock, SubagentBlock, ThinkingDisplayBlock, ToolBlock } from '@ordewell/core';
import ChatMessage, { CommandRow, ConversationBlocks, SubagentCard, ThinkingBlock, renderMarkdown } from '../ChatMessage';

const message = (over: Partial<MessageBlock>): MessageBlock => ({ type: 'message', id: 'm', role: 'planner', text: '', streaming: false, ...over });
const thinking = (over: Partial<ThinkingDisplayBlock> = {}): ThinkingDisplayBlock => ({
  type: 'thinking', id: 'th', text: 'First I read the config.\nThen the tests.', streaming: false, ...over,
});
const tool = (over: Partial<ToolBlock> = {}): ToolBlock => ({
  type: 'tool', id: 'tl', tool: 'bash', headline: { name: 'Bash', keyArg: 'ls -la' }, args: '{"command":"ls -la"}',
  status: 'ok', outcome: 'success', output: 'one\ntwo\nthree\nfour\nfive', outputLineCount: 5, ...over,
});
const subagent = (over: Partial<SubagentBlock> = {}): SubagentBlock => ({
  type: 'subagent', id: 'sa', subagentId: 'x', brief: 'explore the auth module', status: 'done',
  children: [tool({ id: 'c1', headline: { name: 'Read', keyArg: 'src/auth.ts' }, output: 'export {}', outputLineCount: 1 })],
  digest: 'Auth uses JWT.', ...over,
});

describe('ChatMessage', () => {
  it('shows the user\'s words as typed', () => {
    const { container } = render(<ChatMessage block={message({ role: 'user', text: 'use **JWT**' })} />);
    expect(container.querySelector('.chat-msg-user .chat-msg-content')!.textContent).toBe('use **JWT**');
  });

  it('marks a force-sent user line as sent now', () => {
    const { container } = render(<ChatMessage block={message({ role: 'user', text: 'stop, use Postgres', forced: true })} />);
    expect(container.querySelector('.chat-msg-user .chat-msg-forced')!.textContent).toBe('sent now');
    expect(container.querySelector('.chat-msg-user .chat-msg-content')!.textContent).toBe('stop, use Postgres');
  });

  it('renders a planner reply as markdown', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Use **JWT** in `auth.ts`' })} />);
    expect(container.querySelector('.chat-msg-planner strong')!.textContent).toBe('JWT');
    expect(container.querySelector('.chat-msg-planner code')!.textContent).toBe('auth.ts');
  });

  it('marks the supervisor\'s note apart from a planner reply, still as markdown', () => {
    const { container } = render(<ChatMessage block={message({ role: 'supervisor', text: 'Task 1 **failed**; retry it?' })} />);
    expect(container.querySelector('.chat-msg-planner.chat-msg-supervisor .chat-msg-label')!.textContent).toBe('Supervisor');
    expect(container.querySelector('.chat-msg-supervisor strong')!.textContent).toBe('failed');
  });

  it('shows the run update that woke the supervisor as its own card, as it was sent', () => {
    const { container } = render(<ChatMessage block={message({ role: 'wake_up', text: 'Run update:\n- task #1 "Build" failed: **tests**' })} />);
    expect(container.querySelector('.chat-msg-wake-up .chat-msg-label')!.textContent).toBe('Run update');
    expect(container.querySelector('.chat-msg-wake-up .chat-msg-content')!.textContent).toBe('- task #1 "Build" failed: **tests**');
    expect(container.querySelector('.chat-msg-planner')).toBeNull();
  });

  describe('a run update that delivers a research report (ADR-0037 R2)', () => {
    const digest = (lines: number): string => [
      'Run update:',
      `- task #3 "Scout the cache", whose result you asked for, has ended. ${['It passed.', ...Array.from({ length: lines - 1 }, (_, i) => `finding ${i + 1}`)].join('\n  ')}`,
      '- task #4 "Fix it" failed: tests red',
    ].join('\n');
    const report = (container: HTMLElement) => container.querySelector('.chat-report-body')!.textContent!.split('\n');

    it('draws a short report whole, set apart under its task, beside the update\'s other lines', () => {
      const { container } = render(<ChatMessage block={message({ role: 'wake_up', text: digest(4) })} />);
      expect(container.querySelector('.chat-msg-wake-up .chat-msg-label')!.textContent).toBe('Run update');
      expect(container.querySelector('.chat-report-head')!.textContent).toBe('Report from task #3 "Scout the cache"');
      expect(report(container)).toEqual(['It passed.', 'finding 1', 'finding 2', 'finding 3']);
      expect(container.querySelector('.cmd-row-more')).toBeNull();
      expect(container.querySelector('.chat-msg-wake-up .chat-msg-content')!.textContent).toContain('- task #4 "Fix it" failed: tests red');
    });

    it('folds a long report and counts what it leaves out, until its own disclosure opens it', () => {
      const { container } = render(<ChatMessage block={message({ role: 'wake_up', text: digest(20) })} />);
      expect(report(container)).toHaveLength(8);
      const more = container.querySelector('button.cmd-row-more')!;
      expect(more.textContent).toBe('+12 lines of the report');
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector(`#${CSS.escape(more.getAttribute('aria-controls')!)}`)).toBe(container.querySelector('.chat-report-body'));

      fireEvent.click(more);
      expect(report(container)).toHaveLength(20);
      expect(report(container).at(-1)).toBe('finding 19');
      expect(more.getAttribute('aria-expanded')).toBe('true');
      expect(more.textContent).toBe('Show less of the report');

      fireEvent.click(more);
      expect(report(container)).toHaveLength(8);
    });

    it('opens each long report on its own', () => {
      const two = [
        'Run update:',
        `- task #3 "Scout", whose result you asked for, has ended. ${Array.from({ length: 20 }, (_, i) => `a${i + 1}`).join('\n  ')}`,
        `- task #4 "Probe", whose result you asked for, has ended. ${Array.from({ length: 20 }, (_, i) => `b${i + 1}`).join('\n  ')}`,
      ].join('\n');
      const { container } = render(<ConversationBlocks blocks={[message({ id: 'w', role: 'wake_up', text: two })]} onShowPlan={() => {}} />);
      const bodies = () => Array.from(container.querySelectorAll('.chat-report-body')).map((b) => b.textContent!.split('\n').length);
      expect(bodies()).toEqual([8, 8]);
      fireEvent.click(container.querySelectorAll('button.cmd-row-more')[1]);
      expect(bodies()).toEqual([8, 20]);
    });
  });

  it('renders a reply still streaming as markdown, marked live', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Reading **the', streaming: true })} />);
    expect(container.querySelector('.chat-msg-planner.streaming .chat-msg-content')!.textContent).toBe('Reading **the');
    expect(container.querySelector('.chat-msg-cursor')).toBeTruthy();
  });

  it('draws a fence still streaming as a code block, not as stray backticks', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Try:\n\n```sh\nnpm test', streaming: true })} />);
    expect(container.querySelector('.chat-msg-content pre > code')?.textContent).toBe('npm test');
  });

  it('shows a notice as a muted system line and an error as an error line', () => {
    const { container } = render(<>
      <ChatMessage block={message({ id: 'a', role: 'system', text: 'Approved: npm test' })} />
      <ChatMessage block={message({ id: 'b', role: 'error', text: 'Planner failed' })} />
    </>);
    expect(container.querySelector('.chat-msg-system')!.textContent).toBe('Approved: npm test');
    expect(container.querySelector('.chat-msg-error')!.textContent).toBe('Planner failed');
  });
});

describe('ThinkingBlock', () => {
  it('is one line when collapsed', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded={false} />);
    expect(container.querySelector('.activity-think-head')!.textContent).toContain('Thinking');
    expect(container.querySelector('.activity-think-line')!.textContent).toBe('First I read the config.');
    expect(container.querySelector('.activity-think-pre')).toBeNull();
  });

  it('says it is still thinking while it streams', () => {
    const { container } = render(<ThinkingBlock block={thinking({ streaming: true })} expanded={false} />);
    expect(container.querySelector('.activity-think-head')!.textContent).toContain('Thinking…');
  });

  it('shows all of it when expanded', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded />);
    expect(container.querySelector('.activity-think-pre')!.textContent).toBe('First I read the config.\nThen the tests.');
  });

  it('opens through its own disclosure button, which says what it controls', () => {
    const onToggle = vi.fn();
    const { container } = render(<ThinkingBlock block={thinking()} expanded={false} onToggle={onToggle} />);
    const button = container.querySelector('button.activity-think-head')!;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector(`#${CSS.escape(button.getAttribute('aria-controls')!)}`)).toBeTruthy();
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('CommandRow', () => {
  it('marks a command that ran sealed, and no other (ADR-0036 S4)', () => {
    const sealed = render(<CommandRow block={tool({ sealed: true })} expanded={false} />);
    expect(sealed.container.querySelector('.cmd-row-sealed')!.textContent).toBe('sealed');
    const plain = render(<CommandRow block={tool()} expanded={false} />);
    expect(plain.container.querySelector('.cmd-row-sealed')).toBeNull();
  });

  it('heads the row with the tool and its main argument, in monospace', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    const head = container.querySelector('code.cmd-row-head')!;
    expect(head.textContent).toBe('Bash(ls -la)');
  });

  it('previews three lines of output and counts the rest', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('one\ntwo\nthree');
    expect(container.querySelector('.cmd-row-more')!.textContent).toBe('+2 lines');
    expect(container.querySelector('.cmd-row-args')).toBeNull();
  });

  it('shows no count when the output fits', () => {
    const { container } = render(<CommandRow block={tool({ output: 'one\ntwo', outputLineCount: 2 })} expanded={false} />);
    expect(container.querySelector('.cmd-row-more')).toBeNull();
  });

  it('shows the full arguments and output when expanded', () => {
    const { container } = render(<CommandRow block={tool()} expanded />);
    expect(container.querySelector('.cmd-row-args')!.textContent).toBe('{\n  "command": "ls -la"\n}');
    expect(container.querySelector('.cmd-row-output')!.textContent).toBe('one\ntwo\nthree\nfour\nfive');
    expect(container.querySelector('.cmd-row-more')).toBeNull();
  });

  it('marks a pending call, and names an outcome that is not a plain success', () => {
    const { container } = render(<>
      <CommandRow block={tool({ id: 'a', status: 'pending', outcome: undefined, output: '', outputLineCount: 0 })} expanded={false} />
      <CommandRow block={tool({ id: 'b', status: 'denied', outcome: 'refused', output: 'Command refused', outputLineCount: 1 })} expanded={false} />
    </>);
    const rows = container.querySelectorAll('.cmd-row');
    expect(rows[0].getAttribute('data-status')).toBe('pending');
    expect(rows[1].getAttribute('data-status')).toBe('denied');
    expect(rows[1].querySelector('.cmd-row-outcome')!.textContent).toBe('refused');
  });

  it('opens through its header, a native button that keeps the outcome and sealed marks beside it', () => {
    const onToggle = vi.fn();
    const { container } = render(<CommandRow block={tool({ sealed: true, status: 'error', outcome: 'failure' })} expanded={false} onToggle={onToggle} />);
    const button = container.querySelector('.cmd-row-header > button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.querySelector('code.cmd-row-head')!.textContent).toBe('Bash(ls -la)');
    expect(button.querySelector('.cmd-row-sealed, .cmd-row-outcome')).toBeNull();
    expect(container.querySelector(`#${CSS.escape(button.getAttribute('aria-controls')!)}`)!.contains(container.querySelector('.cmd-row-preview'))).toBe(true);
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not toggle when the click ends a text selection in its header, so the command can be copied', () => {
    const onToggle = vi.fn();
    const { container } = render(<CommandRow block={tool()} expanded={false} onToggle={onToggle} />);
    const range = document.createRange();
    range.selectNodeContents(container.querySelector('.cmd-row-arg')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(container.querySelector('.cmd-row-header > button')!);
    expect(onToggle).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
    fireEvent.click(container.querySelector('.cmd-row-header > button')!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('lets a path argument give way from the left, keeping the whole path in its tooltip', () => {
    const path = '/home/dev/app/.ordewell/worktrees/3c3de77a/2-a-task/src/conversation/taskLog.ts';
    const { container } = render(<CommandRow block={tool({ headline: { name: 'Read', keyArg: path } })} expanded={false} />);
    const arg = container.querySelector('.cmd-row-arg')!;
    expect(arg.classList.contains('path')).toBe(true);
    expect(arg.getAttribute('title')).toBe(path);
    expect(container.querySelector('code.cmd-row-head')!.textContent).toBe(`Read(${path})`);
    const { container: command } = render(<CommandRow block={tool()} expanded={false} />);
    expect(command.querySelector('.cmd-row-arg')!.classList.contains('path')).toBe(false);
  });
});

describe('CommandRow for a file edit', () => {
  const SUM = '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';
  const edit = (output = SUM, over: Partial<ToolBlock> = {}) => tool({
    tool: 'agent_tool', toolLabel: 'Update', headline: { name: 'Update', keyArg: 'src/sum.ts' }, args: '{"path":"src/sum.ts"}',
    output, outputLineCount: output.split('\n').length, diff: { added: 1, removed: 1 }, ...over,
  });
  const rows = (container: HTMLElement) => Array.from(container.querySelectorAll('.diff-line')).map((row) => [
    row.getAttribute('data-kind'), row.querySelector('.diff-num')!.textContent, row.querySelector('.diff-sign')!.textContent, row.querySelector('.diff-text')!.textContent,
  ]);

  it('says what the edit changed, then its lines numbered and marked, an addition and a removal told apart', () => {
    const { container } = render(<CommandRow block={edit()} expanded={false} />);
    expect(container.querySelector('.diff-summary')!.textContent).toBe('Added 1 line, removed 1 line');
    expect(rows(container)).toEqual([
      ['context', '1', ' ', 'export function sum(a, b) {'],
      ['removed', '2', '-', '  return a - b;'],
      ['added', '2', '+', '  return a + b;'],
      ['context', '3', ' ', '}'],
    ]);
    expect(container.querySelector('.cmd-row-preview')).toBeNull();
  });

  it('previews ten lines of a long diff and counts the rest, showing all of it when expanded', () => {
    const output = Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`).join('\n');
    const block = edit(output, { diff: { added: 30, removed: 0 } });
    const { container } = render(<CommandRow block={block} expanded={false} />);
    expect(rows(container)).toHaveLength(10);
    expect(container.querySelector('.cmd-row-more')!.textContent).toBe('+20 lines');

    const { container: open } = render(<CommandRow block={block} expanded />);
    expect(rows(open)).toHaveLength(30);
    expect(open.querySelector('.cmd-row-more')).toBeNull();
    expect(open.querySelector('.cmd-row-output')).toBeNull();
  });

  it('marks the lines between two hunks', () => {
    const { container } = render(<CommandRow block={edit('@@ -1 +1 @@\n-a\n+A\n@@ -40 +40 @@\n-b\n+B\n')} expanded={false} />);
    expect(container.querySelectorAll('.diff-gap')).toHaveLength(1);
  });

  it('draws an edit that reported no diff as an ordinary row', () => {
    const { container } = render(<CommandRow block={edit('The file was updated.', { diff: undefined })} expanded={false} />);
    expect(container.querySelector('.diff-summary')).toBeNull();
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('The file was updated.');
  });
});

describe('SubagentCard', () => {
  it('shows its brief, status and digest when collapsed, but not its steps', () => {
    const { container } = render(<SubagentCard block={subagent()} expanded={false} />);
    expect(container.querySelector('.subagent-card-brief')!.textContent).toBe('explore the auth module');
    expect(container.querySelector('.subagent-card-status')!.textContent).toBe('done');
    expect(container.querySelector('.subagent-card-digest')!.textContent).toBe('Auth uses JWT.');
    expect(container.querySelector('.subagent-card-steps')).toBeNull();
  });

  it('says a subagent is still running', () => {
    const { container } = render(<SubagentCard block={subagent({ status: 'running', digest: '' })} expanded={false} />);
    expect(container.querySelector('.subagent-card')!.getAttribute('data-status')).toBe('running');
    expect(container.querySelector('.subagent-card-status')!.textContent).toBe('running…');
    expect(container.querySelector('.subagent-card-digest')).toBeNull();
  });

  it('shows its nested steps as their own collapsed previews when expanded, not opened with it', () => {
    const { container } = render(<SubagentCard block={subagent()} expanded />);
    const steps = container.querySelector('.subagent-card-steps')!;
    expect(steps.querySelector('code.cmd-row-head')!.textContent).toBe('Read(src/auth.ts)');
    expect(steps.querySelector('.cmd-row-preview')!.textContent).toBe('export {}');
    expect(steps.querySelector('.cmd-row-output')).toBeNull();
  });
});

describe('ConversationBlocks', () => {
  const blocks: DisplayBlock[] = [
    message({ id: 'u', role: 'user', text: 'add a parser' }),
    thinking({ id: 'th' }),
    tool({ id: 'tl' }),
    subagent({ id: 'sa' }),
    message({ id: 'p', text: 'Done.' }),
  ];

  const draw = (list: readonly DisplayBlock[] = blocks) => render(<ConversationBlocks blocks={list} onShowPlan={() => {}} />);
  const group = (container: HTMLElement, i = 0) => container.querySelectorAll<HTMLButtonElement>('.activity-group-toggle')[i];
  const rowToggle = (container: HTMLElement, selector: string, i = 0) => container.querySelectorAll<HTMLButtonElement>(`${selector} button[aria-expanded]`)[i];

  it('draws messages in order with the activity between them folded into one quiet group', () => {
    const { container } = draw();
    const kinds = Array.from(container.querySelector('.conversation')!.children).map((el) => el.className.split(' ')[0]);
    expect(kinds).toEqual(['chat-msg', 'activity-group', 'chat-msg']);
    expect(group(container).textContent).toBe('Ran a command, delegated to an agent');
  });

  it('starts every group collapsed, drawing none of what it holds', () => {
    const { container } = draw();
    const toggle = group(container);
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = container.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!;
    expect(body.hasAttribute('hidden')).toBe(true);
    expect(body.childElementCount).toBe(0);
    expect(container.querySelectorAll('.activity-think, .cmd-row, .subagent-card')).toHaveLength(0);
  });

  it('opens a group to exactly the collapsed previews of its rows, each with a disclosure of its own', () => {
    const { container } = draw();
    fireEvent.click(group(container));
    expect(group(container).getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.activity-think-line')!.textContent).toBe('First I read the config.');
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('one\ntwo\nthree');
    expect(container.querySelector('.subagent-card-digest')!.textContent).toBe('Auth uses JWT.');
    expect(container.querySelectorAll('.activity-think-pre, .cmd-row-output, .cmd-row-args, .subagent-card-steps')).toHaveLength(0);
    const rows = container.querySelectorAll('.activity-group-body button[aria-expanded="false"]');
    expect(rows).toHaveLength(3);
  });

  it('opens one row at a time, leaving its neighbours as they were', () => {
    const two = [tool({ id: 'a' }), tool({ id: 'b', headline: { name: 'Bash', keyArg: 'pwd' }, output: '/repo', outputLineCount: 1 })];
    const { container } = draw(two);
    fireEvent.click(group(container));
    fireEvent.click(rowToggle(container, '.cmd-row', 1));
    expect(container.querySelectorAll('.cmd-row-output')).toHaveLength(1);
    expect(container.querySelector('.cmd-row-output')!.textContent).toBe('/repo');
    expect(container.querySelector('.cmd-row-args')!.textContent).toBe('{\n  "command": "ls -la"\n}');
    expect(rowToggle(container, '.cmd-row', 0).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('one\ntwo\nthree');
  });

  it('opens a subagent to its steps as previews, each step opening on its own', () => {
    const { container } = draw([subagent({ id: 'sa', children: [
      tool({ id: 'c1', headline: { name: 'Read', keyArg: 'src/auth.ts' }, output: 'export {}', outputLineCount: 1 }),
      tool({ id: 'c2', headline: { name: 'Grep', keyArg: 'jwt' }, output: 'src/auth.ts:1', outputLineCount: 1 }),
    ] })]);
    fireEvent.click(group(container));
    fireEvent.click(container.querySelector<HTMLButtonElement>('.subagent-card-header')!);
    expect(container.querySelectorAll('.subagent-card-steps .cmd-row')).toHaveLength(2);
    expect(container.querySelectorAll('.cmd-row-output')).toHaveLength(0);
    fireEvent.click(rowToggle(container, '.subagent-card-steps .cmd-row', 1));
    expect(container.querySelectorAll('.cmd-row-output')).toHaveLength(1);
    expect(container.querySelector('.cmd-row-output')!.textContent).toBe('src/auth.ts:1');
    expect(container.querySelector('.subagent-card-header')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps what was opened as the live blocks grow, settle and append, and recounts the summary', () => {
    const live: DisplayBlock[] = [message({ id: 'u', role: 'user' }), tool({ id: 'a' }), tool({ id: 'b', status: 'pending', outcome: undefined, output: '', outputLineCount: 0 })];
    const { container, rerender } = draw(live);
    expect(group(container).textContent).toBe('Ran a command (1 more running)');
    fireEvent.click(group(container));
    fireEvent.click(rowToggle(container, '.cmd-row', 0));

    const settled: DisplayBlock[] = [...live.slice(0, 2), tool({ id: 'b', output: 'done', outputLineCount: 1 }), thinking({ id: 'th', streaming: true }), tool({ id: 'c', tool: 'fetch', status: 'error', outcome: 'failure' })];
    rerender(<ConversationBlocks blocks={settled} onShowPlan={() => {}} />);
    expect(group(container).textContent).toBe('Ran 2 commands, fetched a page (1 failed), thinking…');
    expect(group(container).getAttribute('aria-expanded')).toBe('true');
    expect(rowToggle(container, '.cmd-row', 0).getAttribute('aria-expanded')).toBe('true');
    expect(rowToggle(container, '.cmd-row', 1).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.cmd-row-output')).toHaveLength(1);
    expect(container.querySelectorAll('.cmd-row')).toHaveLength(3);
  });

  it('keeps a row\'s own choice when its call becomes the subagent it started', () => {
    const call = tool({ id: 'sp', tool: 'spawn_research_agent', status: 'pending', outcome: undefined, spawns: 'x', headline: { name: 'Agent', keyArg: 'explore auth' }, output: '', outputLineCount: 0 });
    const { container, rerender } = draw([call]);
    expect(group(container).textContent).toBe('Delegating to an agent');
    fireEvent.click(group(container));
    fireEvent.click(rowToggle(container, '.cmd-row'));
    rerender(<ConversationBlocks blocks={[subagent({ id: 'sp', status: 'running', digest: '', children: [tool({ id: 'k1' })] })]} onShowPlan={() => {}} />);
    expect(group(container).textContent).toBe('Delegating to an agent');
    expect(container.querySelector('.subagent-card-header')!.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.subagent-card-steps')).toHaveLength(1);
  });

  it('never merges across a message, and keeps an open group open when the message between two is taken back', () => {
    const before: DisplayBlock[] = [tool({ id: 'a' }), message({ id: 'p', text: 'Reading on.' }), tool({ id: 'b' })];
    const { container, rerender } = draw(before);
    expect(container.querySelectorAll('.activity-group')).toHaveLength(2);
    fireEvent.click(group(container, 1));
    rerender(<ConversationBlocks blocks={[before[0], before[2]]} onShowPlan={() => {}} />);
    expect(container.querySelectorAll('.activity-group')).toHaveLength(1);
    expect(group(container).textContent).toBe('Ran 2 commands');
    expect(group(container).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(group(container));
    expect(group(container).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a waiting approval outside any group, where it can be answered, and folds it in once answered', () => {
    const pending: ApprovalBlock = { type: 'approval', id: 'ap', approvalId: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm', status: 'pending' };
    const { container, rerender } = draw([tool({ id: 'a' }), pending]);
    expect(container.querySelector('.conversation > .approval-card .approval-card-allow')).toBeTruthy();
    rerender(<ConversationBlocks blocks={[tool({ id: 'a' }), { ...pending, status: 'granted', decidedBy: 'asked' }]} onShowPlan={() => {}} />);
    expect(container.querySelector('.conversation > .approval-card')).toBeNull();
    expect(group(container).textContent).toBe('Ran a command');
  });

  it('starts over for another conversation, keyed apart', () => {
    const { container, rerender } = render(<ConversationBlocks key={1} blocks={blocks} onShowPlan={() => {}} />);
    fireEvent.click(group(container));
    rerender(<ConversationBlocks key={2} blocks={blocks} onShowPlan={() => {}} />);
    expect(group(container).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the plan from a plan marker', () => {
    const onShowPlan = vi.fn();
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'generated', taskCount: 3, text: '' }]} onShowPlan={onShowPlan} />,
    );
    fireEvent.click(getByText('Plan generated · 3 tasks'));
    expect(onShowPlan).toHaveBeenCalled();
  });

  it('says a plan is being built while it streams', () => {
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'building', text: '{"tasks":' }]} onShowPlan={() => {}} />,
    );
    expect(getByText('Building plan…')).toBeTruthy();
  });

  it('marks an updated plan with its task count', () => {
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'updated', taskCount: 2, text: '' }]} onShowPlan={() => {}} />,
    );
    expect(getByText('Plan updated · 2 tasks')).toBeTruthy();
  });
});

describe('approval cards (ADR-0018, A1)', () => {
  const card = (over: Partial<ApprovalBlock> = {}): ApprovalBlock => ({
    type: 'approval', id: 'ap', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Write(/repo/a.txt)', scope: 'Write', status: 'pending', allowForTask: true, ...over,
  });

  function draw(block: ApprovalBlock) {
    const onAnswerApproval = vi.fn();
    const onResolveApproval = vi.fn();
    const view = render(<ConversationBlocks blocks={[block]} onShowPlan={() => {}}
      onAnswerApproval={onAnswerApproval} onResolveApproval={onResolveApproval} />);
    // An answered card folds into the activity it belongs to; open it to read the card.
    const group = view.container.querySelector<HTMLButtonElement>('.activity-group-toggle');
    if (group) fireEvent.click(group);
    return { ...view, onAnswerApproval, onResolveApproval };
  }

  it('answers a runner\'s request with the runner\'s own decisions, never the planner\'s yes/no', () => {
    const { getByText, onAnswerApproval, onResolveApproval } = draw(card());
    expect(getByText('Use a tool')).toBeTruthy();
    expect(getByText('Waiting for you')).toBeTruthy();

    fireEvent.click(getByText('Allow'));
    fireEvent.click(getByText('Allow for this task'));
    fireEvent.click(getByText('Deny'));

    expect(onAnswerApproval.mock.calls).toEqual([
      ['ap-1', { decision: 'allow' }],
      ['ap-1', { decision: 'allowForTask' }],
      // A blank note is no note: the agent is not handed an empty message.
      ['ap-1', { decision: 'deny' }],
    ]);
    expect(onResolveApproval).not.toHaveBeenCalled();
  });

  it('sends the typed note with a denial, trimmed', () => {
    const { getByText, getByPlaceholderText, onAnswerApproval } = draw(card());
    fireEvent.change(getByPlaceholderText(/Note to the agent/), { target: { value: '  use notes/ instead ' } });
    fireEvent.click(getByText('Deny'));
    expect(onAnswerApproval).toHaveBeenCalledWith('ap-1', { decision: 'deny', note: 'use notes/ instead' });
  });

  it('shows a script task start\'s body verbatim in a code block, pending and settled (ADR-0035)', () => {
    const body = 'git tag v1\n  git push origin v1\n\nTime limit: 10 minutes.';
    const start = card({ kind: 'task_start', approvalId: 'ap-2', subject: 'Run script task #2 "Push"', scope: 'Run script task #2 "Push"', body });

    const { container, getByText, onResolveApproval, unmount } = draw(start);
    expect(container.querySelector('pre.approval-card-body')?.textContent).toBe(body);
    fireEvent.click(getByText('Allow'));
    expect(onResolveApproval).toHaveBeenCalledWith('ap-2', true);
    unmount();

    const settled = draw({ ...start, status: 'granted', decidedBy: 'asked' });
    expect(settled.container.querySelector('pre.approval-card-body')?.textContent).toBe(body);
  });

  it('shows no body block on a request that has none', () => {
    const { container } = draw(card({ kind: 'shell_command' }));
    expect(container.querySelector('.approval-card-body')).toBeNull();
  });

  it('offers no grant for the task when the runner proposed none', () => {
    const { queryByText, getByText } = draw(card({ allowForTask: false }));
    expect(queryByText('Allow for this task')).toBeNull();
    expect(getByText('Allow')).toBeTruthy();
  });

  it.each<[Partial<ApprovalBlock>, string]>([
    [{ status: 'granted', decidedBy: 'asked' }, 'Approved'],
    [{ status: 'granted', decidedBy: 'asked', forTask: true }, 'Approved for this task'],
    [{ status: 'denied', decidedBy: 'asked', note: 'use notes/' }, 'Denied'],
    [{ status: 'withdrawn' }, 'Withdrawn'],
  ])('settles a runner card %o as "%s", with nothing left to press', (over, label) => {
    const { getByText, queryByText, container } = draw(card(over));
    expect(getByText(label)).toBeTruthy();
    expect(queryByText('Allow')).toBeNull();
    expect(queryByText('Deny')).toBeNull();
    expect(container.querySelector('.approval-card-note')).toBeNull();
    if (over.note) expect(getByText(`Note to the agent: ${over.note}`)).toBeTruthy();
  });

  it.each<[Partial<ApprovalBlock>, string, string]>([
    [{ kind: 'web_search', subject: 'tokio changelog', status: 'granted', decidedBy: 'mode' }, 'Search the web', 'Auto-approved (policy)'],
    [{ kind: 'url_fetch', subject: 'http://10.0.0.1/', status: 'denied', decidedBy: 'guard' }, 'Fetch a URL', 'Auto-denied (blocked address)'],
    [{ kind: 'url_fetch', subject: '(withheld)', status: 'denied', decidedBy: 'secret' }, 'Fetch a URL', 'Auto-denied (secret check)'],
    [{ kind: 'web_search', subject: 'tokio', status: 'denied', decidedBy: 'budget' }, 'Search the web', 'Auto-denied (web-read budget)'],
    [{ kind: 'url_fetch', subject: 'https://intra.example/', status: 'denied', decidedBy: 'excluded' }, 'Fetch a URL', 'Auto-denied (excluded)'],
    [{ kind: 'mcp_server', subject: 'probe: ./serve.sh', status: 'denied', decidedBy: 'mode' }, 'Start a project MCP server', 'Auto-denied (policy)'],
    [{ kind: 'mcp_server', subject: 'probe: ./serve.sh', status: 'denied', decidedBy: 'unsupported' }, 'Start a project MCP server', 'Auto-denied (not usable on this runner version)'],
  ])('names a web read and why it was decided without asking (%o)', (over, kind, label) => {
    const { getByText } = draw(card({ allowForTask: false, ...over }));
    expect(getByText(kind)).toBeTruthy();
    expect(getByText(label)).toBeTruthy();
  });

  it('keeps a planner\'s request on its own Allow/Deny card, answered yes or no', () => {
    const { getByText, queryByText, onAnswerApproval, onResolveApproval } = draw(card({
      kind: 'shell_command', subject: 'npm test', scope: 'npm test', allowForTask: undefined,
    }));
    expect(getByText('Run a command')).toBeTruthy();
    expect(queryByText('Allow for this task')).toBeNull();

    fireEvent.click(getByText('Allow'));
    fireEvent.click(getByText('Deny'));
    expect(onResolveApproval.mock.calls).toEqual([['ap-1', true], ['ap-1', false]]);
    expect(onAnswerApproval).not.toHaveBeenCalled();
  });
});

describe('renderMarkdown on planner text', () => {
  const parsed = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  };
  const linkOf = (html: string) => parsed(html).querySelector('a');

  it('lets no quote in a link carry an attribute out of its href', () => {
    const html = parsed(renderMarkdown('[docs](https://x.test/" style="position:fixed;inset:0" data-x=")'));

    expect(html.querySelector('[style]')).toBeNull();
    expect(html.querySelector('[data-x]')).toBeNull();
  });

  it('links only web URLs; anything else stays text', () => {
    expect(linkOf(renderMarkdown('[run](javascript:alert(1))'))).toBeNull();
    expect(linkOf(renderMarkdown('[docs](https://example.com/a)'))?.getAttribute('href')).toBe('https://example.com/a');
  });
});

describe('renderMarkdown on planner structure (#82)', () => {
  const parsed = (text: string) => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(text);
    return host;
  };

  it('draws headings', () => {
    const html = parsed('# Plan\n\n### Risks');

    expect(html.querySelector('h1')?.textContent).toBe('Plan');
    expect(html.querySelector('h3')?.textContent).toBe('Risks');
  });

  it('draws a table with its header and cells', () => {
    const html = parsed('| Task | Runner |\n| --- | --- |\n| parser | codex |');

    expect([...html.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Task', 'Runner']);
    expect([...html.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['parser', 'codex']);
  });

  it('nests a list inside a list item', () => {
    const html = parsed('- one\n  1. first\n  2. second\n- two');

    expect(html.querySelectorAll('ul > li')).toHaveLength(2);
    expect([...html.querySelectorAll('ul > li > ol > li')].map((li) => li.textContent)).toEqual(['first', 'second']);
  });

  it('keeps a code block verbatim, | and < included', () => {
    const html = parsed('```\nif (a | b < c) {}\n```');

    expect(html.querySelector('table')).toBeNull();
    expect(html.querySelector('pre > code')?.textContent).toBe('if (a | b < c) {}\n');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi'])('leaves a %s link as text', (url) => {
    const html = parsed(`[click](${url})`);

    expect(html.querySelector('a')).toBeNull();
    expect(html.textContent).toContain('click');
  });

  it('draws no image, only its alt text', () => {
    const html = parsed('![diagram](https://x.test/d.png)');

    expect(html.querySelector('img')).toBeNull();
    expect(html.textContent).toBe('diagram');
  });

  it('escapes a raw <script>', () => {
    const html = parsed('<script>alert(1)</script>');

    expect(html.querySelector('script')).toBeNull();
    expect(html.textContent).toBe('<script>alert(1)</script>');
  });
});

describe('ChatMessage selection retention', () => {
  const selected = () => window.getSelection()?.toString() ?? '';

  function select(node: Node): string {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }

  it('keeps the exact selection inside a streaming reply when the next delta arrives', () => {
    const { container, rerender } = render(<ChatMessage block={message({ text: 'Run `npm test` before you commit.', streaming: true })} />);
    const code = container.querySelector('.chat-msg-content code')!.firstChild as Text;
    expect(select(code)).toBe('npm test');
    const active = document.activeElement;

    rerender(<ChatMessage block={message({ text: 'Run `npm test` before you commit. Then push.', streaming: true })} />);

    expect(selected()).toBe('npm test');
    expect(document.activeElement).toBe(active);
  });
});
