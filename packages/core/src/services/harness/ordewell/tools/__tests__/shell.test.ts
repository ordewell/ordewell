import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { patient } from '../../../../../testEnv';
import { runTool } from '../run';
import { shellTool } from '../shell';
import { scratch } from './helpers';

const nodeCmd = (code: string) => `node -e "${code}"`;

describe('shell', () => {
  it('runs in the worktree and returns output and a zero exit code', async () => {
    const s = scratch();
    const result = await runTool(shellTool, { command: nodeCmd('console.log(process.cwd())') }, s.context);
    expect(result.isError).toBe(false);
    expect(realpathSync.native(result.text.split('\n')[0].trim())).toBe(realpathSync.native(s.worktree));
    expect(result.text).toContain('[exit code 0]');
    expect(result.details).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('reports a failing exit code as an error and keeps stderr', async () => {
    const s = scratch();
    const result = await runTool(shellTool, { command: nodeCmd('console.error(\\"boom\\"); process.exit(3)') }, s.context);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('boom');
    expect(result.text).toContain('[exit code 3]');
    expect(result.details).toMatchObject({ exitCode: 3 });
  });

  it('never gives the child a provider key from the parent environment', async () => {
    const s = scratch();
    const env = { ...process.env, OPENAI_API_KEY: 'sk-parent-openai', ANTHROPIC_API_KEY: 'sk-ant-parent', GITHUB_TOKEN: 'ghp_parent', RANDOM_UNLISTED: 'unlisted' };
    const code = 'console.log(JSON.stringify(Object.keys(process.env)), JSON.stringify(process.env))';
    const result = await runTool(shellTool, { command: nodeCmd(code) }, { ...s.context, env });
    expect(result.isError).toBe(false);
    for (const leaked of ['sk-parent-openai', 'sk-ant-parent', 'ghp_parent', 'unlisted', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
      expect(result.text).not.toContain(leaked);
    }
  });

  it('kills a command at its timeout', async () => {
    const s = scratch();
    const started = Date.now();
    const result = await runTool(shellTool, { command: nodeCmd('setTimeout(() => {}, 60000)'), timeout: 300 }, s.context);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('timed out');
    expect(result.details).toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(patient(20_000));
  });

  it('keeps the tail of long output and saves the full text', async () => {
    const s = scratch();
    const code = 'for (let i = 1; i <= 5000; i++) console.log(\\"row \\" + i)';
    const result = await runTool(shellTool, { command: nodeCmd(code) }, s.context);
    expect(result.text).toContain('row 5000');
    expect(result.text).toContain('[exit code 0]');
    expect(result.text).not.toContain('row 1\n');
    expect(result.details?.savedTo).toEqual(expect.stringContaining(s.outputDir));
  });

  it('stops a running command when the task is aborted', async () => {
    const s = scratch();
    const controller = new AbortController();
    const pending = runTool(shellTool, { command: nodeCmd('setTimeout(() => {}, 60000)') }, { ...s.context, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toBeDefined();
  });
});
