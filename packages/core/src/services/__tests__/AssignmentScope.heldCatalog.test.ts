import { describe, it, expect } from 'vitest';
import { assignmentIssue } from '../AssignmentScope';

const m = (modelId: string) => ({ modelId, modelLabel: modelId, variants: [] });
describe('status flags read against a partly held catalog', () => {
  const task = { type: 'ai', status: 'pending', assignedRunner: 'x', assignedModel: { modelId: 'shared/m' } };
  const base = { enabledRunners: ['x', 'y'], allowlist: { x: ['shared/m', 'x/z'] } };
  it('fully discovered: x lists shared/m, so the task is on its list', () => {
    expect(assignmentIssue(task, { ...base, models: { x: [m('shared/m'), m('x/z')], y: [m('shared/m')] } })).toBeNull();
  });
  it('x not yet discovered (held catalog): the same task is still not flagged', () => {
    expect(assignmentIssue(task, { ...base, models: { x: [], y: [m('shared/m')] } })).toBeNull();
  });
});
