import { describe, it, expect } from 'vitest';
import { pathsMeet, protectedPathFault, underProtectedPath } from '../../models/Delegation';
import { validatePlanTasks } from '../PlanValidator';

/**
 * A protected path is the one check of a delegated task's work that no model
 * reads (ADR-0055 D7), so a rule that validates and then matches nothing is a
 * hole, and a matcher that errs must err by refusing the work.
 */

const NOT_A_TEST = 'src/index.ts';

describe('what a protected path covers', () => {
  it.each<[rule: string, file: string]>([
    ['tests', 'tests/a.ts'],
    ['tests/', 'tests/a.ts'],
    ['tests//', 'tests/deep/a.ts'],
    ['./tests/', 'tests/a.ts'],
    ['././tests', 'tests/a.ts'],
    ['.//tests', 'tests/a.ts'],
    ['tests/./unit', 'tests/unit/a.ts'],
    ['tests//unit', 'tests/unit/a.ts'],
    ['tests\\unit\\', 'tests/unit/a.ts'],
    ['  tests/  ', 'tests/a.ts'],
    ['package.json', 'package.json'],
    ['pages/[id].tsx', 'pages/[id].tsx'],
  ])('%j holds a path it names: %s', (rule, file) => {
    expect(underProtectedPath(file, rule)).toBe(true);
  });

  it.each<[rule: string, file: string]>([
    ['tests/**', 'tests/a.ts'],
    ['tests/**', 'tests/deep/er/a.ts'],
    ['tests/**', 'tests'],
    ['tests/**/*', 'tests/a.ts'],
    ['tests/**/*', 'tests/deep/er/a.ts'],
    ['tests/*', 'tests/a.ts'],
    ['tests/*', 'tests/deep/a.ts'],
    ['**/*.test.ts', 'a.test.ts'],
    ['**/*.test.ts', 'src/deep/a.test.ts'],
    ['**/fixtures/**', 'fixtures/a.json'],
    ['**/fixtures/**', 'src/fixtures/deep/a.json'],
    ['src/**.test.ts', 'src/deep/a.test.ts'],
    ['*.test.ts', 'a.test.ts'],
    ['*.test.ts', 'src/deep/a.test.ts'],
  ])('the pattern %j holds %s', (rule, file) => {
    expect(underProtectedPath(file, rule)).toBe(true);
  });

  it.each<[rule: string, file: string]>([
    ['tests/', 'testsuite/a.ts'],
    ['tests', 'src/tests/a.ts'],
    ['package.json', 'packages/x/package.json'],
    ['tests/**', 'tests2/a.ts'],
    ['**/*.test.ts', 'src/a.test.tsx'],
    ['src/*.ts', 'lib/a.ts'],
    ['a.b', 'axb'],
    ['a.*', 'axb.ts'],
  ])('%j leaves %s alone', (rule, file) => {
    expect(underProtectedPath(file, rule)).toBe(false);
  });

  it('reads a `?` or a dot in a pattern as itself, never as a regular expression', () => {
    expect(underProtectedPath('tes.ts', 'test?*')).toBe(false);
    expect(underProtectedPath('testXts', 'test.t*')).toBe(false);
  });

  // On a case-insensitive checkout `Tests/a.ts` is the file `tests/a.ts`, and git prints whichever name the branch wrote.
  it.each<[rule: string, file: string]>([
    ['tests/', 'Tests/a.ts'],
    ['tests/', 'TESTS/a.ts'],
    ['Tests/', 'tests/a.ts'],
    ['package.json', 'Package.JSON'],
    ['**/*.test.ts', 'src/A.TEST.TS'],
    ['tests/**', 'TESTS/deep/a.ts'],
  ])('%j holds %s whatever its case', (rule, file) => {
    expect(underProtectedPath(file, rule)).toBe(true);
  });

  it('holds the same name however its characters are composed or folded', () => {
    expect(underProtectedPath('caf\u0065\u0301/a.ts', 'caf\u00e9/')).toBe(true);
    expect(underProtectedPath('caf\u00e9/a.ts', 'caf\u0065\u0301/')).toBe(true);
    expect(underProtectedPath('STRASSE/a.ts', 'stra\u00dfe/')).toBe(true);
  });

  it('holds a path the way a branch that wrote it oddly lists it', () => {
    expect(underProtectedPath('./tests/a.ts', 'tests/')).toBe(true);
    expect(underProtectedPath('tests\\a.ts', 'tests/')).toBe(true);
  });

  it('fails closed on a saved rule for the whole repository, and a blank one protects nothing', () => {
    for (const rule of ['.', './', '**', '*', '**/*']) expect(underProtectedPath(NOT_A_TEST, rule)).toBe(true);
    expect(underProtectedPath(NOT_A_TEST, '   ')).toBe(false);
  });
});

