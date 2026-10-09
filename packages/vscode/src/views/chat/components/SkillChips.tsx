import React from 'react';

interface SkillChipsProps {
  idPrefix: string;
  taskId: string;
  skills?: string[];
  catalog?: { name: string; description: string }[];
  /** Absent when the task cannot be edited: the chips then only display. */
  onChange?: (taskId: string, skills: string[]) => void;
}

export default function SkillChips({ idPrefix, taskId, skills = [], catalog = [], onChange }: SkillChipsProps) {
  const addable = catalog.filter((s) => !skills.includes(s.name));
  if (skills.length === 0 && !(onChange && addable.length > 0)) return null;

  const canAdd = Boolean(onChange) && addable.length > 0;

  return (
    <div className="model-selector task-skills" style={{ marginTop: '8px' }}>
      <label htmlFor={canAdd ? `${idPrefix}-skill-${taskId}` : undefined}>Skills</label>
      <div className="task-skill-chips">
        {skills.map((name) => (
          <span key={name} className="task-skill-chip" title={catalog.find((s) => s.name === name)?.description}>
            {name}
            {onChange && (
              <button type="button" className="task-skill-chip-remove" aria-label={`Remove skill ${name}`}
                onClick={() => onChange(taskId, skills.filter((s) => s !== name))}>×</button>
            )}
          </span>
        ))}
        {canAdd && (
          <select id={`${idPrefix}-skill-${taskId}`} className="task-skill-add" value=""
            onChange={(e) => { if (e.target.value) onChange?.(taskId, [...skills, e.target.value]); }}>
            <option value="">+ skill</option>
            {addable.map((s) => (
              <option key={s.name} value={s.name}>{s.description ? `${s.name} — ${s.description}` : s.name}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
