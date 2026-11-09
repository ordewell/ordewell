import { describe, expect, it } from 'vitest';
import { planProgressCount } from '../../plan-utils';

type T = { id: string; order: number; title: string; status: string; idleSince?: string | null; subtasks?: T[] };
const t = (id: string, status: string, subtasks: T[] = [], idleSince?: string): T => ({ id, order: 1, title: id, status, subtasks, ...(idleSince ? { idleSince } : {}) });

describe('planProgressCount', () => {
  it('counts every task and subtask once, and only passed or skipped ones as done', () => {
    const plan = [
      t('passed', 'completed', [t('sub-passed', 'completed'), t('sub-waiting', 'awaiting_user')]),
      t('skipped', 'skipped'),
      t('failed', 'failed'),
      t('blocked', 'blocked'),
      t('paused', 'awaiting_user'),
      t('running', 'in_progress'),
      t('stalled', 'in_progress', [], '2026-11-01T00:00:00.000Z'),
      t('todo', 'pending'),
    ];
    expect(planProgressCount(plan)).toEqual({ done: 3, total: 10 });
  });

  it('is nothing of nothing for an empty plan', () => {
    expect(planProgressCount([])).toEqual({ done: 0, total: 0 });
  });
});
