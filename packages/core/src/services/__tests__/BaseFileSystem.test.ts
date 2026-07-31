import { describe, it, expect, vi } from 'vitest';
import { BaseFileSystem } from '../BaseFileSystem';
import { ApprovalPolicy } from '../ApprovalPolicy';
import type { GrepOptions, ReadFileOpts, ToolOutcome } from '../../interfaces/IFileSystem';

const ROOT = '/repo';

/**
 * A test double for the mechanics half only. Every `*Impl` records the absolute
 * path it was handed, so a test can assert what the policy layer resolved and
 * authorized without touching a real disk.
 */
class TestFileSystem extends BaseFileSystem {
  readCalls: string[] = [];
  grepCalls: Array<{ pattern: string; root: string; opts: GrepOptions }> = [];
  listCalls: string[] = [];
  bashCalls: string[] = [];
  grepResponses: ToolOutcome[] = [];

  getWorkspaceRoot(): string { return ROOT; }

  protected async readFileImpl(absPath: string, _opts?: ReadFileOpts): Promise<ToolOutcome> {
    this.readCalls.push(absPath);
    return { success: true, output: `contents of ${absPath}`, truncated: false };
  }

  protected async globImpl(pattern: string, absRoot: string): Promise<ToolOutcome> {
    return { success: true, output: `${pattern} under ${absRoot}`, truncated: false };
  }

  protected async grepImpl(pattern: string, absRoot: string, opts: GrepOptions): Promise<ToolOutcome> {
    this.grepCalls.push({ pattern, root: absRoot, opts });
    return this.grepResponses.shift() ?? { success: true, output: 'No matches found.', truncated: false };
  }

  protected async listDirImpl(absPath: string): Promise<ToolOutcome> {
    this.listCalls.push(absPath);
    return { success: true, output: 'D src', truncated: false };
  }

  protected async execBashImpl(command: string): Promise<ToolOutcome> {
    this.bashCalls.push(command);
    return { success: true, output: 'ran', truncated: false };
  }
}

describe('BaseFileSystem — path confinement', () => {
  it('reads a workspace-relative path without consulting the approval channel', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn();
    fs.setApproval({ request });

    const result = await fs.readFile('src/index.ts');

    expect(result.success).toBe(true);
    expect(fs.readCalls).toEqual(['/repo/src/index.ts']);
    expect(request).not.toHaveBeenCalled();
  });

  it('denies an absolute path outside the workspace when nothing approves it', async () => {
    const fs = new TestFileSystem();

    const result = await fs.readFile('/etc/passwd');

    expect(result.success).toBe(false);
    expect(result.output).toContain('outside the workspace root');
    expect(fs.readCalls).toEqual([]);
  });

  it('denies a relative path that climbs out of the workspace', async () => {
    const fs = new TestFileSystem();

    const result = await fs.readFile('../../etc/passwd');

    expect(result.success).toBe(false);
    expect(fs.readCalls).toEqual([]);
  });

  it('reads an external path once approved, and scopes the grant to its directory', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(true);
    fs.setApproval({ request });

    const result = await fs.readFile('/tmp/dump/a.log');

    expect(result.success).toBe(true);
    expect(fs.readCalls).toEqual(['/tmp/dump/a.log']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'external_path',
      subject: '/tmp/dump/a.log',
      scope: '/tmp/dump/*',
    }));
  });

  it('asks once for a directory, then serves further files from it without prompting', async () => {
    const fs = new TestFileSystem();
    const ask = vi.fn().mockResolvedValue(true);
    fs.setApproval(new ApprovalPolicy({ ask }));

    await fs.readFile('/tmp/dump/a.log');
    await fs.readFile('/tmp/dump/b.log');

    expect(fs.readCalls).toEqual(['/tmp/dump/a.log', '/tmp/dump/b.log']);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('scopes a directory request to the directory itself, not its parent', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(true);
    fs.setApproval({ request });

    await fs.listDir('/tmp/dump');

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ scope: '/tmp/dump/*' }));
  });

  it('confines grep and glob search roots too, not just direct file reads', async () => {
    const fs = new TestFileSystem();

    const grepResult = await fs.grep('TODO', { path: '/etc' });
    const globResult = await fs.glob('*.conf', { path: '/etc' });

    expect(grepResult.success).toBe(false);
    expect(globResult.success).toBe(false);
    expect(fs.grepCalls).toEqual([]);
  });

  it('reports a denied file inline in readFiles instead of dropping it silently', async () => {
    const fs = new TestFileSystem();

    const result = await fs.readFiles(['src/a.ts', '/etc/passwd']);

    expect(result.output).toContain('contents of /repo/src/a.ts');
    expect(result.output).toContain('[not read]');
    expect(result.output).toContain('outside the workspace root');
  });
});

