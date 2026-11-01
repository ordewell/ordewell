import React, { useState, useRef, useEffect, useId, useMemo } from 'react';
import { aheadOfDraft, composerTip } from '@ordewell/core/plan-utils';
import { ALL_SLASH_COMMANDS, SLASH_COMMAND_NAMES, isBuiltinSlashCommand } from '../../../commands/slashCommands';
import { QUEUE_TITLE, SendKeyHint, isSendNowKey } from './PendingMessages';

interface SlashSuggestion {
  label: string;
  detail: string;
  insertText: string;
  kind?: 'skill';
}

export interface SkillEntry {
  name: string;
  description: string;
  appliesTo?: 'planner' | 'task';
}

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder?: string;
  /** A planner turn is in flight: with nothing typed the button stops it; with text typed, Enter queues it and Ctrl+Enter sends it now. A run is not the composer's to stop. */
  isTurnRunning?: boolean;
  /** Send now (ADR-0023, F5), on Ctrl+Enter; with no turn running the host sends it as a plain message. */
  onSendNow?: (text: string) => void;
  onStop?: () => void;
  /** Esc with no suggestion list open. True when the key was spent; otherwise it clears the input. */
  onEscape?: () => boolean;
  disabledReason?: string;
  prefill?: string;
  /** A state cue of the host's, drawn under the composer while it is empty (#137). */
  hint?: string;
  /** Queued text taken back from the host; it lands above the current draft. */
  unsent?: { text: string; seq: number } | null;
  /** Discovered skills (global ~/.ordewell/skills/ + workspace .ordewell/skills/) merged into the / suggestion dropdown. */
  skills?: SkillEntry[];
}

const COMMAND_SUGGESTIONS: readonly SlashSuggestion[] = ALL_SLASH_COMMANDS;

function toSkillSuggestion(skill: SkillEntry): SlashSuggestion {
  return { label: `/${skill.name}`, detail: skill.appliesTo === 'task' ? `task skill · ${skill.description}` : skill.description, insertText: `/${skill.name}`, kind: 'skill' };
}

/**
 * The leading `/word` of `text`, if `word` (case-insensitive) is a recognized
 * command or skill name — otherwise null. Used to highlight a matched
 * invocation and to decide whether to render the highlight mark at all; a
 * mistyped or unknown `/foo` gets no highlight.
 */
export function getLeadingSlashToken(text: string, knownNames: Set<string>): string | null {
  const match = text.match(/^\/(\S+)/);
  if (!match) return null;
  return knownNames.has(match[1].toLowerCase()) ? match[0] : null;
}

/** A `/word` token found anywhere in the prompt, whitespace- (or string-edge-) bounded. */
export interface SlashToken {
  /** Offset of this token's leading `/` in the text. */
  start: number;
  /** Offset immediately after the raw non-whitespace run following the `/`. */
  end: number;
  /** Lower-cased, with trailing `, . ! ? ; :` peeled off — what actually gets matched. */
  name: string;
  /** Offset immediately after `name`, before any trailing punctuation. */
  nameEnd: number;
}

const TRAILING_PUNCT = /[,.!?;:]+$/;

/**
 * Every `/word` token in `text`, bounded by whitespace or the string edges —
 * the same shape core's `resolveSkillInvocation` resolves, so a token offered
 * here for completion or highlighting is exactly one that loads a skill.
 */
export function slashTokens(text: string): SlashToken[] {
  const tokens: SlashToken[] = [];
  const re = /(^|\s)\/(\S*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index + match[1].length;
    const raw = match[2];
    const punct = raw.match(TRAILING_PUNCT)?.[0] ?? '';
    const nameLen = raw.length - punct.length;
    tokens.push({
      start,
      end: start + 1 + raw.length,
      name: raw.slice(0, nameLen).toLowerCase(),
      nameEnd: start + 1 + nameLen,
    });
  }
  return tokens;
}

/** The token the caret is actively composing — immediately after it, nothing typed past it yet. */
export function activeToken(text: string, cursor: number): SlashToken | null {
  return slashTokens(text).find((t) => t.end === cursor) ?? null;
}

/**
 * Whether `name` names a discovered skill exactly, or is a live prefix of one.
 * Never a built-in — only a discovered skill is ever loaded by a mid-prompt
 * token (see resolveSkillInvocation in core).
 */
export function skillMatchKind(name: string, skillNames: Set<string>): 'exact' | 'prefix' | null {
  if (name.length === 0) return null;
  if (skillNames.has(name)) return 'exact';
  for (const known of skillNames) {
    if (known.startsWith(name)) return 'prefix';
  }
  return null;
}

