import { describe, expect, it } from 'vitest';
import type { Task } from '../Task';
import { longChainNote, planShape } from '../PlanShape';

const t = (id: string, dependencies: string[] = []) => ({ id, title: `T ${id}`, dependencies, type: 'ai', order: 0 }) as unknown as Task;

describe('planShape', () => {
  it('measures the longest chain, its tasks and the widest level over top-level tasks', () => {
    const shape = planShape([t('a'), t('b', ['a']), t('c', ['a']), t('d', ['b']), t('e')]);
    expect(shape).toMatchObject({ tasks: 5, longestChain: 3, widestLevel: 2 });
    expect(shape?.chain.map((x) => x.id)).toEqual(['a', 'b', 'd']);
  });

  it('is undefined for no tasks and for a cycle, and ignores a dependency on no top-level task', () => {
    expect(planShape([])).toBeUndefined();
    expect(planShape([t('a', ['b']), t('b', ['a'])])).toBeUndefined();
    expect(planShape([t('a', ['sub-1'])])).toMatchObject({ longestChain: 1 });
  });
});

describe('longChainNote', () => {
  const chain = [t('a'), t('b', ['a']), t('c', ['b']), t('d', ['c']), t('e', ['a'])];

  it('names a chain of four or more, task by task, and refuses nothing', () => {
    expect(longChainNote(chain)).toBe('The plan\'s longest chain is 4 of its 5 top-level tasks, and its widest level 2: "T a" → "T b" → "T c" → "T d". Each of those dependencies should consume something its dependency creates that does not exist yet; where one only orders work, removing it lets the tasks run at once.');
  });

  it('says nothing of a contract and its fan-out', () => {
    expect(longChainNote([t('a'), t('b', ['a']), t('c', ['a']), t('d', ['b', 'c'])])).toBeUndefined();
  });

  it('tells an edit only of a chain it lengthened', () => {
    expect(longChainNote(chain, chain)).toBeUndefined();
    expect(longChainNote(chain, chain.slice(0, 3))).toMatch(/longest chain is 4/);
  });
});
