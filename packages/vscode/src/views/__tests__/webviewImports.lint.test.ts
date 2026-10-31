import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface LintResult { messages: { ruleId: string | null }[] }
interface Linter { lintText(code: string, options: { filePath: string }): Promise<LintResult[]> }

// Required rather than imported: eslint ships no types here, and this reads one call of it.
const { ESLint } = createRequire(import.meta.url)('eslint') as { ESLint: new (options: { cwd: string }) => Linter };

const RULE = '@typescript-eslint/no-restricted-imports';
const REPO = resolve(__dirname, '../../../../..');

async function refused(code: string, path = 'packages/vscode/src/views/tasklog/TaskLogApp.tsx'): Promise<boolean> {
  const [result] = await new ESLint({ cwd: REPO }).lintText(code, { filePath: resolve(REPO, path) });
  return result.messages.some((message) => message.ruleId === RULE);
}

describe('what webview code may import from @ordewell/core', () => {
  it.each([
    ['a value', `import { taskActivity } from '@ordewell/core';\ntaskActivity;`],
    ['a value beside a type', `import { taskActivity, type Task } from '@ordewell/core';\nexport const use = (task: Task) => [task, taskActivity];`],
    ['a type written as a value, which only a compiler can tell apart', `import { Task } from '@ordewell/core';\nexport const use = (task: Task) => task;`],
    ['a whole namespace', `import * as core from '@ordewell/core';\ncore;`],
    ['a value passed on', `export { taskActivity } from '@ordewell/core';`],
  ])('refuses %s from the root', async (_what, code) => {
    expect(await refused(code)).toBe(true);
  });

  it.each([
    ['a type import', `import type { Task } from '@ordewell/core';\nexport const use = (task: Task) => task;`],
    ['an inline type import', `import { type Task } from '@ordewell/core';\nexport const use = (task: Task) => task;`],
    ['a value from the browser-safe entry', `import { taskActivity } from '@ordewell/core/plan-utils';\ntaskActivity;`],
  ])('allows %s', async (_what, code) => {
    expect(await refused(code)).toBe(false);
  });

  it('covers every webview, and leaves the tests and the extension host alone: neither reaches a browser', async () => {
    const value = `import { taskActivity } from '@ordewell/core';\ntaskActivity;`;

    expect(await refused(value, 'packages/vscode/src/views/chat/components/Deep.tsx')).toBe(true);
    expect(await refused(value, 'packages/vscode/src/views/chat/activity.ts')).toBe(true);
    expect(await refused(value, 'packages/vscode/src/views/chat/__tests__/Any.test.tsx')).toBe(false);
    expect(await refused(value, 'packages/vscode/src/extension.ts')).toBe(false);
  });
});