/**
 * Highlight ranges (offsets into `text`) for every recognized `/word` token:
 * the leading token keeps its existing rule (any known command or skill,
 * exact match only), while any other token in the message is skills-only,
 * live-prefix-matched — mirroring the TUI. A skill name repeated verbatim
 * only highlights its first occurrence, matching resolveSkillInvocation.
 */
export function highlightSpans(
  text: string,
  knownNames: Set<string>,
  skillNames: Set<string>,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const leading = getLeadingSlashToken(text, knownNames);
  // A leading *skill* token falls through to the loop below instead, so a
  // repeat of that same skill later in the message is deduped against it —
  // only a leading built-in (which never expands, so can't collide with a
  // later repeat) keeps the always-on, un-deduped highlight.
  const leadingIsSkill = leading !== null
    && skillMatchKind(leading.slice(1).toLowerCase(), skillNames) === 'exact';
  if (leading && !leadingIsSkill) spans.push({ start: 0, end: leading.length });

  const expandedExact = new Set<string>();
  for (const token of slashTokens(text)) {
    const kind = skillMatchKind(token.name, skillNames);
    if (kind === null) continue;
    if (kind === 'exact') {
      if (expandedExact.has(token.name)) continue;
      expandedExact.add(token.name);
    }
    spans.push({ start: token.start, end: token.nameEnd });
  }
  return spans;
}

