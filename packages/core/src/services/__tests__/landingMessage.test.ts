import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { landingMessage, messageArgs, quotedMessageArgs, runMergeMessage } from '../landingMessage';
import { storedHandoff } from '../../models/Handoff';

describe('landingMessage', () => {
  it('does not say Merge twice for a subject that already says it, as a child plan\'s landing does', () => {
    expect(landingMessage('merge', { title: 'Import', commit: { subject: 'Merge: Add parseCsv' } })).toBe('Merge: Add parseCsv');
  });

  const stated = { title: 'Add greeting', commit: { subject: 'Greet the user on start', body: 'The banner was empty.\nNow it says hi.' } };

  it('writes the stated subject and body on the work and its landing merge', () => {
    expect(landingMessage('work', stated)).toBe('Greet the user on start\n\nThe banner was empty.\nNow it says hi.');
    expect(landingMessage('merge', stated)).toBe('Merge: Greet the user on start\n\nThe banner was empty.\nNow it says hi.');
  });

  it('names the task in a repair merge by its subject alone', () => {
    expect(landingMessage('repair-merge', stated)).toBe('Merge: Greet the user on start (resolve conflicts with integration)');
  });

  it('names a rescue and the merge that restores it for the task, with no stated body', () => {
    expect(landingMessage('rescue', stated)).toBe('WIP: Greet the user on start\n\nWork left uncommitted when its worktree was removed, kept so that nothing is lost.');
    expect(landingMessage('restore-merge', stated)).toBe('Merge: Greet the user on start (resume its kept work)');
  });

  it('falls back to the first line of the title when no commit was stated', () => {
    const untitled = { title: '  Add greeting  \nand more' };
    expect(landingMessage('work', untitled)).toBe('Add greeting');
    expect(landingMessage('merge', untitled)).toBe('Merge: Add greeting');
    expect(landingMessage('repair-merge', untitled)).toBe('Merge: Add greeting (resolve conflicts with integration)');
  });
});

describe('runMergeMessage', () => {
  it('names one task by its subject, several by the first and a line each, in the order given', () => {
    expect(runMergeMessage([{ title: 'Add alpha', commit: { subject: 'Greet', body: 'Not repeated.' } }])).toBe('Merge: Greet');
    expect(runMergeMessage([{ title: 'Add alpha' }, { title: 'Add beta\nmore' }, { title: 'Add gamma' }])).toBe('Merge: Add alpha and 2 more\n\n- Add alpha\n- Add beta\n- Add gamma');
  });

  it('still names the change when no task is known, and takes the trailer like the rest', () => {
    expect(runMergeMessage([], true)).toBe('Merge planned changes\n\nPlanned-with: Ordewell');
    expect(runMergeMessage([{ title: 'A' }, { title: 'B' }], true)).toBe('Merge: A and 1 more\n\n- A\n- B\n\nPlanned-with: Ordewell');
  });
});

describe('landingMessage with the Planned-with trailer', () => {
  const stated = { title: 'Add greeting', commit: { subject: 'Greet the user on start', body: 'The banner was empty.' } };

  const trailerOf = (message: string): string => execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' });

  it.each(['work', 'merge', 'repair-merge', 'rescue', 'restore-merge'] as const)('ends a %s message with the trailer as its own paragraph', (kind) => {
    const message = landingMessage(kind, stated, true);
    expect(message.endsWith('\n\nPlanned-with: Ordewell')).toBe(true);
    expect(trailerOf(message)).toBe('Planned-with: Ordewell\n');
  });

  it('adds nothing when the setting is off, which is how a message is written unless asked', () => {
    expect(landingMessage('merge', stated, false)).toBe('Merge: Greet the user on start\n\nThe banner was empty.');
    expect(landingMessage('merge', stated)).toBe(landingMessage('merge', stated, false));
  });

  it('carries the trailer on a message with no body', () => {
    const message = landingMessage('merge', { title: 'Add greeting' }, true);
    expect(message).toBe('Merge: Add greeting\n\nPlanned-with: Ordewell');
    expect(trailerOf(message)).toBe('Planned-with: Ordewell\n');
  });

  it('joins a body that already ends in trailers instead of starting a second block git would not read with it', () => {
    const signed = { title: 'T', commit: { subject: 'S', body: 'Why.\n\nSigned-off-by: A <a@x.y>' } };
    const message = landingMessage('work', signed, true);
    expect(message).toBe('S\n\nWhy.\n\nSigned-off-by: A <a@x.y>\nPlanned-with: Ordewell');
    expect(trailerOf(message)).toBe('Signed-off-by: A <a@x.y>\nPlanned-with: Ordewell\n');
  });

  it('keeps a body of one Token: value line as prose, as the stored handoff does, so the trailer starts its own paragraph', () => {
    const commit = storedHandoff({ status: 'done', summary: '', commit: { subject: 'S', body: 'Why: the old check ran on every start.' } })!.commit!;
    const message = landingMessage('work', { title: 'T', commit }, true);
    expect(message).toBe('S\n\nWhy: the old check ran on every start.\n\nPlanned-with: Ordewell');
    expect(trailerOf(message)).toBe('Planned-with: Ordewell\n');
  });

  it('does not repeat a trailer the stated body already carries', () => {
    const said = { title: 'T', commit: { subject: 'S', body: 'Planned-with: Ordewell' } };
    expect(landingMessage('work', said, true)).toBe('S\n\nPlanned-with: Ordewell');
  });

  it('reaches git as one -m per paragraph with the trailer last', () => {
    expect(messageArgs(landingMessage('merge', stated, true)).slice(-2)).toEqual(['-m', 'Planned-with: Ordewell']);
  });
});

describe('messageArgs', () => {
  it('passes each paragraph as its own -m, keeping the lines inside one', () => {
    expect(messageArgs('Subject\n\nLine one\nLine two\n\n\nTrailer: x')).toEqual(['-m', 'Subject', '-m', 'Line one\nLine two', '-m', 'Trailer: x']);
  });
});

describe.skipIf(process.platform === 'win32')('quotedMessageArgs', () => {
  it('reads back as the same arguments in a POSIX shell, quotes and all', () => {
    const message = "Merge: Fix the user's \"greeting\" $HOME `id`\n\nBody; with & and \\ too";
    const read = execFileSync('sh', ['-c', `set -- ${quotedMessageArgs(message)}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
    expect(read.split('\0').slice(0, -1)).toEqual(['-m', "Merge: Fix the user's \"greeting\" $HOME `id`", '-m', 'Body; with & and \\ too']);
  });
});
