import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyPatch, applyReply, applySavedPatch, linkInPatch, type ApplyPatchSite } from '../PatchCapture';
import type { GitInvoker } from '../gitExec';
import { createTask, type Task } from '../../models/Task';
import type { HandoffPatch, StoredHandoff } from '../../models/Handoff';
import type { TaskLogEvent } from '../../models/TaskLog';

/**
 * What `apply_patch` refuses before git runs, and how it answers (ADR-0050).
 * That a patch merges, at its base, past it, and into conflicts, is the e2e's
 * to show with real git (`PatchApply.e2e.test.ts`); here git is a seam that
 * fails the test if it is reached.
 */

const sha256 = (patch: Buffer) => createHash('sha256').update(patch).digest('hex');

const patchArtifact = (attempt: number, patch: Buffer, extra: Partial<HandoffPatch> = {}): HandoffPatch => ({
  kind: 'patch', path: `.ordewell/sessions/s/tasks/explore/${attempt}.patch`, attempt, base: 'a'.repeat(40), files: 2, added: 5, removed: 1, binary: 0, bytes: patch.length, sha256: sha256(patch), ...extra,
});

const handoff = (...artifacts: HandoffPatch[]): StoredHandoff => ({ summary: 'Tried it.', findings: [], findingCount: 0, artifacts });

const task = (id: string, order: number, extra: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...extra });

const plan = [
  task('explore', 1),
  task('build', 2, { dependencies: ['explore'] }),
  task('aside', 3),
];

const gitNeverRuns: GitInvoker = {
  exec: vi.fn(async () => { throw new Error('git must not run'); }),
  resolvePath: async () => '',
};

const files: Record<string, Buffer> = { 'explore/1': Buffer.from('one'), 'explore/2': Buffer.from('twotwo') };
const handoffs: Record<string, StoredHandoff> = {
  'explore/1': handoff(patchArtifact(1, files['explore/1'])),
  'explore/2': handoff(patchArtifact(2, files['explore/2'], { flags: [{ kind: 'dropped', count: 1, paths: ['big.bin (3 MiB)'] }] })),
};

function site(extra: Partial<ApplyPatchSite> = {}): ApplyPatchSite {
  return {
    callerId: 'build',
    plan,
    log: {
      attempts: (id) => (id === 'explore' ? [1, 2] : id === 'aside' ? [1] : []),
      events: (id, attempt): TaskLogEvent[] => (handoffs[`${id}/${attempt}`] ? [{ type: 'handoff', handoff: handoffs[`${id}/${attempt}`] } as TaskLogEvent] : []),
      patch: (id, attempt) => files[`${id}/${attempt}`],
    },
    worktrees: ['/work/build'],
    readOnly: false,
    git: gitNeverRuns,
    ...extra,
  };
}

const refusal = async (args: Parameters<typeof applySavedPatch>[0], extra: Partial<ApplyPatchSite> = {}) => {
  const reply = await applySavedPatch(args, site(extra));
  expect(reply.isError, reply.text).toBe(true);
  expect(gitNeverRuns.exec).not.toHaveBeenCalled();
  return reply.text;
};