describe('BaseFileSystem — bash tiers', () => {
  it('runs an auto-tier command with no approval round-trip', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn();
    fs.setApproval({ request });

    const result = await fs.bash('git log --oneline');

    expect(result.success).toBe(true);
    expect(fs.bashCalls).toEqual(['git log --oneline']);
    expect(request).not.toHaveBeenCalled();
  });

  it('asks before an ask-tier command and runs it when granted', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(true);
    fs.setApproval({ request });

    const result = await fs.bash('npm test');

    expect(result.success).toBe(true);
    expect(fs.bashCalls).toEqual(['npm test']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'shell_command', scope: 'npm test' }));
  });

  it('does not run an ask-tier command that was denied, and says why', async () => {
    const fs = new TestFileSystem();
    fs.setApproval({ request: vi.fn().mockResolvedValue(false) });

    const result = await fs.bash('npm test');

    expect(result.success).toBe(false);
    expect(result.output).toContain('not approved');
    expect(fs.bashCalls).toEqual([]);
  });

  it('refuses a mutating command outright, never reaching the approval channel', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(true);
    fs.setApproval({ request });

    const result = await fs.bash('rm -rf build');

    expect(result.success).toBe(false);
    expect(result.output).toContain('refused');
    expect(request).not.toHaveBeenCalled();
    expect(fs.bashCalls).toEqual([]);
  });

  it('confines an auto-tier command that targets an absolute path outside the workspace', async () => {
    // cat/find/rg/etc. are auto-tier by binary alone; without this check their
    // arguments could read anywhere on disk with zero approval — exactly the
    // escape path confinement closes for readFile/glob/grep.
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(false);
    fs.setApproval({ request });

    const result = await fs.bash('cat /etc/passwd');

    expect(result.success).toBe(false);
    expect(result.output).toContain('outside the workspace root');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path', subject: '/etc/passwd' }));
    expect(fs.bashCalls).toEqual([]);
  });

  it('runs an auto-tier command touching an outside path once approved, scoped to its directory', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(true);
    fs.setApproval({ request });

    const result = await fs.bash('cat /etc/passwd');

    expect(result.success).toBe(true);
    expect(fs.bashCalls).toEqual(['cat /etc/passwd']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path', scope: '/etc/*' }));
  });

  it('does not ask about a workspace-relative path passed to an auto-tier command', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn();
    fs.setApproval({ request });

    const result = await fs.bash('cat src/index.ts');

    expect(result.success).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('confines an ask-tier command whose arguments also escape the workspace', async () => {
    const fs = new TestFileSystem();
    const request = vi.fn().mockResolvedValue(false);
    fs.setApproval({ request });

    const result = await fs.bash('npm --prefix /etc test');

    expect(result.success).toBe(false);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path' }));
    expect(fs.bashCalls).toEqual([]);
  });
});

describe('BaseFileSystem — findSymbol', () => {
  it('reports definitions first, then per-file reference counts', async () => {
    const fs = new TestFileSystem();
    fs.grepResponses = [
      { success: true, output: 'src/verdict.ts:12:export class VerdictEngine {', truncated: false },
      { success: true, output: 'src/verdict.ts:9\nsrc/session.ts:3', truncated: false },
    ];

    const result = await fs.findSymbol('VerdictEngine');

    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Definitions of "VerdictEngine" ===');
    expect(result.output).toContain('export class VerdictEngine');
    expect(result.output).toContain('=== References by file (match count) ===');
    expect(result.output.indexOf('Definitions')).toBeLessThan(result.output.indexOf('References'));
  });

  it('searches definitions and references as two separate bounded queries', async () => {
    const fs = new TestFileSystem();

    await fs.findSymbol('VerdictEngine');

    expect(fs.grepCalls).toHaveLength(2);
    expect(fs.grepCalls[0].opts.outputMode).toBe('content');
    expect(fs.grepCalls[1].opts.outputMode).toBe('count');
    expect(fs.grepCalls[0].opts.headLimit).toBe(40);
  });

  it('narrows to one language when asked, and rejects an unknown one', async () => {
    const fs = new TestFileSystem();

    await fs.findSymbol('handler', { language: 'go' });
    expect(fs.grepCalls[0].opts.include).toBe('*.go');

    const unknown = await fs.findSymbol('handler', { language: 'klingon' });
    expect(unknown.success).toBe(false);
    expect(unknown.output).toContain('Unknown language');
  });

  it('tells the model to fall back to grep when no definition matched', async () => {
    const fs = new TestFileSystem();
    fs.grepResponses = [
      { success: true, output: 'No matches found.', truncated: false },
      { success: true, output: 'src/a.ts:2', truncated: false },
    ];

    const result = await fs.findSymbol('Generated');

    expect(result.success).toBe(true);
    expect(result.output).toContain('fall back to grep');
  });

  it('rejects an empty symbol rather than searching for everything', async () => {
    const fs = new TestFileSystem();
    const result = await fs.findSymbol('   ');
    expect(result.success).toBe(false);
    expect(fs.grepCalls).toEqual([]);
  });
});

/**
 * The research shell and the classifier must agree on the language.
 *
 * `execBashImpl` runs through `shell: true`, which is `/bin/sh` on POSIX and
 * `cmd.exe` on Windows. `BaseFileSystem` resolves the shell once and passes its
 * dialect to `classifyCommand`, so the tier decision is made about the command
 * that will actually run. Classifying under POSIX rules and executing under
 * cmd.exe rules is the failure this coupling exists to make impossible.
 */
class DialectFileSystem extends TestFileSystem {
  constructor(dialect: 'posix' | 'cmd') {
    super();
    (this as unknown as { researchShell: unknown }).researchShell =
      { file: null, args: [], dialect, utilsDir: null };
  }
}

describe('BaseFileSystem research-shell coupling', () => {
  const allow = () => new ApprovalPolicy({ ask: async () => true });

  it('refuses a cmd.exe destructive builtin when the shell is cmd.exe', async () => {
    const fs = new DialectFileSystem('cmd');
    fs.setApproval(allow());

    const outcome = await fs.bash('del src\\important.ts');

    expect(outcome.success).toBe(false);
    expect(outcome.output).toContain('Command refused');
    expect(fs.bashCalls).toEqual([]);
  });

  // Confinement itself is host-flavoured by design — `resolveWithin` uses the
  // host's `path`, which is the correct semantics for the host's own paths. What
  // the dialect controls is whether the argument is *seen* as a path at all, and
  // that half is pinned in commandPolicy.test.ts. What matters here is that
  // switching dialects did not disconnect the gate.
  it('still prompts for an escaping path under the cmd.exe dialect', async () => {
    const fs = new DialectFileSystem('cmd');
    const asked: string[] = [];
    fs.setApproval(new ApprovalPolicy({ ask: async (req) => { asked.push(req.subject); return false; } }));

    const outcome = await fs.bash('cat /etc/passwd');

    expect(asked).toHaveLength(1);
    expect(outcome.success).toBe(false);
    expect(fs.bashCalls).toEqual([]);
  });

  it('does not mangle an in-workspace Windows path into a spurious escape', async () => {
    const fs = new DialectFileSystem('cmd');
    let asked = 0;
    fs.setApproval(new ApprovalPolicy({ ask: async () => { asked++; return true; } }));

    // Backslashes read as escapes turned this into `C:reposrc`, which resolves
    // drive-relative and failed containment against the very workspace it names.
    await fs.bash('rg pattern .\\src');

    expect(asked).toBe(0);
    expect(fs.bashCalls).toEqual(['rg pattern .\\src']);
  });

  it('appends the degradation warning to a failure only under cmd.exe', async () => {
    class Failing extends DialectFileSystem {
      protected async execBashImpl(_command: string): Promise<ToolOutcome> {
        return { success: false, output: `Command exited 1:\n'ls' is not recognized`, truncated: false };
      }
    }
    const cmd = new Failing('cmd');
    cmd.setApproval(allow());
    expect((await cmd.bash('ls -la')).output).toContain('Git for Windows');

    const posix = new Failing('posix');
    posix.setApproval(allow());
    expect((await posix.bash('ls -la')).output).not.toContain('Git for Windows');
  });

  // Proof the injected dialect is load-bearing and not incidentally agreeing
  // with the host: the same line is refused for two different reasons.
  it('reaches a dialect-specific verdict, not a host-default one', async () => {
    const cmd = new DialectFileSystem('cmd');
    cmd.setApproval(allow());
    expect((await cmd.bash("echo it's & del x")).output).toContain('"del" modifies state');

    const posix = new DialectFileSystem('posix');
    posix.setApproval(allow());
    // To `sh` the apostrophe opens a quote that never closes, so the classifier
    // cannot see what would run — refused for being unreadable, not for `del`.
    expect((await posix.bash("echo it's & del x")).output).toContain('Unterminated quote');
  });

  it('leaves the POSIX dialect behaving exactly as before', async () => {
    const fs = new DialectFileSystem('posix');
    fs.setApproval(allow());

    expect((await fs.bash('rm -rf build')).success).toBe(false);
    expect((await fs.bash('ls -la src')).success).toBe(true);
    expect(fs.bashCalls).toEqual(['ls -la src']);
  });
});
