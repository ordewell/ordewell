import { useEffect, useState } from 'react';

const GROUP_FROM = 10_000;
const digitsOf = (text: string): string => text.replace(/\D/g, '');
// A fixed locale: the grouping typed is a comma, and the field must read the same on every machine.
const grouped = (n: number): string => (n >= GROUP_FROM ? n.toLocaleString('en-US') : String(n));

/**
 * What a field commits for the digits it holds: nothing typed, or less than
 * `min`, is `min`, and more than `max` is `max`. Without a `max` the daemon
 * enforces no ceiling, so a number too large to count exactly is clamped to
 * the last one that can be.
 */
export function committedCount(text: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const digits = digitsOf(text).replace(/^0+(?=\d)/, '');
  if (digits === '') return min;
  if (digits.length > String(Number.MAX_SAFE_INTEGER).length) return max;
  return Math.min(Math.max(Number(digits), min), max);
}

/**
 * A whole number from `min` to `max`, sent on Enter or blur. It is a text input of
 * digits, not `type=number`: no spinner, no `e` or sign, and a value that is
 * not allowed is never left standing: the field shows what was committed.
 */
function NumberField({ label, value, min, max, hint, busy, onCommit }: {
  label: string;
  value: number;
  min: number;
  max?: number;
  hint(n: number): string;
  busy: boolean;
  onCommit(n: number): void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => setDraft(String(value)), [value]);
  const pending = committedCount(draft, min, max);
  const commit = (): void => {
    setDraft(String(pending));
    if (pending !== value) onCommit(pending);
  };
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <span className="settings-number">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={focused || draft === '' ? draft : grouped(Number(draft))}
          disabled={busy}
          onFocus={() => setFocused(true)}
          onChange={(event) => setDraft(digitsOf(event.target.value))}
          onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
          onBlur={() => { setFocused(false); commit(); }}
        />
        <span className="settings-hint">{hint(pending)}</span>
      </span>
    </label>
  );
}

export default NumberField;
