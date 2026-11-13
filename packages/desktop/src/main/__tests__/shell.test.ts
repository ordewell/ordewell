import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorInvocation, resolveTarget, Shell, type ShellActions } from '../shell';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ow-shell-'));
  outside = mkdtempSync(join(tmpdir(), 'ow-outside-'));
  mkdirSync(join(root, 'api', 'src'), { recursive: true });
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.ordewell', 'skills'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'hi');
  writeFileSync(join(root, 'api', 'src', 'a.ts'), 'a');
  writeFileSync(join(root, '.git', 'config'), '');
  writeFileSync(join(root, '.ordewell', 'state.json'), '{}');
  writeFileSync(join(root, '.ordewell', 'skills', 's.md'), 's');
  writeFileSync(join(outside, 'secret'), 'x');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function actions(): ShellActions & { openPath: ReturnType<typeof vi.fn>; showItemInFolder: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn> } {
  return { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(), launch: vi.fn(async () => undefined) };
}

describe('resolveTarget', () => {
  it('resolves a repo-relative path inside the workspace', () => {
    const resolved = resolveTarget(root, { repo: 'api', path: 'src/a.ts' });
    expect(resolved.ok && resolved.path.endsWith(join('api', 'src', 'a.ts'))).toBe(true);
    expect(resolveTarget(root, { repo: '.', path: 'README.md' }).ok).toBe(true);
    expect(resolveTarget(root, { repo: 'api' }).ok).toBe(true);
  });

  it('refuses a path that is absolute, climbs out, or is not a string', () => {
    for (const target of [
      { repo: '.', path: '/etc/passwd' },
      { repo: '.', path: '../x' },
      { repo: '..', path: 'x' },
      { repo: '.', path: 'a/../../x' },
      { repo: 'C:\\Windows', path: 'x' },
      { repo: '.', path: 'a\0b' },
      { repo: '', path: 'x' },
      { repo: 3, path: 'x' },
      { repo: '.', path: 4 },
      null,
      'README.md',
    ]) expect(resolveTarget(root, target).ok, JSON.stringify(target)).toBe(false);
  });

  it('refuses git and the daemon state but allows the skills (ADR-0024)', () => {
    expect(resolveTarget(root, { repo: '.', path: '.git/config' }).ok).toBe(false);
    expect(resolveTarget(root, { repo: '.', path: '.ordewell/state.json' }).ok).toBe(false);
    expect(resolveTarget(root, { repo: '.', path: '.ordewell/skills/s.md' }).ok).toBe(true);
  });

  it('refuses a link that leaves the workspace, and a file that is gone', () => {
    symlinkSync(outside, join(root, 'escape'));
    expect(resolveTarget(root, { repo: '.', path: 'escape/secret' }).ok).toBe(false);
    expect(resolveTarget(root, { repo: '.', path: 'nope.txt' })).toEqual({ ok: false, message: 'That file is gone from the checkout.' });
  });
});

describe('editorInvocation', () => {
  it('appends the file when the command has no placeholder', () => {
    expect(editorInvocation('code -r', '/w/a.ts', 3)).toEqual({ program: 'code', args: ['-r', '/w/a.ts'] });
  });

  it('fills {file} and {line}, and keeps a quoted run whole', () => {
    expect(editorInvocation('code --goto "{file}:{line}"', '/w/my dir/a.ts', 12)).toEqual({ program: 'code', args: ['--goto', '/w/my dir/a.ts:12'] });
    expect(editorInvocation('subl {file}:{line}', '/w/a.ts', undefined)).toEqual({ program: 'subl', args: ['/w/a.ts:1'] });
  });

  it('has nothing to run for an empty command', () => {
    expect(editorInvocation('   ', '/w/a.ts', 1)).toBeUndefined();
  });
});

describe('Shell', () => {
  it('opens with the OS default on Linux when no editor is configured', async () => {
    const a = actions();
    const result = await new Shell(a, () => '', 'linux').openInEditor(root, { repo: '.', path: 'README.md' });
    expect(result).toEqual({ ok: true });
    expect(a.openPath).toHaveBeenCalledOnce();
    expect(a.launch).not.toHaveBeenCalled();
  });

  it('never hands a file to the OS default action on Windows or macOS, which would run a script', async () => {
    writeFileSync(join(root, 'setup.bat'), 'calc');
    const win = actions();
    expect(await new Shell(win, () => '', 'win32').openInEditor(root, { repo: '.', path: 'setup.bat' })).toEqual({ ok: true });
    expect(win.openPath).not.toHaveBeenCalled();
    expect(win.launch).toHaveBeenCalledWith('notepad.exe', [expect.stringMatching(/setup\.bat$/)]);
    const mac = actions();
    await new Shell(mac, () => '', 'darwin').openInEditor(root, { repo: '.', path: 'setup.bat' });
    expect(mac.openPath).not.toHaveBeenCalled();
    expect(mac.launch).toHaveBeenCalledWith('open', ['-t', expect.stringMatching(/setup\.bat$/)]);
  });

  it('runs the configured editor without a shell', async () => {
    const a = actions();
    await new Shell(a, () => 'code --goto {file}:{line}').openInEditor(root, { repo: 'api', path: 'src/a.ts', line: 7 });
    expect(a.launch).toHaveBeenCalledWith('code', ['--goto', expect.stringMatching(/a\.ts:7$/)]);
  });

  it('says so when the editor cannot start or the OS refuses', async () => {
    const a = actions();
    a.launch.mockRejectedValue(new Error('ENOENT'));
    const failed = await new Shell(a, () => 'nosuch').openInEditor(root, { repo: '.', path: 'README.md' });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('nosuch');
    const b = actions();
    b.openPath.mockResolvedValue('No application is associated');
    expect(await new Shell(b, () => '', 'linux').openInEditor(root, { repo: '.', path: 'README.md' })).toEqual({ ok: false, message: 'No application is associated' });
  });

  it('reveals only what it resolves', () => {
    const a = actions();
    const shell = new Shell(a, () => '');
    expect(shell.reveal(root, { repo: '.', path: '../x' }).ok).toBe(false);
    expect(a.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.reveal(root, { repo: 'api' })).toEqual({ ok: true });
    expect(a.showItemInFolder).toHaveBeenCalledOnce();
  });
});
