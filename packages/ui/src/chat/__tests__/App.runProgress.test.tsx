import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { createTask } from '@ordewell/core';
import App from '../../test/ChatApp';
import { post } from './webview';

const t1 = createTask({ id: 't1', order: 1, title: 'Parse the config', status: 'pending' });
const t2 = createTask({ id: 't2', order: 2, title: 'Wire the CLI', status: 'pending' });

const run = (...tasks: Array<typeof t1>) => ({ tasks, runMerge: null, handoff: null, mergeResult: null });

// A host posts the whole plan when the plan changed and not on a status tick, so
// the dock's progress has to follow the run view, which every tick reaches.
describe('the plan dock\'s progress', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'planUpdated', plan: { tasks: [t1, t2], generatedAt: '', lastUpdated: '', status: 'running', runners: [] } });
  });

  it('follows the run view when no plan arrives after a status tick', () => {
    expect(document.querySelector('.plan-dock-summary')!.textContent).toBe('2 tasks');

    act(() => post({ type: 'runView', view: run({ ...t1, status: 'completed' }, { ...t2, status: 'in_progress' }) }));

    expect(document.querySelector('.plan-dock-summary')!.textContent).toBe('2 tasks · 1 done · 1 running');
    expect(document.body).toHaveTextContent('1/2 done');
    expect(document.body).toHaveTextContent('1 running');
  });
});
