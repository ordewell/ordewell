import { describe, expect, it, vi } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { ApprovalRecord, type ApprovalFields } from '../ApprovalRecord';
import type { RunnerModeInfo } from '../ModeResolver';
import { PlanStore } from '../PlanStore';

const MODES: RunnerModeInfo[] = [{ id: 'build', label: 'Build', description: 'Edits files' }, { id: 'plan', label: 'Plan', description: 'Reads only', readOnly: true }];

const task = (id: string, over: Partial<Task> = {}): Task =>
  createTask({ id, order: 1, title: id, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });
const scout = (id: string, over: Partial<Task> = {}): Task => task(id, { research: true, taskMode: 'plan', ...over });

/** The record on a bare store and a bare plan: no Session, as nothing of the rules needs one. */
function setup(tasks: Task[], fields: ApprovalFields = { approved: true }, modes: readonly RunnerModeInfo[] | 'undeclared' = MODES) {
  const plan: ApprovalFields = fields;
  const store = new PlanStore();
  const withdrawn: string[][] = [];
  const record = new ApprovalRecord({
    plan: () => plan,
    store,
    runnerModes: () => (modes === 'undeclared' ? undefined : modes),
    onWithdrawn: (ids) => withdrawn.push([...ids]),
  });
  store.onTree = (ids) => record.reconcile(ids);
  store.load(tasks, ['claude-code']);
  return { record, store, plan, withdrawn };
}

/** `ids` as a list that counts how many entries were read out of it. */
function countingList(ids: string[]): { list: string[]; reads: () => number } {
  let reads = 0;
  const list = new Proxy(ids, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads: () => reads };
}

