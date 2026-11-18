import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { ApprovalDecision, ApprovalRequest, IApproval } from '../../interfaces/IApproval';
import { piExtensionSource, piReadAsk, PI_READ_ASK, type PiExtensionConfig } from '../harness/piExtension';
import { decidePlannerPermission, decideReadOnlyTaskPermission } from '../harness/plannerPermissions';

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type Blocked = { block: true; reason: string } | undefined;
type Handler = (event: ToolCall, ctx: { cwd: string; ui: { input(title: string, placeholder: string): Promise<string | undefined> } }) => Promise<Blocked>;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const server = { name: 'ordewell' as const, url: 'http://127.0.0.1:4555/mcp', headers: { Authorization: 'Bearer tok-secret' } };

/** The extension as Pi loads it: the module Ordewell writes, imported and handed a fake of Pi's extension API. */
async function loaded(config: PiExtensionConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-pi-ext-'));
  dirs.push(dir);
  const file = join(dir, 'ordewell.mjs');
  writeFileSync(file, piExtensionSource(config));
  const extension = (await import(pathToFileURL(file).href) as { default: (pi: unknown) => void }).default;
  const registered: Array<[string, unknown]> = [];
  const handlers: Handler[] = [];
  extension({
    registerMcpServer: (name: string, entry: unknown) => registered.push([name, entry]),
    on: (event: string, handler: Handler) => { if (event === 'tool_call') handlers.push(handler); },
  });
  return { registered, handlers };
}

/** A worktree and a workspace side by side, a file outside both, and links out of the worktree. */
function site() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-pi-roots-')));
  dirs.push(dir);
  const cwd = join(dir, 'task');
  const workspaceRoot = join(dir, 'workspace');
  for (const root of [cwd, workspaceRoot]) { mkdirSync(root); writeFileSync(join(root, 'inside.txt'), 'ok'); }
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'secret');
  symlinkSync(join(dir, 'outside', 'secret.txt'), join(cwd, 'link.txt'));
  symlinkSync(join(dir, 'outside'), join(cwd, 'linkdir'), 'dir');
  symlinkSync(join(workspaceRoot, 'inside.txt'), join(cwd, 'workspace-link.txt'));
  return { dir, cwd, workspaceRoot };
}

/** One call through the extension's handler, answered by `decide` as the adapter answers Pi's dialog. */
async function call(handler: Handler, cwd: string, toolName: string, path: string | undefined, decide: (ask: { path: string; directory: boolean }) => Promise<ApprovalDecision> | ApprovalDecision) {
  const asked: Array<{ toolCallId: string; tool: string; path: string; directory: boolean }> = [];
  const event: ToolCall = { toolName, toolCallId: 'call-1', input: path === undefined ? {} : { path } };
  const blocked = await handler(event, {
    cwd,
    ui: {
      input: async (title, placeholder) => {
        expect(title).toBe(PI_READ_ASK);
        const ask = piReadAsk({ title, placeholder })!;
        asked.push(ask);
        return JSON.stringify(await decide(ask));
      },
    },
  });
  return { blocked, asked, path: event.input.path };
}

