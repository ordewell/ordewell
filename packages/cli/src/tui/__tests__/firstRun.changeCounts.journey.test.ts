import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { patient } from '@ordewell/core/testing';
import { stripAnsi } from '../ansi';
import { render } from '../render';
import type { TuiState } from '../state';
import { firstRunBRun, git, README, type FirstRunBRun, type RunTui } from './firstRunBRun';

/*
 * Machine B's first run (slug changeCounts), in the terminal UI over the real
 * daemon on a real repository. The task that documented --shout added a line
 * to README.md and also deleted its `# hello` heading; nothing the user was
 * shown said a line had gone, and the only account of the change was the
 * runner's own summary. Decided: wherever a done task is shown (its row's
 * peek, its handoff block, the list before the merge) the TUI shows the files
 * it changed and the lines added and removed, which Ordewell counts from git,
 * removals included: "1 file, +1 -1".
 */

const WAIT = { timeout: patient(20_000) };
/** A number, "file" or "files", a comma, then +N and -M. */
const COUNTS = /\b(\d+) files?, \+(\d+) -(\d+)\b/;
const THIS_CHANGE = /\b1 file, \+1 -1\b/;
/**
 * The runner's words for what it did, which are wrong and never mention the
 * heading it removed: shown as its summary, but not where the counts come from.
 */
const RUNNERS_WORDS = 'Documented --shout in the README: touched three files and only added lines.';

/** The screen as text, its rows joined so a phrase wrapped across two reads whole. */
const screen = (state: TuiState): string => render(state).map(stripAnsi)
  .map((line) => line.replace(/[│┃|]/g, ' '))
  .join(' ').replace(/\s+/g, ' ');

let machine: FirstRunBRun;
let tui: RunTui;
/** The Run handoff the TUI opened as the run ended: the list of what landed, before any merge. */
let atHandoff: TuiState;
const TASK = 's1-t1';

beforeAll(async () => {
  machine = await firstRunBRun();
  machine.draft('s1', [{
    id: TASK,
    title: 'Document --shout in the README',
    change: {
      summary: RUNNERS_WORDS,
      edit: (worktree) => {
        const readme = join(worktree, 'README.md');
        writeFileSync(readme, `${readFileSync(readme, 'utf8').replace('# hello\n', '')}Run python hello.py --shout to shout.\n`);
      },
    },
  }]);
  tui = machine.tui();
  await tui.run({ type: 'loadSession', sessionId: 's1' });
  tui.typed('/run');
  await vi.waitFor(() => {
    expect(tui.state().handoff?.landed).toHaveLength(1);
    expect(tui.state().overlay?.kind).toBe('handoff');
    expect(tui.state().tasks.find((t) => t.id === TASK)?.status).toBe('completed');
  }, WAIT);
  atHandoff = tui.state();
}, patient(30_000));

afterAll(async () => {
  await machine?.close();
});

describe('machine B, changeCounts: the staged change', () => {
  it('is one file, one line added and the heading removed, as git counts it', () => {
    const branch = atHandoff.handoff!.repos[0].integrationBranch;
    const base = atHandoff.handoff!.repos[0].baseRef;
    expect(git(machine.workspace, 'diff', '--numstat', base, branch).trim().split(/\s+/)).toEqual(['1', '1', 'README.md']);
    expect(README.startsWith('# hello\n')).toBe(true);
  });
});

describe('machine B, changeCounts: a done task, wherever the terminal UI shows it', () => {
  it('shows its files and lines in the task row\'s peek', () => {
    const peek = screen({ ...atHandoff, overlay: null, focus: 'plan', selectedTask: 0, expandedTaskId: TASK });

    expect(peek).toMatch(COUNTS);
    expect(peek).toMatch(THIS_CHANGE);
  });

  it('shows its files and lines in its handoff block', async () => {
    tui.press('escape');
    tui.typed('/open 1');
    await vi.waitFor(() => {
      expect(tui.state().taskView?.taskId).toBe(TASK);
      expect(tui.state().taskView?.loaded).toBe(true);
    }, WAIT);

    const block = screen(tui.state());

    expect(block).toContain('Documented --shout in the README');
    expect(block).toMatch(THIS_CHANGE);
  });

  it('shows its files and lines in the list before the merge', () => {
    const list = screen(atHandoff);

    expect(list).toContain('Landed on it');
    expect(list).toMatch(THIS_CHANGE);
  });

  it('counts from git, not from the runner\'s words, and counts the removal', () => {
    const shown = [
      screen({ ...atHandoff, overlay: null, focus: 'plan', selectedTask: 0, expandedTaskId: TASK }),
      screen(atHandoff),
    ].join(' ');

    const counted = [...shown.matchAll(new RegExp(COUNTS, 'g'))].map((m) => m.slice(1).map(Number));
    expect(counted.length).toBeGreaterThan(0);
    for (const counts of counted) expect(counts).toEqual([1, 1, 1]);
  });
});