describe('ApprovalRecord', () => {
  describe('reading the record across a plan', () => {
    const SIZE = 200;
    const ids = Array.from({ length: SIZE }, (_, i) => `t${i}`);

    it('walks the list once however many tasks ask', () => {
      const { list, reads } = countingList([...ids]);
      const { record } = setup(ids.map((id) => task(id)), { approved: true, approvedTasks: list });
      const loaded = reads();
      for (const id of ids) {
        expect(record.isApproved(id)).toBe(true);
        expect(record.waitsForApproval(id)).toBe(false);
      }
      expect(reads() - loaded).toBeLessThanOrEqual(SIZE);
    });

    it('walks it once for tasks outside it too', () => {
      const { list, reads } = countingList(ids.slice(0, 1));
      const { record } = setup(ids.map((id) => task(id)), { approved: true, approvedTasks: list });
      const loaded = reads();
      for (const id of ids.slice(1)) expect(record.waitsForApproval(id)).toBe(true);
      expect(reads() - loaded).toBeLessThanOrEqual(1);
    });

    it('answers from the record as it stands after each change', () => {
      const { record, plan, store } = setup([task('a'), task('b')], { approved: true, approvedTasks: ['a'] });
      expect(record.waitsForApproval('b')).toBe(true);
      record.approve(['b']);
      expect(record.isApproved('b')).toBe(true);
      expect(record.waitsForApproval('b')).toBe(false);
      record.withdraw(['a']);
      expect(record.isApproved('a')).toBe(false);
      store.remove('b');
      expect(plan.approvedTasks).toEqual([]);
      expect(record.isApproved('b')).toBe(false);
    });

    it('reads the plan the session holds now, not the one it read last', () => {
      const plans: ApprovalFields[] = [{ approved: true, approvedTasks: ['a'] }, { approved: true, approvedTasks: [] }];
      const store = new PlanStore();
      store.load([task('a')], ['claude-code']);
      const record = new ApprovalRecord({ plan: () => plans[0], store, runnerModes: () => MODES });
      expect(record.isApproved('a')).toBe(true);
      plans.shift();
      expect(record.isApproved('a')).toBe(false);
    });
  });

  describe('approve and isApproved', () => {
    it('approves tasks the plan holds, once each', () => {
      const { record, plan } = setup([task('a'), task('b')]);
      record.approve(['a']);
      record.approve(['a', 'b']);
      expect(plan.approvedTasks).toEqual(['a', 'b']);
      expect(record.isApproved('a')).toBe(true);
    });

    it('ignores an id the plan does not hold, so a task that later takes the id is not approved', () => {
      const { record, store, plan } = setup([task('a')]);
      record.approve(['ghost']);
      expect(plan.approvedTasks).toBeUndefined();
      store.add({ id: 'ghost', title: 'later', prompt: 'p', assignedRunner: 'claude-code' });
      expect(record.isApproved('ghost')).toBe(false);
    });

    it('reads a task as unapproved once it has left the plan, even before the lists are pruned', () => {
      const { record, store } = setup([task('a')], { approved: true, approvedTasks: ['a'] });
      expect(record.isApproved('a')).toBe(true);
      store.remove('a');
      expect(record.isApproved('a')).toBe(false);
    });

    it('holds nothing without a plan', () => {
      const record = new ApprovalRecord({ plan: () => null, store: new PlanStore(), runnerModes: () => MODES });
      record.approve(['a']);
      record.withdraw(['a']);
      record.reconcile(new Set());
      expect(record.isApproved('a')).toBe(false);
      expect(record.planApproved).toBe(false);
    });
  });

  describe('the plan\'s own approval', () => {
    it('is set apart from any task\'s', () => {
      const { record, plan } = setup([task('a')], {});
      expect(record.planApproved).toBe(false);
      record.approvePlan();
      expect(plan.approved).toBe(true);
      expect(record.planApproved).toBe(true);
      expect(record.isApproved('a')).toBe(false);
    });

    it('decides which tasks wait: only a pending one outside the record, in an approved plan', () => {
      const { record, plan, store } = setup([task('a'), task('b'), task('c', { type: 'user' })], { approved: true, approvedTasks: ['a'] });
      expect(record.waitsForApproval('a')).toBe(false);
      expect(record.waitsForApproval('b')).toBe(true);
      expect(record.waitsForApproval('c')).toBe(false);
      expect(record.waitsForApproval('missing')).toBe(false);
      plan.approved = false;
      expect(record.waitsForApproval('b')).toBe(false);
      plan.approved = true;
      store.markInProgress('b');
      expect(record.waitsForApproval('b')).toBe(false);
    });
  });

  describe('withdraw', () => {
    it('takes approval from the named tasks and says which lost it', () => {
      const { record, plan, withdrawn } = setup([task('a'), task('b')], { approved: true, approvedTasks: ['a', 'b'] });
      record.withdraw(['a', 'not-approved']);
      expect(plan.approvedTasks).toEqual(['b']);
      expect(withdrawn).toEqual([['a']]);
    });

    it('says nothing when none of them was approved', () => {
      const { record, withdrawn } = setup([task('a')], { approved: true, approvedTasks: [] });
      record.withdraw(['a']);
      expect(withdrawn).toEqual([]);
    });
  });

  describe('a task leaving the plan', () => {
    it('takes its approval with it on every route the tree changes by', () => {
      const { record, store, plan, withdrawn } = setup([task('a'), task('b'), task('c')], { approved: true, approvedTasks: ['a', 'b', 'c'] });
      store.remove('a');
      expect(plan.approvedTasks).toEqual(['b', 'c']);
      store.load([task('b')], ['claude-code']);
      expect(plan.approvedTasks).toEqual(['b']);
      expect(withdrawn).toEqual([['a'], ['c']]);
      expect(record.isApproved('b')).toBe(true);
    });

    it('leaves a task that stays in the plan approved through edits', () => {
      const { store, plan, withdrawn } = setup([task('a')], { approved: true, approvedTasks: ['a'] });
      store.update('a', { title: 'renamed' });
      expect(plan.approvedTasks).toEqual(['a']);
      expect(withdrawn).toEqual([]);
    });
  });

  describe('research', () => {
    it('is approved as it lands, and remembered as the planner\'s approval', () => {
      const { record, plan } = setup([scout('r')]);
      record.approveResearch('r');
      expect(record.isApproved('r')).toBe(true);
      expect(record.researchApproved('r')).toBe(true);
      expect(plan.researchApprovals).toEqual(['r']);
      record.approveResearch('r');
      expect(plan.researchApprovals).toEqual(['r']);
    });

    it('is not approved when the plan does not hold it', () => {
      const { record, plan } = setup([scout('r')]);
      record.approveResearch('ghost');
      expect(plan.researchApprovals).toBeUndefined();
    });

    it('keeps its approval while it stays research in its read-only profile', () => {
      const { record, store, plan, withdrawn } = setup([scout('r')]);
      record.approveResearch('r');
      store.update('r', { title: 'Why is it slow?' });
      expect(plan.approvedTasks).toEqual(['r']);
      expect(withdrawn).toEqual([]);
    });

    it.each([
      ['it stops being research', { research: false }],
      ['it leaves its read-only profile', { taskMode: 'build' }],
      ['it becomes a script', { type: 'script' as const }],
    ])('loses its approval when %s, and the report channel the planner gave it', (_name, change) => {
      const { record, store, plan, withdrawn } = setup([scout('r', { reportTo: { research: true, actor: 'planner-turn' }, researchOrigin: { research: true, actor: 'planner-turn' } })]);
      record.approveResearch('r');
      store.update('r', change);
      expect(plan.approvedTasks).toEqual([]);
      expect(plan.researchApprovals).toEqual([]);
      expect(record.isApproved('r')).toBe(false);
      expect(store.get('r')?.reportTo).toBeUndefined();
      expect(store.get('r')?.researchOrigin).toBeUndefined();
      expect(withdrawn).toContainEqual(['r']);
    });

    it('is told once, though clearing the report channel rebuilds the tree again', () => {
      const { record, store, withdrawn } = setup([scout('r', { researchOrigin: { research: true, actor: 'planner-turn' } })]);
      record.approveResearch('r');
      store.update('r', { research: false });
      expect(withdrawn).toEqual([['r']]);
    });

    it('loses its approval when the task is removed', () => {
      const { record, store, plan } = setup([scout('r'), task('a')], { approved: true, approvedTasks: ['a'] });
      record.approveResearch('r');
      store.remove('r');
      expect(plan.researchApprovals).toEqual([]);
      expect(plan.approvedTasks).toEqual(['a']);
    });

    it('does not take the user\'s own approval of a task that was never research-approved', () => {
      const { store, plan } = setup([task('a')], { approved: true, approvedTasks: ['a'] });
      store.update('a', { research: false });
      expect(plan.approvedTasks).toEqual(['a']);
    });

    it('reads a runner with no declared modes as read-only enough, as the save did', () => {
      const { record, store, plan } = setup([scout('r')], { approved: true }, 'undeclared');
      record.approveResearch('r');
      store.update('r', { taskMode: 'build' });
      expect(plan.researchApprovals).toEqual(['r']);
    });

    it('asks a runner\'s modes only while a research task is approved', () => {
      const runnerModes = vi.fn(() => MODES);
      const plan: ApprovalFields = { approved: true };
      const store = new PlanStore();
      const record = new ApprovalRecord({ plan: () => plan, store, runnerModes });
      store.onTree = (ids) => record.reconcile(ids);
      store.load([task('a')], ['claude-code']);
      store.update('a', { title: 'again' });
      expect(runnerModes).not.toHaveBeenCalled();
    });
  });
});
