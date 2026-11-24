import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patient } from '@ordewell/core/testing';
import type { TuiState } from '../state';
import { messagesOf } from './chat';
import { firstRunBRun, type FirstRunBRun, type MachineSettings, type RunTui, type ScriptedChange } from './firstRunBRun';

/*
 * Machine B's first run (slug mergeMoment), in the terminal UI over the real
 * daemon on a real repository. At /merge the user saw "Merged" twice, once
 * from the reply to their merge and once from the daemon's own notice of it,
 * and only learned from `git log` that the merge commit carried a
 * `Planned-with: Ordewell` line. Decided: one "Merged" line; and the first
 * merge on a machine that would write the trailer says so in its
 * confirmation, with the way to turn it off, once per machine, never with the
 * trailer off, and as a notice beside the merge when merging is automatic.
 */

const WAIT = { timeout: patient(20_000) };
const TRAILER = 'Planned-with: Ordewell';
const TURN_OFF = 'ordewell trailer off';

const shout: ScriptedChange = {
  summary: 'Added --shout, which prints the greeting in upper case, and a test for it.',
  edit: (worktree) => {
    writeFileSync(join(worktree, 'hello.py'), [
      'import sys', '', 'greeting = "hello"', 'print(greeting.upper() if "--shout" in sys.argv else greeting)', '',
    ].join('\n'));
    writeFileSync(join(worktree, 'test_hello.py'), 'import subprocess\n\n\ndef test_shout():\n    assert subprocess.check_output(["python", "hello.py", "--shout"]).strip() == b"HELLO"\n');
  },
};
const documented: ScriptedChange = {
  summary: 'Documented --shout in the README.',
  edit: (worktree) => {
    const readme = join(worktree, 'README.md');
    writeFileSync(readme, `${readFileSync(readme, 'utf8')}Run python hello.py --shout to shout.\n`);
  },
};

let run: FirstRunBRun | undefined;

afterEach(async () => {
  await run?.close();
  run = undefined;
});

async function machineB(settings: MachineSettings = {}): Promise<FirstRunBRun> {
  run = await firstRunBRun(settings);
  return run;
}

/** A drafted plan of one task, run with /run until the run hands its work over. */
async function ranToHandoff(machine: FirstRunBRun, sessionId: string, change: ScriptedChange, title: string): Promise<RunTui> {
  machine.draft(sessionId, [{ id: `${sessionId}-t1`, title, change }]);
  const tui = machine.tui();
  await tui.run({ type: 'loadSession', sessionId });
  tui.typed('/run');
  await vi.waitFor(() => {
    expect(tui.state().handoff?.landed).toHaveLength(1);
    expect(tui.state().status).toBe('idle');
  }, WAIT);
  return tui;
}

/** `/merge`, then Merge in its overlay: what it asks before anything merges. */
function askToMerge(tui: RunTui): Extract<NonNullable<TuiState['overlay']>, { kind: 'confirm' }> {
  if (tui.state().overlay) tui.press('escape');
  expect(tui.state().overlay).toBeNull();
  tui.typed('/merge');
  expect(tui.state().overlay?.kind).toBe('handoff');
  tui.press('enter');
  const overlay = tui.state().overlay;
  if (overlay?.kind !== 'confirm') throw new Error(`expected the merge confirmation, got ${JSON.stringify(overlay)}`);
  return overlay;
}

const confirmationText = (overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'confirm' }>): string => JSON.stringify(overlay);

/** Yes to the merge, waited out until both the reply to it and the daemon's broadcast of it have reached the reducer. */
async function confirmMerge(tui: RunTui): Promise<string[]> {
  const before = messagesOf(tui.state()).length;
  const replies: Promise<unknown>[] = [];
  const mergeRun = tui.api.mergeRun.bind(tui.api);
  vi.spyOn(tui.api, 'mergeRun').mockImplementation((...args) => {
    const reply = mergeRun(...args);
    replies.push(reply.catch(() => undefined));
    return reply;
  });
  tui.press('enter');
  await vi.waitFor(() => {
    expect(replies).toHaveLength(1);
    expect(tui.actions.some((a) => a.type === 'runMessage' && a.message.type === 'isolation_merge')).toBe(true);
  }, WAIT);
  await replies[0];
  await new Promise((resolve) => setTimeout(resolve, 300));
  return messagesOf(tui.state()).slice(before).map((m) => m.text);
}

describe('machine B, mergeMoment: /merge in the terminal UI', () => {
  it('shows exactly one "Merged" line, with both the reply and the daemon\'s merge notice in play', async () => {
    const machine = await machineB();
    const tui = await ranToHandoff(machine, 's1', shout, 'Add --shout to hello.py');
    askToMerge(tui);

    const said = await confirmMerge(tui);

    // The key phrase as the merge's notice words it, and no second line announcing the same merge ("You merged …").
    expect(said.filter((line) => /\bMerged\b/.test(line))).toHaveLength(1);
    expect(said.filter((line) => /\bmerged\b/i.test(line))).toHaveLength(1);
  });
});

describe('machine B, mergeMoment: the Planned-with trailer at the merge', () => {
  it('is named in the confirmation of the first merge on this machine that would write it, with the way to turn it off', async () => {
    const machine = await machineB();
    const tui = await ranToHandoff(machine, 's1', shout, 'Add --shout to hello.py');

    const asked = confirmationText(askToMerge(tui));

    expect(asked).toContain(TRAILER);
    expect(asked).toContain(TURN_OFF);
  });

  it('is not named again in the second merge on the same machine', async () => {
    const machine = await machineB();
    const first = await ranToHandoff(machine, 's1', shout, 'Add --shout to hello.py');
    expect(confirmationText(askToMerge(first))).toContain(TRAILER);
    await confirmMerge(first);

    const second = await ranToHandoff(machine, 's2', documented, 'Document --shout');
    const asked = confirmationText(askToMerge(second));

    expect(asked).not.toContain(TRAILER);
    expect(asked).not.toContain(TURN_OFF);
  });

  it('is never named with the trailer setting off', async () => {
    const machine = await machineB({ plannedWithTrailer: false });
    const tui = await ranToHandoff(machine, 's1', shout, 'Add --shout to hello.py');

    const asked = confirmationText(askToMerge(tui));

    expect(asked).not.toContain(TRAILER);
    expect(asked).not.toContain(TURN_OFF);
  });

  it('arrives once as a notice beside the merge when merging is automatic, with no confirmation asked', async () => {
    const machine = await machineB({ mergeAtGatesAutomatically: true });
    machine.draft('s1', [{ id: 's1-t1', title: 'Add --shout to hello.py', change: shout }]);
    const tui = machine.tui();
    await tui.run({ type: 'loadSession', sessionId: 's1' });

    tui.typed('/run');
    await vi.waitFor(() => {
      expect(tui.actions.some((a) => a.type === 'runMessage' && a.message.type === 'isolation_merge')).toBe(true);
      expect(tui.state().status).toBe('idle');
    }, WAIT);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(tui.state().overlay?.kind).not.toBe('confirm');
    const told = messagesOf(tui.state()).map((m) => m.text).filter((line) => line.includes(TRAILER));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(TURN_OFF);
  });
});
