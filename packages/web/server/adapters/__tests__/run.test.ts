import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { run, MAX_OUTPUT_BYTES } from '../run';

/**
 * `run` is the single primitive every search/inspection adapter in this
 * package is built on. Its public API is unfussy — spawn a child, capture
 * stdout/stderr/exit — but the *invariants* are the load-bearing thing: a
 * spawn failure must degrade to a failed tool call with a recognizable code,
 * never reject the promise, never abort the planner turn. A regression that
 * dropped the synchronous-throw try/catch or changed `code: null` to `1`
 * would pass the whole adapter suite today, because no public method reaches
 * the synchronous-throw branch in normal use; these tests are the only thing
 * pinning it.
 */

const TIMEOUT = 5_000;

describe('run — happy paths', () => {
  it('captures stdout and reports code 0 when the child exits cleanly', async () => {
    const r = await run('node', ['-e', "console.log('ok')"], { timeout: TIMEOUT });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stderr).toBe('');
  });

  it('preserves a non-zero numeric exit code from the child, not just 0-vs-nonzero', async () => {
    // The coercion has a `typeof err.code === 'number'` branch specifically so
    // a numeric child exit code is passed through unchanged — exit 7 stays 7,
    // not flattened to a generic 1.
    const r = await run('node', ['-e', 'process.exit(7)'], { timeout: TIMEOUT });
    expect(r.code).toBe(7);
    expect(r.stdout).toBe('');
  });

  it('captures stderr separately from stdout', async () => {
    const r = await run('node', ['-e', "console.error('boom'); process.exit(1)"], { timeout: TIMEOUT });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('boom');
  });
});

describe('run — failure modes never reject the promise', () => {
  it('resolves (with code 1) when the binary is missing — ENOENT arrives via the callback, not as a synchronous throw', async () => {
    // ENOENT is one of the few errno values Node delivers to the callback
    // rather than throwing synchronously. The coercion sees a *string* err.code
    // ('ENOENT') and falls into the `err ? 1 : 0` branch, so a missing binary
    // surfaces as exit 1 — a recognizable failure, not a rejected promise.
    // Note the gap pin points at but does not fix: on the callback path `run`
    // forwards the *child's* stderr, not Node's err.message, so a missing
    // binary resolves with empty stderr — search adapters reading `code: 1` +
    // empty stdout may then frame it as "No matches found."
    const r = await run('definitely-not-a-binary-xyz', [], { timeout: TIMEOUT });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  // THE load-bearing case. Node throws ENOTDIR synchronously when `cwd` is a
  // file rather than a directory; without the try/catch inside `run`, that
  // throw would reject the returned promise and abort the entire planner turn
  // ("Plan generation failed: spawn ENOTDIR"). With it, the failure becomes a
  // resolved value with a sentinel `code` the search adapters translate to
  // "Search failed" instead of "No matches found." — `null`, never `1`,
  // because the adapter reads 1 as "ran, possibly no matches."
  describe('on a synchronous spawn throw (cwd is a file, ENOTDIR)', () => {
    let tmpDir: string;
    let fileForCwd: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-run-'));
      fileForCwd = path.join(tmpDir, 'cwd-is-a-file.txt');
      fs.writeFileSync(fileForCwd, 'not a directory');
    });
    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves rather than rejecting the promise', async () => {
      const r = await run('node', ['-e', "console.log('never')"], {
        timeout: TIMEOUT,
        cwd: fileForCwd,
      });
      // Reaching this line at all proves the promise resolved instead of
      // rejecting — `await` would have thrown on rejection.
      expect(r).toBeDefined();
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('ENOTDIR');
    });

    it('reports `code: null` — distinct from the exit-1 path the search adapters read as "no matches"', async () => {
      const r = await run('node', ['-e', "console.log('never')"], {
        timeout: TIMEOUT,
        cwd: fileForCwd,
      });
      // Pinning the exact sentinel from the catch branch. If this regresses to
      // `1` (or any number), globImpl/grepImpl would translate a search that
      // never executed into a confident "No matches found." — exactly the
      // ghost-match the comment in `run` warns about.
      expect(r.code).toBe(null);
      expect(r.code).not.toBe(1);
    });
  });

  it('resolves — does not reject — when stdout overflows maxBuffer (cargo of the partial output carried through)', async () => {
    // Node kills the child on overflow and invokes the callback with
    // err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' (a string), plus
    // whatever was buffered up to MAX_OUTPUT_BYTES as `stdout`. The current
    // coercion maps the string code to `1`, so a search that overflows lands
    // in the adapters' "code !== 0 && code !== 1 && !stdout" branch (false,
    // since code === 1 and stdout is non-empty) and reads as a successful
    // search with partial output. This test pins both halves of that — the
    // `run` half lives here; the consequence for adapters is documented, not
    // asserted, since it is the adapter's policy to set, not `run`'s.
    const r = await run('node', ['-e', `process.stdout.write('a'.repeat(${MAX_OUTPUT_BYTES + 1024}))`], {
      timeout: 30_000,
    });
    expect(r.code).toBe(1);
    expect(r.stdout.length).toBe(MAX_OUTPUT_BYTES);
  });
});
/**
 * Stopping the planner has to reach the child, not merely stop waiting on it.
 * A research `bash` call can be a full test run; letting it serve out its own
 * 60-second timeout after the user pressed stop is the difference between the
 * abort being real and the abort being cosmetic.
 */
describe('run — an aborted planning turn kills the child', () => {
  it('resolves as soon as the signal aborts instead of waiting out the timeout', async () => {
    const controller = new AbortController();
    const started = Date.now();

    const running = run('node', ['-e', 'setTimeout(() => {}, 60_000)'], {
      timeout: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const r = await running;

    expect(Date.now() - started).toBeLessThan(TIMEOUT);
    expect(r.code).not.toBe(0);
  });

  it('does not spawn at all when the signal is already aborted', async () => {
    const r = await run('node', ['-e', "console.log('should not run')"], {
      timeout: TIMEOUT,
      signal: AbortSignal.abort(),
    });

    expect(r.stdout).not.toContain('should not run');
  });
});