describe('applySavedPatch refuses', () => {
  it('a call from a read-only task, which lands nothing', async () => {
    expect(await refusal({ task: '#1' }, { readOnly: true })).toContain('read-only task lands nothing');
  });

  it('a task with no worktree of its own, and one across several repositories', async () => {
    expect(await refusal({ task: '#1' }, { worktrees: [] })).toContain('no worktree of its own');
    expect(await refusal({ task: '#1' }, { worktrees: ['/work/a', '/work/b'] })).toContain('several repositories');
  });

  it('a patch from a task outside the set read reads, naming that set', async () => {
    const text = await refusal({ task: '#3' });

    expect(text).toContain('#3 Task aside is not a task this one may read');
    expect(text).toContain('#1 Task explore');
    expect(text).toContain('#2 Task build');
  });

  it('a task the plan does not have, and an attempt a task did not save', async () => {
    expect(await refusal({ task: 'nowhere' })).toContain('names no task in the plan');
    expect(await refusal({ task: '#1', attempt: 3 })).toContain('its saved attempts are 1 and 2');
  });

  it('a task whose attempt saved no patch, naming the attempts that did', async () => {
    const saved = { ...handoffs };
    handoffs['explore/2'] = { summary: 'Only talked.', findings: [], findingCount: 0 };
    try {
      expect(await refusal({ task: '#1' })).toContain('#1 Task explore saved no patch in attempt 2; its attempts that did are 1');
    } finally {
      Object.assign(handoffs, saved);
    }
  });

  it('a patch whose file is gone from the task logs', async () => {
    expect(await refusal({ task: '#1', attempt: 1 }, { log: { ...site().log, patch: () => undefined } })).toContain('no longer in this session\'s task logs');
  });

  it('a patch cut short, or changed since it was saved, by its size', async () => {
    const text = await refusal({ task: '#1', attempt: 1 }, { log: { ...site().log, patch: () => Buffer.from('on') } });

    expect(text).toContain('2 B where its artifact says 3 B');
    expect(text).toContain('cut short');
  });

  it('a patch that is the size it was saved at but not the bytes, by its hash', async () => {
    const text = await refusal({ task: '#1', attempt: 1 }, { log: { ...site().log, patch: () => Buffer.from('uno') } });

    expect(text).toContain('not the file that was saved');
    expect(text).toContain('changed after it was saved');
  });

  // A hostile patch is the case that matters, so it comes with an artifact that agrees with it: the size and the hash say it is the file that was saved.
  describe('a patch that would create a link or a submodule', () => {
    const hostile = (header: string) => Buffer.from(`diff --git a/evil b/evil\n${header}\nindex 0000000..e69de29\n--- /dev/null\n+++ b/evil\n@@ -0,0 +1 @@\n+/etc\n\\ No newline at end of file\n`);
    const saving = (patch: Buffer) => ({ log: { ...site().log, events: () => [{ type: 'handoff', handoff: handoff(patchArtifact(1, patch)) } as TaskLogEvent], patch: () => patch } });

    it.each([['new file mode 120000'], ['new file mode 0120000'], ['new file mode 120755'], ['new file mode 160000'], ['new mode 120000']])('is refused before git runs, for %s', async (header) => {
      const text = await refusal({ task: '#1', attempt: 1 }, saving(hostile(header)));

      expect(text).toContain('holds a link or a submodule');
      expect(text).toContain(header);
    });

    it('is refused by applyPatch itself, which any caller reaches', async () => {
      const patch = hostile('new file mode 120000');

      const result = await applyPatch(gitNeverRuns, '/work/build', patch, patchArtifact(1, patch));

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('holds a link or a submodule') });
      expect(gitNeverRuns.exec).not.toHaveBeenCalled();
    });
  });
});

describe('linkInPatch', () => {
  const section = (...headers: string[]) => Buffer.from(`diff --git a/x b/x\n${headers.join('\n')}\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`);

  it('allows what git writes of regular files: new, changed, deleted, renamed and a mode change', () => {
    for (const headers of [
      ['new file mode 100644', 'index 0000000..e69de29'],
      ['new file mode 100755', 'index 0000000..e69de29'],
      ['index 1111111..2222222 100644'],
      ['old mode 100644', 'new mode 100755', 'index 1111111..2222222'],
      ['deleted file mode 100644', 'index 1111111..0000000'],
      ['similarity index 90%', 'rename from y', 'rename to x', 'index 1111111..2222222 100644'],
    ]) expect(linkInPatch(section(...headers)), headers.join(' / ')).toBeUndefined();
  });

  it('allows deleting a link or a submodule, which the capture carries, and nothing else naming either', () => {
    expect(linkInPatch(section('deleted file mode 120000', 'index 1111111..0000000'))).toBeUndefined();
    expect(linkInPatch(section('deleted file mode 160000', 'index 1111111..0000000'))).toBeUndefined();
    expect(linkInPatch(section('old mode 120000', 'new mode 100644'))).toBe('old mode 120000');
    expect(linkInPatch(section('index 1111111..2222222 160000'))).toBe('index 1111111..2222222 160000');
  });

  it('refuses a mode it cannot tell is a regular file, since git reads any octal whose type bits say link', () => {
    for (const mode of ['120000', '0120000', '120755', '160000', '0100644', ' 100644', '100644 ', '100664', '']) {
      expect(linkInPatch(section(`new file mode ${mode}`)), JSON.stringify(mode)).toBe(`new file mode ${mode}`);
    }
  });

  it('reads headers by line, as git does, and nothing a hunk or a binary patch holds', () => {
    const text = Buffer.from('diff --git a/x b/x\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,3 @@\n+new file mode 120000\n+index 1111111..2222222 120000\n-old mode 120000\n');
    expect(linkInPatch(text)).toBeUndefined();
    // Not a line of its own: a carriage return does not start one for git.
    expect(linkInPatch(Buffer.from('diff --git a/x b/x\rnew file mode 120000\n'))).toBeUndefined();
  });
});

