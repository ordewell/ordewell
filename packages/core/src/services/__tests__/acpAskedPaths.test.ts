import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CLINE_PROFILE } from '../harness/clineProfile';
import { acpAsk } from '../harness/acpRoles';
import { decidePlannerPermission, decideReadOnlyTaskPermission } from '../harness/plannerPermissions';

// Cline's file reader opens a near match when the path it is given is missing
// (an entry whose name differs only by Unicode whitespace, NFD form or a curly
// apostrophe), so a missing path proves nothing about what is read.
describe('a path an ACP agent names only in its arguments', () => {
  function site() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'acp-asked-')));
    const ws = join(base, 'ws');
    const outside = join(base, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(join(outside, 'data.txt'), 'outside the workspace');
    writeFileSync(join(ws, 'readme.md'), 'inside');
    // The repository ships this link; its name has a no-break space.
    symlinkSync(join(outside, 'data.txt'), join(ws, 'notes .md'));
    return { ws };
  }

  const call = (path: string) => ({ toolCallId: 'c1', title: 'read_files', kind: 'read', rawInput: { files: [{ path }] } }) as never;

  it('is refused on a read-only task when it is not on disk, though its near match is', () => {
    const { ws } = site();
    const ask = acpAsk(call(join(ws, 'notes .md')), { profile: CLINE_PROFILE, cwd: ws });
    expect(ask.kind).toBe('other');
    expect(decideReadOnlyTaskPermission(ask, { cwd: ws, workspaceRoot: ws }).decision).toBe('deny');
  });

  it('is refused to a planner with nobody to ask, and says why', async () => {
    const { ws } = site();
    const ask = acpAsk(call(join(ws, 'notes .md')), { profile: CLINE_PROFILE, cwd: ws });
    const decision = await decidePlannerPermission(ask, {}, { workspaceRoot: ws });
    expect(decision).toEqual({ decision: 'deny', note: expect.stringContaining('not on disk') });
  });

  it('is still allowed when it exists inside the workspace', async () => {
    const { ws } = site();
    const ask = acpAsk(call(join(ws, 'readme.md')), { profile: CLINE_PROFILE, cwd: ws });
    expect(ask).toEqual({ kind: 'path', path: join(ws, 'readme.md'), directory: false });
    expect(decideReadOnlyTaskPermission(ask, { cwd: ws, workspaceRoot: ws }).decision).toBe('allow');
    expect((await decidePlannerPermission(ask, {}, { workspaceRoot: ws })).decision).toBe('allow');
  });
});

// Cline's read_files takes the first shape of its input union that validates
// and strips the keys that shape does not name. A range that is not a positive
// integer fails every `files` shape, so a later `paths` or `file_paths` shape
// is the one read; the approval is asked on the raw input all the same.
describe('a Cline read whose judged path is not the one Cline would read', () => {
  function site() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'acp-union-')));
    const ws = join(base, 'ws');
    mkdirSync(ws);
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(ws, 'readme.md'), 'inside');
    writeFileSync(join(base, 'outside', 'secret.txt'), 'outside the workspace');
    return { ws, decoy: join(ws, 'readme.md'), secret: join(base, 'outside', 'secret.txt') };
  }

  const call = (rawInput: unknown) => ({ toolCallId: 'c1', title: 'read_files', kind: 'read', rawInput }) as never;

  const shapes = (decoy: string, secret: string): Record<string, unknown> => ({
    'start_line 0 beside paths': { files: [{ path: decoy, start_line: 0 }], paths: [secret] },
    'end_line -1 beside file_paths': { files: [{ path: decoy, end_line: -1 }], file_paths: [secret] },
    'start_line 1.5 beside a paths string': { files: [{ path: decoy, start_line: 1.5 }], paths: secret },
    "start_line 'abc' beside paths": { files: [{ path: decoy, start_line: 'abc' }], paths: [secret] },
    'a root path with start_line 0 beside paths': { path: decoy, start_line: 0, paths: [secret] },
  });

  it('is refused on a read-only task', () => {
    const { ws, decoy, secret } = site();
    for (const [name, rawInput] of Object.entries(shapes(decoy, secret))) {
      const ask = acpAsk(call(rawInput), { profile: CLINE_PROFILE, cwd: ws });
      expect({ name, decision: decideReadOnlyTaskPermission(ask, { cwd: ws, workspaceRoot: ws }).decision }).toEqual({ name, decision: 'deny' });
    }
  });

  it('is refused to a planner with nobody to ask', async () => {
    const { ws, decoy, secret } = site();
    for (const [name, rawInput] of Object.entries(shapes(decoy, secret))) {
      const ask = acpAsk(call(rawInput), { profile: CLINE_PROFILE, cwd: ws });
      expect({ name, decision: (await decidePlannerPermission(ask, {}, { workspaceRoot: ws })).decision }).toEqual({ name, decision: 'deny' });
    }
  });

  it('is still allowed in the shape the recording shows, with positive or null bounds', async () => {
    const { ws, decoy } = site();
    for (const rawInput of [{ files: [{ path: decoy, start_line: 1, end_line: 20 }] }, { files: [{ path: decoy, start_line: null, end_line: null }] }, { path: decoy }]) {
      const ask = acpAsk(call(rawInput), { profile: CLINE_PROFILE, cwd: ws });
      expect(ask).toEqual({ kind: 'path', path: decoy, directory: false });
      expect(decideReadOnlyTaskPermission(ask, { cwd: ws, workspaceRoot: ws }).decision).toBe('allow');
      expect((await decidePlannerPermission(ask, {}, { workspaceRoot: ws })).decision).toBe('allow');
    }
  });
});
