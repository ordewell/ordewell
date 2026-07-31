import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PoolFileSystem } from '../PoolFileSystem';

let tmpDir: string;
let fsAdapter: PoolFileSystem;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pfs-'));
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello World\nLine Two\nLine Three\n');
  fs.writeFileSync(path.join(tmpDir, 'data.json'), JSON.stringify({ key: 'value', list: [1, 2, 3] }));
  fs.writeFileSync(path.join(tmpDir, 'search.txt'), 'apple banana cherry\ndog elephant fox\ngrape honey iguana\n');
  fs.writeFileSync(path.join(tmpDir, 'ten_lines.txt'), Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n');
  // ~3 KB file for the maxBytes cap test
  const bigContent = Array.from({ length: 60 }, (_, i) => `This is a long line that exists purely to pad the file size for testing purposes — line number ${i + 1}.`).join('\n');
  fs.writeFileSync(path.join(tmpDir, 'medium.txt'), bigContent + '\n');
  fs.mkdirSync(path.join(tmpDir, 'subdir'));
  fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content');
  // A definition plus a call site, so find_symbol can be shown to separate them.
  fs.writeFileSync(path.join(tmpDir, 'totals.ts'), 'export function computeTotal(xs: number[]) {\n  return xs.length;\n}\n');
  fs.writeFileSync(path.join(tmpDir, 'caller.ts'), "import { computeTotal } from './totals';\nconst total = computeTotal([1, 2]);\n");
  fsAdapter = new PoolFileSystem(tmpDir);
});