describe('a protected path a plan may hold', () => {
  it.each(['tests/', 'tests', './tests/', 'package.json', 'tests/**', '**/*.test.ts', '*.test.ts', 'pages/[id].tsx', 'src/a b.ts'])('takes %j', (rule) => {
    expect(protectedPathFault(rule)).toBeNull();
  });

  it.each<[rule: string, why: RegExp]>([
    ['.', /whole repository/],
    ['./', /whole repository/],
    ['.//', /whole repository/],
    ['*', /whole repository/],
    ['**', /whole repository/],
    ['**/', /whole repository/],
    ['**/*', /whole repository/],
    ['*/**', /whole repository/],
    ['/', /relative to the repository/],
    ['/tests', /relative to the repository/],
    ['\\tests', /relative to the repository/],
    ['C:\\repo\\tests', /relative to the repository/],
    ['C:/repo/tests', /relative to the repository/],
    ['../tests', /outside the repository/],
    ['tests/../../x', /outside the repository/],
    ['tests/..', /outside the repository/],
    ['..\\x', /outside the repository/],
    ['!tests/', /only `\*` is a wildcard/],
    ['tests/?.ts', /only `\*` is a wildcard/],
    ['src/**/*.{ts,tsx}', /only `\*` is a wildcard/],
    ['src/*.[ch]', /only `\*` is a wildcard/],
  ])('refuses %j', (rule, why) => {
    expect(protectedPathFault(rule)).toMatch(why);
  });

  const delegated = (protectedPaths: unknown, over: Record<string, unknown> = {}) => ({
    id: 'd', order: 1, title: 'Task d', description: 'd', type: 'delegated', goal: 'reach d', sliceType: 'AFK', dependencies: [], budget: { tokens: 500_000 }, protectedPaths, ...over,
  });
  const check = { id: 'c', order: 2, title: 'Task c', description: 'c', type: 'ai', prompt: 'read it', sliceType: 'AFK', autonomy: 'AFK', dependencies: ['d'], readOnly: true };
  const modes = { 'claude-code': [{ id: 'plan', label: 'Plan', description: '', readOnly: true }, { id: 'build', label: 'Build', description: '' }] };
  const submitted = (task: Record<string, unknown>) => validatePlanTasks({ tasks: [task, check] }, ['claude-code'], modes, false, { delegationRefusal: null });

  it('refuses a plan on any route that names one of them, each named once', () => {
    const result = submitted(delegated(['tests/', './', '../x']));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.field, e.message])).toEqual([
      ['protectedPaths', 'Task "Task d" protects "./", which covers the whole repository, so its child could land nothing: name what it may not change, or make the task "readOnly"'],
      ['protectedPaths', 'Task "Task d" protects "../x", which is outside the repository: name a path inside it'],
    ]);
  });

  it('asks nothing of the paths of a task that lands nothing', () => {
    expect(submitted(delegated(['./'], { readOnly: true })).ok).toBe(true);
  });
});

describe('two declared paths that meet', () => {
  it('reads both as the matcher does', () => {
    expect(pathsMeet('./src/', 'src/api')).toBe(true);
    expect(pathsMeet('SRC/', 'src/api/')).toBe(true);
    expect(pathsMeet('src/**', 'src/*.ts')).toBe(true);
    expect(pathsMeet('Src/*', './src/**')).toBe(true);
    expect(pathsMeet('src/', 'lib/')).toBe(false);
  });
});
