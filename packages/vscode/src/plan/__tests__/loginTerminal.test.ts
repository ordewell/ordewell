import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExecutableNotFoundError, runnerSignIn, type LaunchDeps } from '@ordewell/core';
import { buildLoginTerminal, resolveLoginLaunch, wrappedCommand, type LoginTerminalContext } from '../loginTerminal';

/** A folder holding the stand-ins these cases name, and nothing else. */
const FAKE_BIN = '/fake/bin';

const roots: string[] = [];
/** One temp root per case, so cleanup assertions can see every status dir it made. */
function tempRoot(): () => string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-login-tmp-'));
  roots.push(dir);
  return () => dir;
}

function context(overrides: Partial<LoginTerminalContext> = {}): LoginTerminalContext {
  return {
    runner: 'cursor-agent',
    label: 'Cursor',
    name: 'Cursor login',
    cwd: '/ws',
    env: { PATH: FAKE_BIN, CLAUDE_CONFIG_DIR: '/accounts/other', SECRET_TOKEN: 'do-not-log' },
    platform: 'linux',
    tempRoot: tempRoot(),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The one status dir a case created, or undefined when none was made. */
function statusDirOf(root: () => string): string | undefined {
  return fs.readdirSync(root()).filter((n) => n.startsWith('ordewell-login-')).map((n) => path.join(root(), n))[0];
}

describe('the supported agents', () => {
  // The five built-in runners whose manifest declares a login Ordewell runs.
  // (OpenCode, Gemini CLI, Qwen Code and Pi declare none and never open a
  // terminal; that path is unchanged.) This is a check of what the manifests
  // declare, not a claim that any real runner's login works end to end.
  const LOGIN_RUNNERS = ['claude-code', 'codex', 'copilot-cli', 'cursor-agent', 'cline'] as const;

  it.each(LOGIN_RUNNERS)('%s declares a login command that is safe to wrap on both platforms', (runner) => {
    const command = runnerSignIn(runner)?.login ?? [];
    expect(command.length).toBeGreaterThan(1);
    // Only plain flag words: no shell metacharacter the Windows batch could
    // re-parse, no quote, no credential on the command line.
    for (const arg of command) expect(arg).toMatch(/^[A-Za-z0-9._-]+$/);

    const launch = { shellPath: `/fake/bin/${command[0]}`, shellArgs: command.slice(1), PATH: '/fake/bin' };
    const posix = buildLoginTerminal(launch, context({ runner }));
    expect(wrappedCommand(posix.options)).toEqual([launch.shellPath, ...command.slice(1)]);
    // The workspace's credentials belong in env (the login sees them), never in
    // the wrapper script or the command line Ordewell composes.
    const script = (posix.options.shellArgs as string[])[1];
    expect(script).not.toMatch(/sk-|api.?key|secret|token|do-not-log/i);
    expect(posix.options.env.SECRET_TOKEN).toBe('do-not-log');
    posix.cleanup();

    const win = buildLoginTerminal(
      { shellPath: `C:\\bin\\${command[0]}.exe`, shellArgs: command.slice(1), PATH: 'C:\\bin' },
      context({ runner, platform: 'win32', comSpec: () => 'C:\\Windows\\System32\\cmd.exe' }),
    );
    const batch = fs.readdirSync(win.statusDir).filter((n) => n.endsWith('.cmd')).map((n) => fs.readFileSync(path.join(win.statusDir, n), 'utf8'))[0];
    expect(batch).toContain(command[0]);
    expect(batch).toContain(command.slice(1).join(' '));
    win.cleanup();
  });
});

describe('resolveLoginLaunch', () => {
  it('resolves the first runnable file on the probe PATH, by absolute path, on POSIX', async () => {
    const launch = await resolveLoginLaunch(['claude', 'auth', 'login'], 'linux', {
      resolvePath: async () => '/opt/homebrew/bin:/Users/me/.local/bin',
      exists: (file) => file === '/Users/me/.local/bin/claude',
    });
    expect(launch).toEqual({ shellPath: '/Users/me/.local/bin/claude', shellArgs: ['auth', 'login'], PATH: '/opt/homebrew/bin:/Users/me/.local/bin' });
  });

  it('refuses when the agent is not on that PATH', async () => {
    await expect(resolveLoginLaunch(['cursor-agent', 'login'], 'linux', { resolvePath: async () => '/nowhere', exists: () => false }))
      .rejects.toBeInstanceOf(ExecutableNotFoundError);
  });

  const WIN_BIN = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const CMD = 'C:\\Windows\\System32\\cmd.exe';
  const npmNodeShim = (target: string): string => [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
  ].join('\r\n');
  const windows = (files: Record<string, string>): Omit<LaunchDeps, 'platform'> => ({
    resolvePath: async () => WIN_BIN,
    exists: (file) => file in files,
    readShim: (file) => files[file],
    pathExt: () => '.COM;.EXE;.BAT;.CMD',
    comSpec: () => CMD,
  });

  it("starts an npm shim's own script with the node beside it, as a spawn does", async () => {
    const launch = await resolveLoginLaunch(['codex', 'login'], 'win32', windows({
      [`${WIN_BIN}\\codex.cmd`]: npmNodeShim('node_modules\\@openai\\codex\\bin\\codex.js'),
      [`${WIN_BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
      [`${WIN_BIN}\\node.exe`]: '',
    }));
    expect(launch.shellPath).toBe(`${WIN_BIN}\\node.exe`);
    expect(launch.shellArgs).toEqual([`${WIN_BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'login']);
  });

  it('routes a batch file of its own through cmd.exe, its line handed over as written', async () => {
    const launch = await resolveLoginLaunch(['cursor-agent', 'login'], 'win32', windows({
      [`${WIN_BIN}\\cursor-agent.cmd`]: '@echo off\r\npowershell -File "%~dp0cursor-agent.ps1" %*\r\n',
    }));
    expect(launch.shellPath).toBe(CMD);
    expect(launch.shellArgs).toBe(`/d /s /c "${WIN_BIN}\\cursor-agent.cmd login"`);
  });

  it('starts a native executable directly', async () => {
    const launch = await resolveLoginLaunch(['cursor-agent', 'login'], 'win32', windows({
      [`${WIN_BIN}\\cursor-agent.exe`]: '', [`${WIN_BIN}\\cursor-agent.cmd`]: '@echo off\r\n',
    }));
    expect(launch.shellPath).toBe(`${WIN_BIN}\\cursor-agent.exe`);
    expect(launch.shellArgs).toEqual(['login']);
  });

  it('routes a lone PowerShell shim through powershell.exe -File', async () => {
    const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const launch = await resolveLoginLaunch(['cursor-agent', 'login'], 'win32', {
      ...windows({ [`${WIN_BIN}\\cursor-agent.ps1`]: '' }),
      powerShell: () => powerShell,
    });
    expect(launch.shellPath).toBe(powerShell);
    expect(launch.shellArgs).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_BIN}\\cursor-agent.ps1`, 'login']);

    const terminal = buildLoginTerminal(launch, context({ platform: 'win32', comSpec: () => CMD }));
    const batch = fs.readdirSync(terminal.statusDir).filter((n) => n.endsWith('.cmd')).map((n) => fs.readFileSync(path.join(terminal.statusDir, n), 'utf8'))[0];
    expect(batch).toContain('-File');
    expect(batch).toContain('cursor-agent.ps1');
    terminal.cleanup();
  });
});

describe('buildLoginTerminal on POSIX', () => {
  it('runs the resolved command as a wrapper shell argv, keeping the failure output visible', () => {
    const launch = { shellPath: `${FAKE_BIN}/cursor-agent`, shellArgs: ['login'] as string[], PATH: FAKE_BIN };
    const ctx = context();
    const terminal = buildLoginTerminal(launch, ctx);

    expect(terminal.options.shellPath).toBe('/bin/sh');
    // The agent's file and args are positional parameters, never text in the script: a quote, a
    // semicolon or a secret in an argument is passed to the agent, not to a shell.
    expect(wrappedCommand(terminal.options)).toEqual([`${FAKE_BIN}/cursor-agent`, 'login']);
    expect((terminal.options.shellArgs as string[])[1]).not.toContain(`${FAKE_BIN}/cursor-agent`);
    expect(terminal.options.isTransient).toBe(true);
    expect(terminal.options.name).toBe('Cursor login');
    expect(terminal.options.cwd).toBe('/ws');
    expect(terminal.options.env.SECRET_TOKEN).toBe('do-not-log');
    expect(terminal.options.env.ORDEWELL_LOGIN_STATUS).toBe(terminal.statusFile);
    // The wrapper keeps the shell alive on a failed login so its output stays on screen.
    expect((terminal.options.shellArgs as string[])[1]).toContain('read -r');
    // No credential or argv value is written into the wrapper's own text.
    expect(JSON.stringify(terminal.options.shellArgs)).not.toMatch(/do-not-log|secret/);
    terminal.cleanup();
  });

  it('passes an argument with shell metacharacters as one literal argv element', () => {
    const launch = { shellPath: `${FAKE_BIN}/cursor-agent`, shellArgs: ['login', 'tok; rm -rf /', '"$(whoami)"'] as string[], PATH: FAKE_BIN };
    const terminal = buildLoginTerminal(launch, context());
    expect(wrappedCommand(terminal.options)).toEqual([`${FAKE_BIN}/cursor-agent`, 'login', 'tok; rm -rf /', '"$(whoami)"']);
    // The metacharacters live only in positional parameters, never the script string.
    expect((terminal.options.shellArgs as string[])[1]).not.toMatch(/rm -rf|whoami/);
    terminal.cleanup();
  });

  it('reads the wrapper status file for the actual exit code, tolerating a partial write', () => {
    const terminal = buildLoginTerminal({ shellPath: `${FAKE_BIN}/cursor-agent`, shellArgs: ['login'], PATH: FAKE_BIN }, context());
    expect(terminal.exitCode()).toBeUndefined();
    fs.writeFileSync(terminal.statusFile, '');
    expect(terminal.exitCode()).toBeUndefined();
    fs.writeFileSync(terminal.statusFile, '3\n');
    expect(terminal.exitCode()).toBe(3);
    // Cached: the host owns the file's lifetime once it has read the verdict.
    fs.rmSync(terminal.statusDir, { recursive: true, force: true });
    expect(terminal.exitCode()).toBe(3);
    terminal.cleanup();
  });

  it('ignores a non-numeric status file rather than taking it as a code', () => {
    const terminal = buildLoginTerminal({ shellPath: `${FAKE_BIN}/cursor-agent`, shellArgs: ['login'], PATH: FAKE_BIN }, context());
    fs.writeFileSync(terminal.statusFile, 'not-a-number');
    expect(terminal.exitCode()).toBeUndefined();
    terminal.cleanup();
  });

  it('removes its whole temp dir on cleanup, once and safely', () => {
    const ctx = context();
    const terminal = buildLoginTerminal({ shellPath: `${FAKE_BIN}/cursor-agent`, shellArgs: ['login'], PATH: FAKE_BIN }, ctx);
    expect(fs.existsSync(terminal.statusDir)).toBe(true);
    expect(terminal.cleanup()).toBe(true);
    expect(fs.existsSync(terminal.statusDir)).toBe(false);
    expect(terminal.cleanup()).toBe(true);
    expect(statusDirOf(ctx.tempRoot!)).toBeUndefined();
    expect(fs.readdirSync(ctx.tempRoot!())).toEqual([]);
  });
});

describe('buildLoginTerminal on Windows', () => {
  const CMD = 'C:\\Windows\\System32\\cmd.exe';
  const ctx = () => context({ platform: 'win32', comSpec: () => CMD });

  it('wraps even a native executable in a status-writing batch file that retains a failed login', () => {
    const launch = { shellPath: 'C:\\bin\\cursor-agent.exe', shellArgs: ['login'] as string[], PATH: 'C:\\bin' };
    const c = ctx();
    const terminal = buildLoginTerminal(launch, c);

    expect(terminal.options.shellPath).toBe(CMD);
    expect(typeof terminal.options.shellArgs).toBe('string');
    expect(terminal.options.shellArgs as string).toMatch(/^\/d \/s \/c /);
    expect(terminal.options.env.ORDEWELL_LOGIN_STATUS).toBe(terminal.statusFile);
    expect(terminal.options.env.ORDEWELL_LOGIN_FAIL).toContain('/login cursor-agent');

    const batch = fs.readdirSync(terminal.statusDir).filter((n) => n.endsWith('.cmd')).map((n) => fs.readFileSync(path.join(terminal.statusDir, n), 'utf8'))[0];
    expect(batch).toContain('C:\\bin\\cursor-agent.exe');
    expect(batch).toContain('ORDEWELL_LOGIN_STATUS');
    expect(batch).toContain('pause');
    expect(batch).toContain('exit /b');
    // Nothing credential-bearing is written into the batch file.
    expect(batch).not.toMatch(/do-not-log|SECRET_TOKEN/);
    terminal.cleanup();
  });

  it('hands a cmd.exe verbatim command line into the batch without re-quoting it', () => {
    const launch = { shellPath: CMD, shellArgs: '/d /s /c "C:\\bin\\cursor-agent.cmd login"' as string, PATH: 'C:\\bin' };
    const c = ctx();
    const terminal = buildLoginTerminal(launch, c);
    const batch = fs.readdirSync(terminal.statusDir).filter((n) => n.endsWith('.cmd')).map((n) => fs.readFileSync(path.join(terminal.statusDir, n), 'utf8'))[0];
    expect(batch).toContain('cursor-agent.cmd login');
    terminal.cleanup();
  });

  it('reads and cleans up the status file the same way on Windows', () => {
    const terminal = buildLoginTerminal({ shellPath: 'C:\\bin\\cursor-agent.exe', shellArgs: ['login'], PATH: 'C:\\bin' }, ctx());
    fs.writeFileSync(terminal.statusFile, '1\r\n');
    expect(terminal.exitCode()).toBe(1);
    expect(terminal.cleanup()).toBe(true);
    expect(fs.existsSync(terminal.statusDir)).toBe(false);
  });
});
