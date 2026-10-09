import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SkillChips from '../SkillChips';

describe('SkillChips unresolved attachments', () => {
  it.each(['task', 'subtask'])('keeps unresolved %s names visible and removable', (idPrefix) => {
    const onChange = vi.fn();
    render(<SkillChips idPrefix={idPrefix} taskId="t1" skills={['not-created']} catalog={[]} onChange={onChange} />);
    expect(screen.getByText('not-created')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove skill not-created' }));
    expect(onChange).toHaveBeenCalledWith('t1', []);
  });

  it('keeps unresolved names visible while editing is locked', () => {
    render(<SkillChips idPrefix="task" taskId="t1" skills={['not-created']} catalog={[]} />);
    expect(screen.getByText('not-created')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