describe('applyReply', () => {
  const saved = patchArtifact(2, Buffer.from('twotwo'), { flags: [{ kind: 'dropped', count: 1, paths: ['big.bin (3 MiB)'] }] });
  const at = { head: 'b'.repeat(40), files: 2 };

  it('says a clean apply at the base staged its changes, and names what the patch left out', () => {
    const { text, isError } = applyReply({ kind: 'applied', sameBase: true, ...at }, '#1 Task explore', saved);

    expect(isError).toBeUndefined();
    expect(text).toContain("Applied #1 Task explore's patch (2 files, +5 -1) cleanly");
    expect(text).toContain('staged');
    expect(text).toContain('at the commit the patch was taken against');
    expect(text).toContain('Not as its author\'s worktree had it:');
    expect(text).toContain('big.bin (3 MiB)');
  });

  it('says a merge past the base was tested elsewhere, so the task runs its checks', () => {
    const { text } = applyReply({ kind: 'applied', sameBase: false, ...at }, '#1 Task explore', saved);

    expect(text).toContain('Your worktree is at commit bbbbbbbbbbbb, not aaaaaaaaaaaa');
    expect(text).toContain('run your checks here');
  });

  it('names each conflicted path, tells a binary one from one with markers, and is not an error: the rest is applied', () => {
    const { text, isError } = applyReply({
      kind: 'conflicted', sameBase: false, ...at, conflicts: [{ path: 'assets.bin', binary: true }, { path: 'src/greet.ts', binary: false }],
    }, '#1 Task explore', saved);

    expect(isError).toBeUndefined();
    expect(text).toContain('with 2 conflicted paths. The rest of it is in your worktree, staged.');
    expect(text).toContain('- assets.bin: binary, so the file holds no markers: `git checkout --ours -- assets.bin` keeps your version, `--theirs` takes the patch\'s');
    expect(text).toContain('- src/greet.ts: the file holds conflict markers');
  });

  it('says git stopped part way, which files it changed, and that nothing is staged, and is an error', () => {
    const { text, isError } = applyReply({ kind: 'stopped', reason: "error: unable to write file 'notes' mode 100644: Directory not empty", changed: ['src/added.ts', 'src/old.ts'] }, '#1 Task explore', saved);

    expect(isError).toBe(true);
    expect(text).toContain("Applied part of #1 Task explore's patch, then git stopped: error: unable to write file 'notes' mode 100644: Directory not empty.");
    expect(text).toContain('Nothing is staged.');
    expect(text).toContain('src/added.ts and src/old.ts');
    expect(text).toContain(saved.path);
  });

  it('names the patch file in a refusal, for a task that would rather apply part of it by hand', () => {
    const { text, isError } = applyReply({ kind: 'refused', reason: 'git applied none of it: error: gone.txt: patch does not apply.' }, '#1 Task explore', saved);

    expect(isError).toBe(true);
    expect(text).toBe(`Nothing applied: git applied none of it: error: gone.txt: patch does not apply. The patch is the file ${saved.path}, if you would rather apply part of it by hand.`);
  });
});