/** Splits `text` into plain-text and `<mark>`-wrapped React nodes for `spans`. */
function markSpans(text: string, spans: Array<{ start: number; end: number }>): React.ReactNode {
  if (spans.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, i) => {
    if (span.start > cursor) parts.push(text.slice(cursor, span.start));
    parts.push(<mark key={i}>{text.slice(span.start, span.end)}</mark>);
    cursor = span.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** `text` with the token at `[token.start, token.end)` replaced by `/name ` in place. */
function spliceToken(text: string, token: SlashToken, name: string): { text: string; cursor: number } {
  const completed = `/${name} `;
  return {
    text: text.slice(0, token.start) + completed + text.slice(token.end),
    cursor: token.start + completed.length,
  };
}

export default function ChatInput({
  onSend,
  disabled,
  placeholder,
  isTurnRunning = false,
  onSendNow,
  onStop,
  onEscape,
  disabledReason,
  prefill,
  unsent,
  skills = [],
  hint,
}: ChatInputProps) {
  const [text, setText] = useState('');
  // The caret offset into `text` — tracked separately from `text` itself since
  // it can move (click, arrow keys) without the text changing, and a mid-prompt
  // skill token is only "active" (eligible for a hint/highlight-while-typing)
  // while the caret sits immediately after it.
  const [cursor, setCursor] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // A caret position to apply once React has re-rendered the textarea with new
  // text — e.g. after splicing a selected skill in place mid-prompt, where the
  // caret must land right after the inserted name rather than at wherever it
  // ends up by default.
  const pendingCursorRef = useRef<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  // True only when the selection changed via the keyboard, so we auto-scroll the
  // highlighted row into view for arrow-key navigation but NOT on mouse hover
  // (hovering a row that's already under the cursor must never move the list).
  const scrollOnSelectRef = useRef(false);
  // Which command tip the empty composer shows (#137). It moves on only when the
  // text is emptied, so a tip stays put while the user reads it.
  const [tipSeq, setTipSeq] = useState(0);
  const hadTextRef = useRef(false);
  const descriptionId = useId();

  // What the empty composer says: a live status or disabled reason when there
  // is one, the command tip otherwise (#137). The placeholder draws it, and a
  // visually hidden description exposes the same words to assistive technology.
  const placeholderText = disabled && disabledReason
    ? disabledReason
    : placeholder || composerTip(tipSeq, SLASH_COMMAND_NAMES) || 'Type / for commands or describe what you want to build...';
  // A hint belongs where the tip does: an empty composer. Typing is its own
  // answer, and the cue would only compete with the draft.
  const shownHint = text === '' ? hint : undefined;
  // Only the reason outlives a draft: the tip describes an empty composer, and
  // with text in it that description would be about something not shown.
  const descriptionText = disabled && disabledReason
    ? disabledReason
    : text !== ''
      ? ''
      : shownHint ? `${placeholderText} ${shownHint}` : placeholderText;

  // The `/word` the caret is actively composing when it is *not* at the very
  // start of the message — e.g. "explain this bug /gri" with the caret right
  // after "gri". Null whenever the message starts with `/`, so that case keeps
  // going through the unchanged leading-command branch below, combined-list
  // and all.
  const midToken = useMemo(
    () => (text.startsWith('/') ? null : activeToken(text, cursor)),
    [text, cursor],
  );

  const suggestions = useMemo<SlashSuggestion[]>(() => {
    if (!text.startsWith('/')) {
      // Anywhere else in the message, only a discovered skill can ever be
      // loaded (see resolveSkillInvocation in core) — never a built-in.
      if (!midToken) return [];
      return skills.map(toSkillSuggestion).filter((s) => s.label.slice(1).toLowerCase().startsWith(midToken.name));
    }
    const lower = text.toLowerCase();

    const all = [...COMMAND_SUGGESTIONS, ...skills.map(toSkillSuggestion)];
    return all.filter((s) => s.label.toLowerCase().startsWith(lower));
  }, [text, midToken, skills]);

  // Command names (without the leading slash) plus discovered skill names —
  // the set the leading `/word` of the input is checked against to decide
  // whether it gets highlighted as a recognized invocation.
  const knownNames = useMemo(() => {
    const names = COMMAND_SUGGESTIONS.map((s) => s.label.slice(1).split(' ')[0].toLowerCase());
    return new Set([...names, ...skills.map((s) => s.name.toLowerCase())]);
  }, [skills]);

  const skillNames = useMemo(() => new Set(skills.map((s) => s.name.toLowerCase())), [skills]);

  const highlightRanges = useMemo(
    () => highlightSpans(text, knownNames, skillNames),
    [text, knownNames, skillNames],
  );

  const showSuggestions = suggestions.length > 0 && (text.startsWith('/') || midToken !== null);

  useEffect(() => {
    setSelectedIdx(0);
  }, [suggestions]);

  useEffect(() => {
    // Only scroll for keyboard navigation. On hover the row is already visible,
    // and scrolling it would yank the list out from under the cursor.
    if (!scrollOnSelectRef.current) return;
    scrollOnSelectRef.current = false;
    if (showSuggestions && suggestionsRef.current && selectedIdx >= 0) {
      const el = suggestionsRef.current.querySelector('.slash-suggestion-item.selected');
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx, showSuggestions]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  // Keeps the highlight backdrop's scroll position glued to the textarea's own
  // when the input grows past its max height and starts scrolling internally —
  // otherwise the highlighted span would drift out from under the typed text.
  const syncBackdropScroll = () => {
    if (backdropRef.current && textareaRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // A new tip, status or disabled reason is a new placeholder, which can need
  // a different height.
  useEffect(() => {
    autoResize();
  }, [text, placeholderText]);

  // The panel can narrow without React re-rendering, wrapping the same
  // placeholder onto more rows. Width is not state, so observe the field's box;
  // a height change here re-fires with the same width and is ignored.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next === undefined || next === width) return;
      width = next;
      autoResize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (hadTextRef.current && text === '') setTipSeq((seq) => seq + 1);
    hadTextRef.current = text !== '';
  }, [text]);

  // Applies a caret position queued by a mid-prompt splice, once React has
  // committed the new text to the textarea — setSelectionRange before that
  // would be clamped against the stale (pre-splice) value.
  useEffect(() => {
    if (pendingCursorRef.current === null) return;
    const pos = pendingCursorRef.current;
    pendingCursorRef.current = null;
    textareaRef.current?.setSelectionRange(pos, pos);
    setCursor(pos);
  }, [text]);

  useEffect(() => {
    if (prefill !== undefined && prefill !== null) {
      setText(prefill);
      textareaRef.current?.focus();
    }
  }, [prefill]);

  useEffect(() => {
    if (!unsent) return;
    setText((draft) => aheadOfDraft(unsent.text, draft));
    pendingCursorRef.current = unsent.text.length;
    textareaRef.current?.focus();
  }, [unsent]);

  const canSend = !disabled && text.trim().length > 0;
  const canSubmit = isTurnRunning || canSend;
  // A live planner turn and something typed: Enter queues it for the turn's
  // end, Ctrl+Enter stops the turn and sends it ahead of the queue.
  const canSendNow = !!onSendNow && isTurnRunning && canSend;
  // A built-in command is the host's either way, never held, so neither key
  // the hint names would apply to it.
  const queues = canSendNow && !isBuiltinSlashCommand(text.trim());
  // Stop only while a turn is live and nothing is typed, so typing a message
  // always turns the button back into Send — as the task log's composer does.
  // A run alone never makes it Stop: the run has its own control.
  const stops = isTurnRunning && !canSend;

  const sendNow = () => {
    if (!canSendNow) return;
    onSendNow!(text.trim());
    setText('');
  };

  // Splices a chosen skill into the token being composed mid-prompt, leaving
  // the rest of the message untouched and keeping the message open for more
  // typing — unlike a leading command, there is no "whole message" to send yet.
  const applyMidPromptSkill = (s: SlashSuggestion) => {
    if (!midToken) return;
    const { text: spliced, cursor: newCursor } = spliceToken(text, midToken, s.label.slice(1));
    pendingCursorRef.current = newCursor;
    setText(spliced);
  };

  // Acts on a suggestion: a mid-prompt skill is spliced in, and a command or
  // leading skill is sent as typed.
  const selectSuggestion = (s: SlashSuggestion | undefined) => {
    if (!s) return;
    if (midToken) {
      applyMidPromptSkill(s);
      return;
    }
    onSend(s.insertText);
    setText('');
  };

  // `canSubmit` is also true for a Stop button with nothing typed; the button
  // stops on click, but Enter comes here and must not send an empty prompt.
  const handleSubmit = () => {
    if (disabled || !text.trim()) return;
    onSend(text.trim());
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        scrollOnSelectRef.current = true;
        setSelectedIdx((prev) => Math.min(suggestions.length - 1, prev + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        scrollOnSelectRef.current = true;
        setSelectedIdx((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const sel = suggestions[selectedIdx];
        // Mid-prompt: splice the skill in and keep composing, never send —
        // there is more of the message left to type around it.
        if (midToken && sel) {
          applyMidPromptSkill(sel);
          return;
        }
        if (sel && sel.insertText !== text) {
          setText(sel.insertText);
        } else {
          handleSubmit();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const sel = suggestions[selectedIdx];
        if (midToken && sel) {
          applyMidPromptSkill(sel);
        } else if (sel) {
          setText(sel.insertText);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (!onEscape?.()) setText('');
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isSendNowKey(e) && canSendNow) {
        sendNow();
        return;
      }
      handleSubmit();
    }
  };

  const renderedSuggestions = () => suggestions.map((s, i) => (
    <div
      key={s.label}
      className={`slash-suggestion-item ${s.kind ?? ''} ${i === selectedIdx ? 'selected' : ''}`}
      onMouseEnter={() => setSelectedIdx(i)}
      onMouseDown={(e) => {
        e.preventDefault();
        selectSuggestion(s);
        if (textareaRef.current) textareaRef.current.focus();
      }}
    >
      <span className="slash-suggestion-label">{s.insertText}</span>
      <span className="slash-suggestion-detail">{s.detail}</span>
    </div>
  ));

  return (
    <div className={`chat-input ${disabled ? 'disabled' : ''}`}>
      {showSuggestions && (
        <div className="slash-suggestions" ref={suggestionsRef}>
          <div className="slash-suggestions-header">
            {midToken ? 'Skills: type / to filter' : 'Commands: type / to filter'}
          </div>
          {renderedSuggestions()}
          <div className="slash-suggestions-footer">
            ↑↓ navigate  {midToken ? 'Tab · Enter insert' : 'Tab complete · Enter run'}  Esc cancel
          </div>
        </div>
      )}
      <div className="chat-input-wrapper">
        <div className="chat-input-inner">
          <div className="chat-input-row">
            <div className="chat-input-highlight-wrap">
              <div className="chat-input-highlight-backdrop" ref={backdropRef} aria-hidden="true">
                {markSpans(text, highlightRanges)}
              </div>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => { setText(e.target.value); setCursor(e.target.selectionStart ?? e.target.value.length); }}
                onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
                onClick={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
                onKeyUp={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
                onKeyDown={handleKeyDown}
                onScroll={syncBackdropScroll}
                placeholder={placeholderText}
                aria-label="Message the planner"
                aria-describedby={descriptionText ? descriptionId : undefined}
                disabled={disabled}
                rows={1}
              />
            </div>
            <button
              className={`send-btn${stops ? ' processing' : ''}`}
              onClick={stops && onStop ? onStop : handleSubmit}
              disabled={!canSubmit}
              title={stops ? 'Stop (Esc Esc)' : disabled && disabledReason ? disabledReason : queues ? QUEUE_TITLE : 'Send (Enter)'}
              type="button"
            >
              {stops ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                  <rect x="0" y="0" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2 8L14 2L8 14L6.5 9.5L2 8Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          {queues && <SendKeyHint />}
          {shownHint && <div className="chat-input-hint">{shownHint}</div>}
        </div>
        {/* Once aria-label names the field, its placeholder is drawn only; this keeps what it says in the accessible description (#137). */}
        <span id={descriptionId} className="visually-hidden">{descriptionText}</span>
      </div>
    </div>
  );
}