/** Forces the POSIX-grep fallback by pre-resolving the ripgrep probe to false. */
function withoutRipgrep(): PoolFileSystem {
  const adapter = new PoolFileSystem(tmpDir);
  (adapter as unknown as { rgAvailable: Promise<boolean> }).rgAvailable = Promise.resolve(false);
  return adapter;
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PoolFileSystem', () => {
  describe('getWorkspaceRoot', () => {
    it('returns the workspace root', () => {
      expect(fsAdapter.getWorkspaceRoot()).toBe(tmpDir);
    });
  });

  describe('readFile', () => {
    it('reads a file with line numbers', async () => {
      const result = await fsAdapter.readFile('hello.txt');
      expect(result.success).toBe(true);
      expect(result.output).toBe(
        '1|Hello World\n2|Line Two\n3|Line Three'
      );
      expect(result.truncated).toBe(false);
    });

    it('returns failure for missing file', async () => {
      const result = await fsAdapter.readFile('nope.txt');
      expect(result.success).toBe(false);
    });

    it('starts from a 0-based line offset', async () => {
      const result = await fsAdapter.readFile('hello.txt', { offset: 1 });
      expect(result.success).toBe(true);
      expect(result.output).toBe(
        '2|Line Two\n3|Line Three'
      );
    });

    it('limits the number of lines returned', async () => {
      const result = await fsAdapter.readFile('hello.txt', { limit: 2 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1|Hello World');
      expect(result.output).toContain('2|Line Two');
      expect(result.output).not.toContain('3|Line Three');
    });

    it('marks as truncated when limit is less than total lines', async () => {
      const result = await fsAdapter.readFile('hello.txt', { limit: 2 });
      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
    });

    it('appends a hint about remaining lines when truncated', async () => {
      const result = await fsAdapter.readFile('hello.txt', { limit: 2 });
      expect(result.output).toContain('(File has more lines');
      expect(result.output).toContain('offset=2');
    });

    it('returns offset beyond file length as empty', async () => {
      const result = await fsAdapter.readFile('hello.txt', { offset: 10 });
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('rejects files exceeding maxBytes with an actionable message', async () => {
      // medium.txt is ~3 KB; cap at 1 KB to force rejection
      const result = await fsAdapter.readFile('medium.txt', { maxBytes: 1 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('File too large');
      expect(result.output).toContain('grep');
    });
  });

  describe('glob', () => {
    it('finds files by pattern', async () => {
      const result = await fsAdapter.glob('*.txt');
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello.txt');
      expect(result.output).toContain('search.txt');
    });

    it('returns success with empty output when no matches', async () => {
      const result = await fsAdapter.glob('*.no_such_extension_xyz');
      expect(result.success).toBe(true);
      expect(result.output).toBe('No files matched.');
      expect(result.truncated).toBe(false);
    });

    // A pattern with a `/` is anchored, and ripgrep resolves an anchored
    // `--glob` against its own process cwd rather than the `--` search path.
    // The test runner's cwd is the package root, not tmpDir, so this fails
    // back to a false "No files matched." without cwd: absRoot wired through.
    it('finds files under a subdirectory with an anchored pattern', async () => {
      const result = await fsAdapter.glob('subdir/*.txt');
      expect(result.success).toBe(true);
      expect(result.output).toContain('nested.txt');
    });
  });

  describe('grep', () => {
    it('finds matching lines', async () => {
      const result = await fsAdapter.grep('banana');
      expect(result.success).toBe(true);
      expect(result.output).toContain('banana');
    });

    it('returns empty message when nothing matches', async () => {
      const result = await fsAdapter.grep('zzzzz_not_found');
      expect(result.success).toBe(true);
      expect(result.output).toBe('No matches found.');
    });

    // Both tools exit 1 for "no matches", which is an empty success rather
    // than a failure — this pins the path machines with ripgrep never take.
    it('reports no matches on the grep fallback path too (no ripgrep)', async () => {
      const result = await withoutRipgrep().grep('zzzzz_not_found');
      expect(result.success).toBe(true);
      expect(result.output).toBe('No matches found.');
    });

    it('finds matching lines on the grep fallback path too (no ripgrep)', async () => {
      const result = await withoutRipgrep().grep('banana');
      expect(result.success).toBe(true);
      expect(result.output).toContain('banana');
    });

    describe('output modes', () => {
      it('files mode returns paths without line content', async () => {
        const result = await fsAdapter.grep('banana', { outputMode: 'files' });
        expect(result.success).toBe(true);
        expect(result.output).toContain('search.txt');
        expect(result.output).not.toContain('apple banana');
      });

      it('count mode returns a per-file tally', async () => {
        const result = await fsAdapter.grep('Line', { outputMode: 'count' });
        expect(result.success).toBe(true);
        expect(result.output).toMatch(/ten_lines\.txt:\d+/);
      });

      it('literal mode does not interpret regex metacharacters', async () => {
        const result = await fsAdapter.grep('a(b', { literal: true });
        expect(result.success).toBe(true);
        expect(result.output).toBe('No matches found.');
      });

      it('case-insensitive mode matches across case', async () => {
        const result = await fsAdapter.grep('BANANA', { caseInsensitive: true });
        expect(result.success).toBe(true);
        expect(result.output).toContain('banana');
      });
    });

    it('caps rows globally and says how many were dropped', async () => {
      const result = await fsAdapter.grep('Line', { headLimit: 2 });
      expect(result.success).toBe(true);
      expect(result.output.split('\n').filter((l) => l.includes('Line')).length).toBeLessThanOrEqual(2);
      expect(result.output).toContain('showing 2 of');
    });

    // Same anchored-glob-vs-cwd hazard as the glob tool: an `include` filter
    // with a `/` in it must resolve against absRoot, not the test runner's cwd.
    it('honors an anchored include filter', async () => {
      const result = await fsAdapter.grep('nested', { include: 'subdir/*.txt' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('nested.txt');
    });
  });

  describe('findSymbol', () => {
    it('reports the definition ahead of the references', async () => {
      const result = await fsAdapter.findSymbol('computeTotal');

      expect(result.success).toBe(true);
      expect(result.output).toContain('Definitions of "computeTotal"');
      expect(result.output).toContain('export function computeTotal');
      expect(result.output).toContain('References by file');
    });

    it('does not mistake a call site for a definition', async () => {
      const result = await fsAdapter.findSymbol('computeTotal');
      const definitions = result.output.slice(0, result.output.indexOf('References by file'));

      expect(definitions).not.toContain('const total = computeTotal(');
    });

    it('narrows to one language when asked', async () => {
      const result = await fsAdapter.findSymbol('computeTotal', { language: 'python' });
      expect(result.output).toContain('None matched the definition patterns');
    });
  });

  describe('path confinement', () => {
    it('denies an absolute path outside the workspace with no approval channel', async () => {
      const result = await fsAdapter.readFile('/etc/hostname');
      expect(result.success).toBe(false);
      expect(result.output).toContain('outside the workspace root');
    });

    it('denies a relative path that climbs out of the workspace', async () => {
      const result = await fsAdapter.readFile('../../../etc/hostname');
      expect(result.success).toBe(false);
    });

    it('reads outside the workspace once approved', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-outside-'));
      fs.writeFileSync(path.join(outside, 'note.txt'), 'external content');

      const approving = new PoolFileSystem(tmpDir);
      approving.setApproval({ request: async () => true });

      const result = await approving.readFile(path.join(outside, 'note.txt'));
      expect(result.success).toBe(true);
      expect(result.output).toContain('external content');

      fs.rmSync(outside, { recursive: true, force: true });
    });
  });

  describe('listDir', () => {
    it('lists directory contents', async () => {
      const result = await fsAdapter.listDir('.');
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello.txt');
      expect(result.output).toContain('subdir');
    });

    it('returns failure for missing path', async () => {
      const result = await fsAdapter.listDir('/no/such/dir');
      expect(result.success).toBe(false);
    });
  });

  describe('bash (inherited tier policy)', () => {
    it('refuses a mutating command outright', async () => {
      const result = await fsAdapter.bash('rm -rf .');
      expect(result.success).toBe(false);
      expect(result.output).toContain('refused');
    });

    it('allows chaining when every stage is read-only', async () => {
      const result = await fsAdapter.bash('ls && echo hi');
      expect(result.success).toBe(true);
      expect(result.output).toContain('hi');
    });

    it('refuses a chain the moment one stage mutates', async () => {
      const result = await fsAdapter.bash('ls && rm -rf .');
      expect(result.success).toBe(false);
      expect(result.output).toContain('refused');
    });

    it('allows safe commands', async () => {
      const result = await fsAdapter.bash('ls');
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello.txt');
    });

    it('denies an ask-tier command when no approval channel is wired', async () => {
      const result = await fsAdapter.bash('npm test');
      expect(result.success).toBe(false);
      expect(result.output).toContain('not approved');
    });

    it('runs an ask-tier command once approved', async () => {
      const approving = new PoolFileSystem(tmpDir);
      approving.setApproval({ request: async () => true });

      const result = await approving.bash('echo approved && echo twice');
      expect(result.success).toBe(true);
    });

    it('reports the output of a failing command rather than swallowing it — the failure is the research', async () => {
      // Workspace-relative and missing, so this exercises the "command failed"
      // path rather than the path-confinement gate (a separate concern, see
      // the "outside the workspace" describe block below).
      const result = await fsAdapter.bash('cat nonexistent-file');
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/exited \d+/);
    });

    describe('an auto-tier command whose argument names a path outside the workspace', () => {
      it('is denied with no approval channel wired, and never actually runs', async () => {
        const result = await fsAdapter.bash('cat /etc/hostname');
        expect(result.success).toBe(false);
        expect(result.output).toContain('outside the workspace root');
      });

      it('runs once approved', async () => {
        const approving = new PoolFileSystem(tmpDir);
        approving.setApproval({ request: async () => true });

        const result = await approving.bash('cat /etc/hostname');
        expect(result.success).toBe(true);
      });

      it('still runs with no approval needed when every path argument stays inside the workspace', async () => {
        const result = await fsAdapter.bash('cat hello.txt');
        expect(result.success).toBe(true);
      });
    });
  });

  describe('readFiles (inherited)', () => {
    it('reads multiple files', async () => {
      const result = await fsAdapter.readFiles(['hello.txt', 'data.json']);
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello.txt');
      expect(result.output).toContain('data.json');
    });
  });
});
