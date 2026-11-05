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