describe('the extension Ordewell loads into Pi', () => {
  it('registers Ordewell\'s server with its tools named directly, and leaves a writable task\'s reads alone', async () => {
    const { registered, handlers } = await loaded({ server, asksReads: false });

    expect(registered).toEqual([['ordewell', { url: server.url, headers: server.headers, exposure: 'direct' }]]);
    expect(handlers).toEqual([]);
  });

  describe('on a read-only task, deciding by decideReadOnlyTaskPermission (ADR-0046)', () => {
    async function readOnly() {
      const roots = site();
      const [handler] = (await loaded({ server, asksReads: true })).handlers;
      const run = (tool: string, path?: string) => call(handler, roots.cwd, tool, path, (ask) => decideReadOnlyTaskPermission({ kind: 'path', ...ask }, roots));
      return { ...roots, run };
    }

    it('reads inside the task worktree and the workspace, each by its real path', async () => {
      const { cwd, workspaceRoot, run } = await readOnly();

      for (const [tool, path, real] of [
        ['read', 'inside.txt', join(cwd, 'inside.txt')],
        ['read', '@inside.txt', join(cwd, 'inside.txt')],
        ['read', join(workspaceRoot, 'inside.txt'), join(workspaceRoot, 'inside.txt')],
        ['read', '../workspace/inside.txt', join(workspaceRoot, 'inside.txt')],
        ['read', 'workspace-link.txt', join(workspaceRoot, 'inside.txt')],
        ['ls', undefined, cwd],
        ['grep', workspaceRoot, workspaceRoot],
        ['find', '.', cwd],
      ] as const) {
        const { blocked, asked, path: given } = await run(tool, path);
        expect(blocked, `${tool} ${path}`).toBeUndefined();
        expect(asked).toEqual([{ toolCallId: 'call-1', tool, path: real, directory: tool !== 'read' }]);
        expect(given).toBe(real);
      }
    });

    it('refuses an absolute path, a .. and links that leave both roots, saying why', async () => {
      const { dir, run } = await readOnly();

      for (const [tool, path] of [
        ['read', join(dir, 'outside', 'secret.txt')],
        ['read', '../outside/secret.txt'],
        ['read', 'link.txt'],
        ['read', 'linkdir/secret.txt'],
        ['ls', '..'],
        ['ls', 'linkdir'],
        ['grep', join(dir, 'outside')],
        ['find', '../outside'],
      ] as const) {
        const { blocked, asked, path: given } = await run(tool, path);
        expect(blocked, `${tool} ${path}`).toEqual({ block: true, reason: 'This read is outside the task worktree and workspace. Nobody can approve it here.' });
        expect(asked).toHaveLength(1);
        expect(given).toBe(path);
      }
    });

    it('resolves ~ to the home directory, as Pi does, and refuses it outside both roots', async () => {
      const { run } = await readOnly();
      writeFileSync(join(homedir(), 'home.txt'), 'mine');

      const { blocked, asked } = await run('read', '~/home.txt');
      expect(asked[0].path).toBe(realpathSync.native(join(homedir(), 'home.txt')));
      expect(blocked).toMatchObject({ block: true });
    });

    it('refuses a path that is not on disk without asking, since Pi would read a near match', async () => {
      const { run } = await readOnly();

      const { blocked, asked } = await run('read', 'missing.txt');
      expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining('not on disk') });
      expect(asked).toEqual([]);
    });

    it('refuses a link whose real path Pi would read with its spaces changed', async () => {
      const { cwd, run } = await readOnly();
      mkdirSync(join(cwd, 'no break'));
      writeFileSync(join(cwd, 'no break', 'inside.txt'), 'ok');
      symlinkSync(join(cwd, 'no break', 'inside.txt'), join(cwd, 'spaced.txt'));

      const { blocked, asked } = await run('read', 'spaced.txt');
      expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining('spaces changed') });
      expect(asked).toEqual([]);
    });

    it('leaves Pi\'s other tools and Ordewell\'s to their own rules', async () => {
      const { run } = await readOnly();

      for (const tool of ['mcp__ordewell__run_command', 'bash', 'write']) {
        const { blocked, asked } = await run(tool, '/etc');
        expect(blocked).toBeUndefined();
        expect(asked).toEqual([]);
      }
    });
  });

  it('blocks a read nobody answered, or answered with anything but an allow', async () => {
    const { cwd } = site();
    const [handler] = (await loaded({ server, asksReads: true })).handlers;

    for (const answer of [undefined, 'not json', '{"decision":"deny"}', '{"decision":"maybe"}']) {
      const blocked = await handler({ toolName: 'read', toolCallId: 'c', input: { path: 'inside.txt' } }, { cwd, ui: { input: async () => answer } });
      expect(blocked).toEqual({ block: true, reason: 'Ordewell did not allow this read.' });
    }
  });

  it('puts a planner\'s read outside the workspace to the external_path policy, which may allow it (ADR-0026)', async () => {
    const { dir, cwd } = site();
    const [handler] = (await loaded({ server, asksReads: true })).handlers;
    const requests: ApprovalRequest[] = [];
    const approval = (granted: boolean): IApproval => ({ request: async (request: ApprovalRequest) => { requests.push(request); return granted; } }) as unknown as IApproval;
    const planner = (granted: boolean) => (ask: { path: string; directory: boolean }) => decidePlannerPermission({ kind: 'path', ...ask }, {}, { workspaceRoot: cwd, approval: approval(granted) });

    expect((await call(handler, cwd, 'read', 'inside.txt', planner(false))).blocked).toBeUndefined();
    expect(requests).toEqual([]);

    const allowed = await call(handler, cwd, 'read', 'link.txt', planner(true));
    expect(allowed.blocked).toBeUndefined();
    expect(allowed.path).toBe(join(dir, 'outside', 'secret.txt'));
    expect(requests).toMatchObject([{ kind: 'external_path', subject: join(dir, 'outside', 'secret.txt') }]);

    const refused = await call(handler, cwd, 'ls', '../outside', planner(false));
    expect(refused.blocked).toEqual({ block: true, reason: `Access denied: "${join(dir, 'outside')}" is outside the workspace and was not approved.` });
  });

  it('reads the ask back from Pi\'s dialog only when it is the extension\'s own', () => {
    expect(piReadAsk({ title: 'Allow?', placeholder: '{}' })).toBeNull();
    expect(piReadAsk({ title: PI_READ_ASK, placeholder: 'x' })).toBeNull();
    expect(piReadAsk({ title: PI_READ_ASK, placeholder: '{"tool":"read"}' })).toBeNull();
    expect(piReadAsk({ title: PI_READ_ASK, placeholder: '{"toolCallId":"c","tool":"ls","path":"/a","directory":true}' })).toEqual({ toolCallId: 'c', tool: 'ls', path: '/a', directory: true });
  });
});
