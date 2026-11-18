import { describe, expect, it } from 'vitest';
import type { Task } from '../Task';
import { longChainNote } from '../PlanShape';

const t = (id: string, dependencies: string[] = [], title = `Implement module ${id} and its tests per the existing stub`) => ({ id, title, dependencies, type: 'ai', order: 0 }) as unknown as Task;

// Review #290: failing on ee49f8bc.
describe('the long-chain note, adversarially', () => {
  it('stays small on a 300-task serial chain (today: 18740 chars, all 300 titles)', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => t(`t${i}`, i ? [`t${i - 1}`] : []));
    const note = longChainNote(tasks)!;
    expect((note.match(/→/g) ?? []).length + 1).toBeLessThanOrEqual(12);
    expect(note.length).toBeLessThan(2000);
  });

  it('keeps the exemption the rule keeps: an edge another rule orders stays', () => {
    const plan = [t('expand', [], 'Add the new column beside the old'), t('migrate', ['expand'], 'Move call sites'), t('contract', ['migrate'], 'Delete the old column'), t('deploy', ['contract'], 'Push and watch the pipeline')];
    expect(longChainNote(plan)).toMatch(/another rule orders|a rule orders/);
  });
});
