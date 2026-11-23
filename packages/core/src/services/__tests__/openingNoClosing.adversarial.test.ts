import { describe, expect, it } from 'vitest';
import { fanOutShape, gateNote, openingNote, withShapeNotes } from '../PlanFanOut';
import { createTask, type Task } from '../../models/Task';

const t = (id: string, deps: string[]): Task =>
  createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Fill in src/lib/${id}.py.`, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK' });
const slices = (n: number, deps: string[]) => Array.from({ length: n }, (_, i) => t(`s${i + 1}`, deps));

describe('a wide plan with no closing check', () => {
  it('does not tell the opening task or a gate that a closing check runs the tests', () => {
    const plan = [t('r', []), t('g', ['r']), ...slices(6, ['g'])];
    const shape = fanOutShape(plan);
    expect(shape.closers).toEqual([]);
    const out = withShapeNotes(plan);
    expect(out.find((x) => x.id === 'r')!.prompt).toContain(openingNote(shape));
    expect(openingNote(shape)).not.toContain('closing check');
    expect(gateNote(shape, shape.gates[1])).not.toContain('closing check');
  });
});
