import { describe, it, expect } from 'vitest';
import {
  planDirectLaunch,
  planShellLaunch,
  windowsCommandLine,
  isExecutableResolved,
  ExecutableNotFoundError,
  CommandLineTooLongError,
  EmbeddedNewlineError,
  CMD_EXE_MAX_COMMAND_LINE,
  WINDOWS_MAX_COMMAND_LINE,
  type LaunchDeps,
} from '../launch';

/**
 * A fake Windows host. `files` are the paths that exist; everything else does
 * not. Paths are compared case-insensitively because Windows does.
 */
function win(files: string[], overrides: Partial<LaunchDeps> = {}): LaunchDeps {
  const present = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    resolvePath: async () => 'C:\\tools;C:\\Users\\me\\AppData\\Roaming\\npm',
    exists: (candidate) => present.has(candidate.toLowerCase()),
    comSpec: () => 'C:\\Windows\\System32\\cmd.exe',
    powerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    pathExt: () => '.COM;.EXE;.BAT;.CMD;.VBS;.PS1',
    ...overrides,
  };
}

describe('planDirectLaunch on POSIX', () => {
  const posix: LaunchDeps = { platform: 'linux' };

  // The load-bearing property of this whole module: macOS and Linux must reach
  // `spawn` with exactly what they reached it with before it existed, because
  // execvp already searches PATH and any resolution step here is a new way for
  // a working install to break.
  it('is the identity — no resolution, no interpreter, no verbatim flag', async () => {
    const plan = await planDirectLaunch('claude', ['-p', 'do it'], posix);
    expect(plan).toEqual({ file: 'claude', args: ['-p', 'do it'] });
  });

  it('does not consult the filesystem or PATH at all', async () => {
    let touched = false;
    await planDirectLaunch('opencode', [], {
      platform: 'darwin',
      exists: () => { touched = true; return true; },
      resolvePath: async () => { touched = true; return '/nope'; },
    });
    expect(touched).toBe(false);
  });
});

