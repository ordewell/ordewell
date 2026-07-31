import React from 'react';

export interface DependencyOption {
  id: string;
  order: number;
  title: string;
}

interface DependencyPickerProps {
  /** The tasks that may precede this one — `dependencyCandidates`' answer, not this component's guess. */
  candidates: DependencyOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onDone?: () => void;
}

export default function DependencyPicker({ candidates, selected, onChange, onDone }: DependencyPickerProps) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className="task-dep-editor" onClick={(e) => e.stopPropagation()}>
      {candidates.length === 0 ? (
        <div className="task-dep-editor-empty">Nothing runs before this task, so it has no possible dependencies.</div>
      ) : (
        candidates.map((c) => (
          <label key={c.id} className="task-dep-option">
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="task-dep-option-order">#{c.order}</span>
            <span className="task-dep-option-title">{c.title}</span>
          </label>
        ))
      )}
      {onDone && <button className="task-dep-done" onClick={onDone}>Done</button>}
    </div>
  );
}
