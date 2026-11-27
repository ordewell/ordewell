import { expect, it } from 'vitest';
import { render } from '../render';
import { stripAnsi, style } from '../ansi';
import { initialState, type RunnerView } from '../state';
import { reduce } from '../reducer';

it('shows the same missing Cline provider key and recovery on welcome and in the runners picker', () => {
  style.enabled = false;
  const signIn = { runner: 'cline', label: 'Cline', login: ['cline', 'auth'], needsKey: true as const };
  const cline: RunnerView = {
    id: 'cline', name: 'Cline', enabled: true,
    auth: { state: 'signed-out', loginCommand: ['cline', 'auth'], detail: 'no provider key', signIn },
    readiness: { kind: 'blocked', why: 'no-credential', signIn },
  };
  const base = initialState({ rows: 40, cols: 160, workspace: '/w', plannerKnown: true, runnersKnown: true, providersKnown: true, plannerProvider: 'cline', runners: [cline] });
  const welcome = render(base).map(stripAnsi);
  const runners = welcome.find((line) => line.trimStart().startsWith('Runners'));
  const text = '/runners';
  const opened = reduce({ ...base, editor: { ...base.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } }).state;
  if (opened.overlay?.kind !== 'picker') throw new Error('expected picker');
  expect(opened.overlay.picker.items.find((item) => item.id === 'cline')?.detail).toBe('API key needed · /login cline');
  expect(runners).toContain('Cline (API key needed · /login cline)');
  expect(welcome.join('\n')).toContain('Cline has no provider API key Ordewell can hand it.');
});