describe('planDirectLaunch on Windows', () => {
  it('resolves a native executable and spawns it directly', async () => {
    const plan = await planDirectLaunch('claude', ['-p', 'go'], win(['C:\\tools\\claude.exe']));
    expect(plan).toEqual({ file: 'C:\\tools\\claude.exe', args: ['-p', 'go'] });
  });

  // CreateProcess performs no PATHEXT lookup, so a bare `claude` was ENOENT
  // even though every install of it on Windows is one of these files.
  it('finds the executable that a bare command name cannot reach', async () => {
    const plan = await planDirectLaunch('codex', ['app-server'], win(['C:\\tools\\codex.exe']));
    expect(plan.file).toBe('C:\\tools\\codex.exe');
  });

  it('routes a batch shim through cmd.exe with verbatim arguments', async () => {
    const plan = await planDirectLaunch(
      'claude',
      ['--model', 'opus'],
      win(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']),
    );
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.verbatim).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toContain('claude.cmd');
    expect(plan.args[3]).toContain('--model opus');
  });

  // `cmd /s /c` strips the first quote on the line and the *last* one, then
  // takes the rest verbatim. Without an outer pair of our own, a shim under
  // `C:\Program Files\…` lost its opening quote and the final argument lost its
  // closing one, and cmd tried to run `C:\Program`. Every user whose account
  // name contains a space hit this on their first task.
  it('wraps the whole command line so cmd.exe strips our quotes, not the path\'s', async () => {
    const plan = await planDirectLaunch(
      'claude',
      ['-p', 'go'],
      win(['C:\\Program Files\\npm\\claude.cmd'], {
        resolvePath: async () => 'C:\\Program Files\\npm',
      }),
    );
    expect(plan.args[3]).toBe('""C:\\Program Files\\npm\\claude.cmd" -p go"');
    // What cmd.exe is left with after removing the outer pair.
    const unwrapped = plan.args[3].slice(1, -1);
    expect(unwrapped.startsWith('"C:\\Program Files\\npm\\claude.cmd"')).toBe(true);
  });

  it('leaves a space-free shim line unwrapped-equivalent but still balanced', async () => {
    const plan = await planDirectLaunch('claude', ['-p'], win(['C:\\tools\\claude.cmd']));
    expect(plan.args[3]).toBe('"C:\\tools\\claude.cmd -p"');
  });

  // Windows itself resolves per-directory, so a `.cmd` early on PATH would
  // shadow a later `.exe`. Preferring the extension class globally is what
  // keeps the common case off cmd.exe and its 8191-character buffer.
  it('prefers a native executable late on PATH over a shim early on it', async () => {
    const plan = await planDirectLaunch('opencode', [], win([
      'C:\\tools\\opencode.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.exe',
    ]));
    expect(plan.file).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.exe');
    expect(plan.verbatim).toBeUndefined();
  });

  it('honours an extension the caller spelled out rather than searching past it', async () => {
    const plan = await planDirectLaunch('claude.cmd', [], win([
      'C:\\tools\\claude.cmd',
      'C:\\tools\\claude.exe',
    ]));
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('searches only the named directory when the command carries one', async () => {
    const plan = await planDirectLaunch('C:\\custom\\claude', [], win([
      'C:\\custom\\claude.exe',
      'C:\\tools\\claude.exe',
    ]));
    expect(plan.file).toBe('C:\\custom\\claude.exe');
  });

  // The caller's own ENOENT names the command the user typed; a second, vaguer
  // error from here would only get in front of it.
  it('hands an unresolvable command back untouched', async () => {
    const plan = await planDirectLaunch('nosuchcli', ['-x'], win([]));
    expect(plan).toEqual({ file: 'nosuchcli', args: ['-x'] });
  });

  it('skips PATHEXT entries no route can start', async () => {
    // `.vbs` is on PATHEXT and startable only by wscript, which is not a route.
    const plan = await planDirectLaunch('claude', [], win(['C:\\tools\\claude.vbs']));
    expect(plan.file).toBe('claude');
  });

  // A truncated system prompt would make the planner answer half a question
  // confidently, which is exactly the silent success this repo refuses.
  it('refuses a shim invocation that would overflow cmd.exe rather than truncating it', async () => {
    const huge = 'x'.repeat(CMD_EXE_MAX_COMMAND_LINE + 1);
    await expect(
      planDirectLaunch('claude', ['--append-system-prompt', huge], win(['C:\\tools\\claude.cmd'])),
    ).rejects.toThrow(CommandLineTooLongError);
  });

  it('has no such limit once a native executable is found', async () => {
    const huge = 'x'.repeat(CMD_EXE_MAX_COMMAND_LINE + 1);
    const plan = await planDirectLaunch('claude', ['--append-system-prompt', huge], win(['C:\\tools\\claude.exe']));
    expect(plan.args[1]).toHaveLength(huge.length);
  });

  it('names the fix in the overflow message, because the user cannot infer it', async () => {
    const huge = 'x'.repeat(CMD_EXE_MAX_COMMAND_LINE + 1);
    const err = await planDirectLaunch('claude', [huge], win(['C:\\tools\\claude.cmd'])).catch((e) => e);
    expect(err.message).toContain('native executable');
    expect(err.message).toContain('claude.cmd');
  });

  it('refuses a batch-only install rather than truncating a multi-line prompt', async () => {
    await expect(
      planDirectLaunch(
        'opencode',
        ['--prompt', 'Do the task.\n\nWhen done, print the completion marker.'],
        win(['C:\\tools\\opencode.cmd']),
      ),
    ).rejects.toThrow(EmbeddedNewlineError);
  });

  it('treats a bare CR as unsafe too', async () => {
    await expect(
      planDirectLaunch('claude', ['-p', 'a\rb'], win(['C:\\tools\\claude.cmd'])),
    ).rejects.toThrow(EmbeddedNewlineError);
  });

  it('names the fix in the line-break message', async () => {
    const err = await planDirectLaunch('opencode', ['a\nb'], win(['C:\\tools\\opencode.cmd'])).catch((e) => e);
    expect(err.message).toContain('native executable');
    expect(err.message).toContain('opencode.ps1');
  });

  it('leaves a single-line invocation on the batch route', async () => {
    const plan = await planDirectLaunch('claude', ['-p', 'go'], win(['C:\\tools\\claude.cmd']));
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  // The OS ceiling is not a shim's, so the message must not send the user off
  // to reinstall something that would not help.
  it('refuses at the OS ceiling too, without advising a pointless reinstall', async () => {
    const huge = 'x'.repeat(WINDOWS_MAX_COMMAND_LINE + 1);
    const err = await planDirectLaunch('claude', [huge], win(['C:\\tools\\claude.exe'])).catch((e) => e);
    expect(err).toBeInstanceOf(CommandLineTooLongError);
    expect(err.message).not.toContain('native executable');
    expect(err.message).toContain('Shorten the task prompt');
  });
});

describe('planDirectLaunch on Windows: the PowerShell shim tier', () => {
  // The install shapes that write a script and no binary used to be a bare
  // `spawn ENOENT` naming a CLI the user could plainly see was installed.
  it('starts a .ps1-only install through powershell.exe -File', async () => {
    const plan = await planDirectLaunch('opencode', ['run', 'go'], win(['C:\\tools\\opencode.ps1']));
    expect(plan.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(plan.args).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'C:\\tools\\opencode.ps1', 'run', 'go',
    ]);
    // Node's own quoting applies — this is an argument vector, not a command line.
    expect(plan.verbatim).toBeUndefined();
  });

  // A profile can print a banner into what, for a harness planner, is a
  // JSON-RPC stream; the default execution policy refuses unsigned scripts.
  it('neutralises the profile and the execution policy', async () => {
    const plan = await planDirectLaunch('claude', [], win(['C:\\tools\\claude.ps1']));
    expect(plan.args).toContain('-NoProfile');
    expect(plan.args.join(' ')).toContain('-ExecutionPolicy Bypass');
  });

  // Windows' default PATHEXT is `.COM;.EXE;.BAT;.CMD;.VBS;…` — no `.PS1`,
  // because PowerShell resolves scripts itself. Filtering this tier against
  // PATHEXT would disable it on exactly the machines it exists for.
  it('finds a .ps1 even when PATHEXT does not list one', async () => {
    const plan = await planDirectLaunch('claude', [], win(['C:\\tools\\claude.ps1'], {
      pathExt: () => '.COM;.EXE;.BAT;.CMD;.VBS',
    }));
    expect(plan.file).toContain('powershell.exe');
  });

  it('prefers a native executable over a .ps1 beside it', async () => {
    const plan = await planDirectLaunch('claude', [], win([
      'C:\\tools\\claude.ps1',
      'C:\\tools\\claude.exe',
    ]));
    expect(plan.file).toBe('C:\\tools\\claude.exe');
  });

  // npm, pnpm and Yarn all write both, and the batch route is the one with a
  // decade of Ordewell-shaped mileage on it.
  it('prefers a batch shim over a .ps1 beside it', async () => {
    const plan = await planDirectLaunch('claude', [], win([
      'C:\\tools\\claude.ps1',
      'C:\\tools\\claude.cmd',
    ]));
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  // Overflow means a very large prompt, which is where `-File` argument
  // fidelity is least worth betting on. A visible held task beats a plausibly
  // mangled one, so availability orders the tiers and capacity does not.
  it('does not rescue an overflowing batch shim by falling through to PowerShell', async () => {
    const huge = 'x'.repeat(CMD_EXE_MAX_COMMAND_LINE + 1);
    await expect(
      planDirectLaunch('claude', [huge], win(['C:\\tools\\claude.cmd', 'C:\\tools\\claude.ps1'])),
    ).rejects.toThrow(CommandLineTooLongError);
  });

  // Unlike overflow, a line break reorders the tiers: cmd.exe drops everything
  // past it and still reports success.
  it('takes the .ps1 beside a .cmd when the arguments span lines', async () => {
    const prompt = 'Do the task.\n\nWhen done, print the completion marker.';
    const plan = await planDirectLaunch(
      'opencode',
      ['--prompt', prompt],
      win(['C:\\tools\\opencode.cmd', 'C:\\tools\\opencode.ps1']),
    );
    expect(plan.file).toContain('powershell.exe');
    expect(plan.args[plan.args.length - 1]).toBe(prompt);
  });

  it('still prefers a native executable over both when one exists', async () => {
    const plan = await planDirectLaunch('opencode', ['--prompt', 'a\nb'], win([
      'C:\\tools\\opencode.cmd',
      'C:\\tools\\opencode.ps1',
      'C:\\tools\\opencode.exe',
    ]));
    expect(plan.file).toBe('C:\\tools\\opencode.exe');
    expect(plan.args[1]).toBe('a\nb');
  });

  it('honours an explicitly spelled .ps1 rather than searching past it', async () => {
    const plan = await planDirectLaunch('claude.ps1', [], win([
      'C:\\tools\\claude.ps1',
      'C:\\tools\\claude.exe',
    ]));
    expect(plan.file).toContain('powershell.exe');
  });

  it('falls back to a bare interpreter name when SystemRoot is unknown', async () => {
    const plan = await planDirectLaunch('claude', [], win(['C:\\tools\\claude.ps1'], {
      powerShell: () => 'powershell.exe',
    }));
    expect(plan.file).toBe('powershell.exe');
  });
});

describe('windowsCommandLine', () => {
  it('leaves an ordinary argument unquoted', () => {
    expect(windowsCommandLine('claude.cmd', ['-p'])).toBe('claude.cmd -p');
  });

  it('quotes arguments containing spaces', () => {
    expect(windowsCommandLine('c.cmd', ['do the thing'])).toBe('c.cmd "do the thing"');
  });

  it('quotes cmd.exe metacharacters that would otherwise chain a command', () => {
    expect(windowsCommandLine('c.cmd', ['a&del b'])).toBe('c.cmd "a&del b"');
    expect(windowsCommandLine('c.cmd', ['a|b'])).toBe('c.cmd "a|b"');
  });

  it('escapes an embedded double quote', () => {
    expect(windowsCommandLine('c.cmd', ['say "hi"'])).toBe('c.cmd "say \\"hi\\""');
  });

  // The CommandLineToArgvW inverse: a backslash run is only doubled where it
  // meets a quote, so an ordinary Windows path stays readable.
  it('leaves interior backslashes alone', () => {
    expect(windowsCommandLine('c.cmd', ['C:\\repo\\src'])).toBe('c.cmd C:\\repo\\src');
  });

  it('doubles a trailing backslash run so it does not escape the closing quote', () => {
    expect(windowsCommandLine('c.cmd', ['C:\\repo dir\\'])).toBe('c.cmd "C:\\repo dir\\\\"');
  });

  it('renders an empty argument as an empty quoted string', () => {
    expect(windowsCommandLine('c.cmd', [''])).toBe('c.cmd ""');
  });
});

describe('planShellLaunch', () => {
  it('produces the POSIX login shell unchanged', async () => {
    const plan = await planShellLaunch('claude', ['-p', `it's`], { platform: 'linux' });
    expect(plan.file).toBe('/bin/bash');
    expect(plan.args[0]).toBe('-lc');
    expect(plan.args[1]).toBe(`'claude' '-p' 'it'\\''s'`);
  });

  // Windows has no login shell to emulate, and going direct means the runner's
  // own exit code is the terminal's exit code — half of what VerdictEngine
  // judges a task on, rather than a $LASTEXITCODE PowerShell may not propagate.
  it('starts the runner directly on Windows instead of through a shell', async () => {
    const plan = await planShellLaunch('claude', ['-p', 'go'], win(['C:\\tools\\claude.exe']));
    expect(plan.file).toBe('C:\\tools\\claude.exe');
    expect(plan.args).toEqual(['-p', 'go']);
  });
});

describe('isExecutableResolved', () => {
  const PATH = '/usr/local/bin:/usr/bin';

  it('is true on POSIX when the command exists in a PATH directory', async () => {
    const plan = await planDirectLaunch('claude', ['-p'], { platform: 'linux' });
    const resolved = isExecutableResolved('claude', plan, PATH, {
      platform: 'linux',
      exists: (candidate) => candidate === '/usr/local/bin/claude',
    });
    expect(resolved).toBe(true);
  });

  it('is false on POSIX when the command is on no PATH directory', async () => {
    const plan = await planDirectLaunch('claude', ['-p'], { platform: 'linux' });
    const resolved = isExecutableResolved('claude', plan, PATH, {
      platform: 'linux',
      exists: () => false,
    });
    expect(resolved).toBe(false);
  });

  it('checks the path directly on POSIX when the command already names one', async () => {
    const plan = await planDirectLaunch('./bin/claude', [], { platform: 'linux' });
    const resolved = isExecutableResolved('./bin/claude', plan, PATH, {
      platform: 'linux',
      exists: (candidate) => candidate === './bin/claude',
    });
    expect(resolved).toBe(true);
  });

  it('is true on Windows when planDirectLaunch resolved the command to a real file', async () => {
    const plan = await planDirectLaunch('claude', ['-p', 'go'], win(['C:\\tools\\claude.exe']));
    expect(isExecutableResolved('claude', plan, PATH, { platform: 'win32' })).toBe(true);
  });

  it('is false on Windows when planDirectLaunch handed the bare command back unresolved', async () => {
    const plan = await planDirectLaunch('nosuchcli', ['-x'], win([]));
    expect(isExecutableResolved('nosuchcli', plan, PATH, { platform: 'win32' })).toBe(false);
  });
});

describe('ExecutableNotFoundError', () => {
  it('names the command and the PATH it searched', () => {
    const err = new ExecutableNotFoundError('opencode', '/usr/local/bin:/usr/bin');
    expect(err.message).toContain('opencode');
    expect(err.message).toContain('/usr/local/bin:/usr/bin');
  });
});
