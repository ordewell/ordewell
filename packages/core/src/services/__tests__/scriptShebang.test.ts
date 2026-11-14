import { describe, it, expect } from 'vitest';
import { interpreterOf, isShell, shebangArgv, shebangOf } from '../scriptShebang';

describe('scriptShebang', () => {
  it('reads only a first line that starts with #!', () => {
    expect(shebangOf('echo hi\n#!/bin/bash')).toBeNull();
    expect(shebangOf(' #!/bin/bash')).toBeNull();
    expect(shebangOf('#!\necho')).toBeNull();
    expect(shebangOf('#!/bin/bash -e\r\necho')).toEqual({ line: '#!/bin/bash -e', program: '/bin/bash', words: ['-e'] });
  });

  it('reads env as a lookup of the name after it, past its own options', () => {
    expect(interpreterOf(shebangOf('#!/usr/bin/env bash')!)).toEqual({ name: 'bash', words: [] });
    expect(interpreterOf(shebangOf('#!/usr/bin/env -S FOO=1 bash -eu')!)).toEqual({ name: 'bash', words: ['-eu'] });
    expect(interpreterOf(shebangOf('#!/bin/sh -e')!)).toEqual({ name: '/bin/sh', words: ['-e'] });
  });

  it('skips the value of an env option that takes one, and an option terminator before -c (review 132)', () => {
    expect(interpreterOf(shebangOf('#!/usr/bin/env -u NAME bash')!)).toEqual({ name: 'bash', words: [] });
    expect(interpreterOf(shebangOf('#!/usr/bin/env -C /tmp --unset X zsh -e')!)).toEqual({ name: 'zsh', words: ['-e'] });
    expect(interpreterOf(shebangOf('#!/bin/sh -')!)).toEqual({ name: '/bin/sh', words: [] });
    expect(shebangArgv(shebangOf('#!/bin/bash -e --')!, 'x')).toEqual(['/bin/bash', '-e', '-c', 'x']);
  });

  it('knows a shell by its name, not its directory or extension', () => {
    expect(['bash', '/bin/zsh', 'C:\\Git\\bin\\bash.exe', 'dash'].map(isShell)).toEqual([true, true, true, true]);
    expect(['python3', '/usr/bin/env', 'node'].map(isShell)).toEqual([false, false, false]);
  });
});
