import { describe, it, expect } from 'vitest';
import { taskStartedNotice } from '../notices';

describe('task notices', () => {
  it('names the task and the runner it started on, by the runner\'s name', () => {
    expect(taskStartedNotice('Add a parser', 'claude-code')).toBe('Started "Add a parser" · Claude Code');
    expect(taskStartedNotice('Add a parser', 'opencode')).toBe('Started "Add a parser" · OpenCode');
  });

  it('keeps the id of a runner it has no name for', () => {
    expect(taskStartedNotice('Add a parser', 'my-runner')).toBe('Started "Add a parser" · my-runner');
  });

  it('leaves the runner out when none is known', () => {
    expect(taskStartedNotice('Add a parser')).toBe('Started "Add a parser"');
  });
});
