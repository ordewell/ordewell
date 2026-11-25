import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { StoredHandoff } from '@ordewell/core';
import TaskHandoff from '../TaskHandoff';

/*
 * What a done task's landing changed, as VS Code and the desktop show its
 * handoff: Ordewell's count from git, ahead of the runner's own account, which
 * may say otherwise.
 */
describe('a task\'s handoff, with what its landing changed', () => {
  it('heads the handoff with the files and lines git counted, before the finding count', () => {
    const handoff: StoredHandoff = { summary: 'Only added lines.', findings: [], findingCount: 0, change: { files: 1, added: 1, removed: 1, binary: 0 } };
    render(<TaskHandoff handoff={handoff} />);

    expect(document.querySelector('.task-handoff-heading')?.textContent).toBe('Handoff · 1 file, +1 -1 · no findings');
  });

  it('says no count for a handoff that has none', () => {
    render(<TaskHandoff handoff={{ summary: 'Read it.', findings: [], findingCount: 0 }} />);

    expect(document.querySelector('.task-handoff-heading')?.textContent).toBe('Handoff · no findings');
  });
});
