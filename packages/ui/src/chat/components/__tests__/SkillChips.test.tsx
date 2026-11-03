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

  describe('add-skill select', () => {
    const catalog = [{ name: 'lint', description: 'Lint it' }, { name: 'docs', description: '' }];

    it('shows a disabled "Add skill…" prompt as the selected entry', () => {
      render(<SkillChips idPrefix="task" taskId="t1" catalog={catalog} onChange={vi.fn()} />);
      const select = screen.getByRole('combobox');
      expect(select).toHaveValue('');
      const prompt = screen.getByRole('option', { name: 'Add skill…' });
      expect(prompt).toBeDisabled();
    });

    it('adds the picked skill', () => {
      const onChange = vi.fn();
      render(<SkillChips idPrefix="task" taskId="t1" skills={['docs']} catalog={catalog} onChange={onChange} />);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lint' } });
      expect(onChange).toHaveBeenCalledWith('t1', ['docs', 'lint']);
    });

    it('adds nothing when the prompt value is selected', () => {
      const onChange = vi.fn();
      render(<SkillChips idPrefix="task" taskId="t1" catalog={catalog} onChange={onChange} />);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
