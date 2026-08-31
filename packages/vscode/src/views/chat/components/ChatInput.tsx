import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { AiProvider } from '@ordewell/core';

// Core owns the union; a hand-copied duplicate diverged the moment ADR-0009
// added the three harness planners.
type ApiProvider = AiProvider;

interface SlashSuggestion {
  label: string;
  detail: string;
  insertText: string;
  id?: string;
  provider?: string;
  kind?: 'provider' | 'back' | 'hint' | 'model' | 'skill';
  providerId?: ApiProvider;
}

export interface SkillEntry {
  name: string;
  description: string;
}

interface ModelOption {
  id: string;
  label: string;
  provider: string;
  apiProvider?: ApiProvider;
  description?: string;
  pricing?: string;
}

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder?: string;
  modelOptions?: ModelOption[];
  configuredProviders?: ApiProvider[];
  isProcessing?: boolean;
  onStop?: () => void;
  disabledReason?: string;
  queueCount?: number;
  prefill?: string;
  /** Discovered skills (global ~/.ordewell/skills/ + workspace .ordewell/skills/) merged into the / suggestion dropdown. */
  skills?: SkillEntry[];
}

const PROVIDER_LABELS: Record<ApiProvider, string> = {
  openrouter: 'OpenRouter',
  google: 'Gemini',
  openai_compatible: 'Custom',
  openai: 'OpenAI',
  xai: 'xAI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  together: 'Together',
  mistral: 'Mistral',
  anthropic: 'Anthropic',
  fireworks: 'Fireworks',
  perplexity: 'Perplexity',
  zhipu: 'Zhipu',
  kimi: 'Kimi',
  cerebras: 'Cerebras',
  deepinfra: 'DeepInfra',
  doubao: 'Doubao',
  qwen: 'Qwen',
  hunyuan: 'Hunyuan',
  baichuan: 'Baichuan',
  minimax: 'MiniMax',
  yi: 'Yi',
  stepfun: 'StepFun',
  siliconflow: 'SiliconFlow',
  cohere: 'Cohere',
  novita: 'Novita',
};



function groupByProvider(items: SlashSuggestion[]): Map<string, SlashSuggestion[]> {
  const grouped = new Map<string, SlashSuggestion[]>();
  for (const item of items) {
    const provider = item.provider || 'Other';
    if (!grouped.has(provider)) grouped.set(provider, []);
    grouped.get(provider)!.push(item);
  }
  return grouped;
}

const COMMAND_SUGGESTIONS: SlashSuggestion[] = [
  { label: '/planner', detail: 'Choose who plans — an API provider or a coding agent (no API key)', insertText: '/planner' },
  { label: '/model', detail: 'Show model configuration', insertText: '/model' },
  { label: '/model set ', detail: 'Pick orchestrator model', insertText: '/model set ' },
  { label: '/planner-effort', detail: "Thinking effort for a coding-agent planner", insertText: '/planner-effort' },
  { label: '/key set ', detail: 'Set an API key (OpenRouter or Google)', insertText: '/key set ' },
  { label: '/sessions', detail: 'Browse and load saved sessions', insertText: '/sessions' },
  { label: '/new', detail: 'Start a new session (clears current plan)', insertText: '/new' },
  { label: '/allowlist', detail: 'Restrict which models the planner may auto-assign per runner', insertText: '/allowlist' },
  { label: '/refresh', detail: 'Re-discover runner models (e.g. after enabling an opencode backend)', insertText: '/refresh' },
  { label: '/auto', detail: 'Toggle autonomous mode for new plans', insertText: '/auto' },
  { label: '/help', detail: 'Show all available commands', insertText: '/help' },
];

function toModelSuggestion(opt: ModelOption): SlashSuggestion {
  // Always surface the serving API so collisions (same model on both APIs) are
  // unambiguous in the dropdown.
  const via = opt.apiProvider ? ` · via ${PROVIDER_LABELS[opt.apiProvider]}` : '';
  return {
    label: opt.label,
    detail: `${opt.id}${opt.pricing ? ' · $' + opt.pricing + '/MTok' : ''}${via}`,
    insertText: opt.label,
    id: opt.id,
    provider: opt.provider,
    providerId: opt.apiProvider,
    kind: 'model',
  };
}

function matchesSearch(s: SlashSuggestion, term: string): boolean {
  if (!term) return true;
  return s.label.toLowerCase().includes(term) || s.detail.toLowerCase().includes(term);
}

function toSkillSuggestion(skill: SkillEntry): SlashSuggestion {
  return { label: `/${skill.name}`, detail: skill.description, insertText: `/${skill.name}`, kind: 'skill' };
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
 * the same shape core's `resolveSkillInvocation` splices against, so a token
 * offered here for completion or highlighting is exactly one that expands.
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
 * Never a built-in — only a discovered skill's content is ever spliced into a
 * mid-prompt token (see resolveSkillInvocation in core).
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
  modelOptions,
  configuredProviders = [],
  isProcessing = false,
  onStop,
  disabledReason,
  queueCount = 0,
  prefill,
  skills = [],
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
  // The API provider chosen in step 1 of the two-step picker (null = step 1).
  const [pickerProvider, setPickerProvider] = useState<ApiProvider | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  // Whether the user has actively chosen an item in the suggestion list (arrow keys / hover).
  // Used to decide, on Enter, between applying the highlighted model and opening the picker.
  const navigatedRef = useRef(false);
  // True only when the selection changed via the keyboard, so we auto-scroll the
  // highlighted row into view for arrow-key navigation but NOT on mouse hover
  // (hovering a row that's already under the cursor must never move the list).
  const scrollOnSelectRef = useRef(false);

  const isModelCommand = text.startsWith('/model set');

  // Filter text typed after the command word, e.g. "sonnet" in "/model set sonnet".
  const modelFilterTerm = isModelCommand ? text.trim().split(/\s+/).slice(2).join(' ') : '';

  // Reset the picker's provider context whenever we leave a model command.
  useEffect(() => {
    if (!isModelCommand) setPickerProvider(null);
  }, [isModelCommand]);

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
      // spliced in (see resolveSkillInvocation in core) — never a built-in.
      if (!midToken) return [];
      return skills.map(toSkillSuggestion).filter((s) => s.label.slice(1).toLowerCase().startsWith(midToken.name));
    }
    const lower = text.toLowerCase();

    if (isModelCommand) {
      const searchTerm = modelFilterTerm.toLowerCase();
      const allModels = (modelOptions ?? []).map(toModelSuggestion);

      if (configuredProviders.length === 0) {
        return [{ label: 'No API keys configured', detail: 'Run "Configure API Key" first', insertText: text, kind: 'hint' }];
      }

      // One provider → skip step 1 entirely. Two providers → use the chosen one.
      const effective = pickerProvider ?? (configuredProviders.length === 1 ? configuredProviders[0] : null);

      // Step 1: no provider chosen yet — offer the configured providers.
      if (!effective) {
        return configuredProviders.map<SlashSuggestion>((p) => ({
          label: `Use ${PROVIDER_LABELS[p]} models`,
          detail: p === 'openrouter' ? '200+ models via OpenRouter' : 'Native Gemini models',
          insertText: text,
          kind: 'provider',
          providerId: p,
        }));
      }

      // Step 2: models for the chosen provider, with a back affordance when
      // there was a real choice to go back to.
      const models = allModels
        .filter((s) => s.providerId === effective)
        .filter((s) => matchesSearch(s, searchTerm));
      const list: SlashSuggestion[] = [];
      if (configuredProviders.length >= 2) {
        list.push({ label: '← Back to providers', detail: '', insertText: text, kind: 'back' });
      }
      list.push(...models);
      return list;
    }

    const all = [...COMMAND_SUGGESTIONS, ...skills.map(toSkillSuggestion)];
    return all.filter((s) => s.label.toLowerCase().startsWith(lower));
  }, [text, midToken, isModelCommand, modelFilterTerm, modelOptions, configuredProviders, pickerProvider, skills]);

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

  // Special entries (provider picks, back, hints) render flat above the model
  // list; only actual model rows get grouped under their model-provider header.
  const specialEntries = useMemo(
    () => suggestions.filter((s) => s.kind === 'provider' || s.kind === 'back' || s.kind === 'hint'),
    [suggestions],
  );
  const groupedSuggestions = useMemo(() => {
    if (!isModelCommand) return null;
    return groupByProvider(suggestions.filter((s) => s.kind === 'model'));
  }, [suggestions, isModelCommand]);

  const showSuggestions = suggestions.length > 0 && (text.startsWith('/') || midToken !== null);

  useEffect(() => {
    // Default-highlight the first actionable row, skipping a leading "back"
    // entry so step 2 lands on a model rather than the way out.
    const firstActionable = suggestions.findIndex((s) => s.kind !== 'back' && s.kind !== 'hint');
    setSelectedIdx(firstActionable >= 0 ? firstActionable : 0);
    navigatedRef.current = false;
  }, [suggestions]);

  useEffect(() => {
    // Only scroll for keyboard navigation. On hover the row is already visible,
    // and scrolling it would yank the list out from under the cursor.
    if (!scrollOnSelectRef.current) return;
    scrollOnSelectRef.current = false;
    if (showSuggestions && suggestionsRef.current && selectedIdx >= 0) {
      // Query the actually-selected row: children of the container are the
      // header, group wrappers, and footer — not a flat index of model rows.
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

  useEffect(() => {
    autoResize();
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

  const canSubmit = isProcessing || (!disabled && text.trim().length > 0);

  const applyModel = (id: string) => {
    onSend(`/model set ${id}`);
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

  // Acts on a suggestion: provider entries advance to step 2, the back entry
  // returns to step 1, model rows send the command, command rows are sent as-is.
  const selectSuggestion = (s: SlashSuggestion | undefined) => {
    if (!s) return;
    if (midToken) {
      applyMidPromptSkill(s);
      return;
    }
    if (s.kind === 'provider') {
      setPickerProvider(s.providerId ?? null);
      navigatedRef.current = false;
      return;
    }
    if (s.kind === 'back') {
      setPickerProvider(null);
      navigatedRef.current = false;
      return;
    }
    if (s.kind === 'hint') return;
    if (s.id) {
      applyModel(s.id);
      return;
    }
    onSend(s.insertText);
    setText('');
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (isModelCommand) {
      // Models can only be SET by selecting from the list (applyModel), never by
      // committing free-typed text. Any typed text is just a filter; submitting
      // the command opens the picker so the user picks a real entry.
      const parts = text.split(/\s+/);
      const cmd = parts.slice(0, 2).join(' ');
      onSend(cmd);
      setText('');
      return;
    }
    onSend(text.trim());
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigatedRef.current = true;
        scrollOnSelectRef.current = true;
        setSelectedIdx((prev) => Math.min(suggestions.length - 1, prev + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigatedRef.current = true;
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
        // Provider / back / hint entries always act on their own (advancing or
        // returning a step), regardless of navigation state.
        if (sel && (sel.kind === 'provider' || sel.kind === 'back' || sel.kind === 'hint')) {
          selectSuggestion(sel);
          return;
        }
        // Bare model command highlighting a model row with no filter typed and
        // no explicit selection: submit the command so the extension opens the
        // picker, rather than silently applying whichever model is highlighted.
        if (isModelCommand && !modelFilterTerm && !navigatedRef.current && (!sel || sel.kind === 'model')) {
          handleSubmit();
        } else if (sel?.id) {
          applyModel(sel.id);
        } else if (sel && sel.insertText !== text) {
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
        } else if (sel && (sel.kind === 'provider' || sel.kind === 'back')) {
          selectSuggestion(sel);
        } else if (sel?.id) {
          setText(`${modelCmdPrefix(text)} ${sel.id}`);
        } else if (sel && sel.kind !== 'hint') {
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const getPlaceholderText = () => {
    if (disabled) return 'Generating plan...';
    return placeholder || 'Type / for commands or describe what you want to build...';
  };

  const renderSuggestionRow = (s: SlashSuggestion, flatIdx: number) => (
    <div
      key={s.label}
      className={`slash-suggestion-item ${s.kind ?? ''} ${flatIdx === selectedIdx ? 'selected' : ''}`}
      onMouseEnter={() => { navigatedRef.current = true; setSelectedIdx(flatIdx); }}
      onMouseDown={(e) => {
        e.preventDefault();
        selectSuggestion(s);
        if (textareaRef.current) textareaRef.current.focus();
      }}
    >
      <span className="slash-suggestion-label">{s.label}</span>
      <span className="slash-suggestion-detail">{s.detail}</span>
    </div>
  );

  const renderedSuggestions = () => {
    if (isModelCommand) {
      const hasGroups = groupedSuggestions && groupedSuggestions.size > 0;
      if (specialEntries.length === 0 && !hasGroups) return null;
      return (
        <>
          {specialEntries.map((s) => renderSuggestionRow(s, suggestions.indexOf(s)))}
          {hasGroups && Array.from(groupedSuggestions!.entries()).map(([provider, items]) => (
            <div key={provider} className="slash-suggestions-group">
              <div className="slash-suggestions-group-header">{provider}</div>
              {items.map((s) => renderSuggestionRow(s, suggestions.indexOf(s)))}
            </div>
          ))}
        </>
      );
    }

    return suggestions.map((s, i) => (
      <div
        key={s.label}
        className={`slash-suggestion-item ${s.kind ?? ''} ${i === selectedIdx ? 'selected' : ''}`}
        onMouseEnter={() => { navigatedRef.current = true; setSelectedIdx(i); }}
        onMouseDown={(e) => {
          e.preventDefault();
          if (midToken) {
            applyMidPromptSkill(s);
          } else if (s.id) {
            applyModel(s.id);
          } else {
            onSend(s.insertText);
            setText('');
          }
          if (textareaRef.current) textareaRef.current.focus();
        }}
      >
        <span className="slash-suggestion-label">{isModelCommand ? s.label : s.insertText}</span>
        <span className="slash-suggestion-detail">{s.detail}</span>
      </div>
    ));
  };

  return (
    <div className={`chat-input ${disabled ? 'disabled' : ''}`}>
      {queueCount > 0 && (
        <div className="queue-badge chat-input-queue-badge">
          <span className="queue-dot" /> {queueCount} message{queueCount > 1 ? 's' : ''} queued
        </div>
      )}
      {showSuggestions && (
        <div className="slash-suggestions" ref={suggestionsRef}>
          <div className="slash-suggestions-header">
            {isModelCommand
              ? 'Select a model — type to filter, Enter to pick'
              : midToken ? 'Skills — type / to filter' : 'Commands — type / to filter'}
          </div>
          {renderedSuggestions()}
          <div className="slash-suggestions-footer">
            ↑↓ navigate  {isModelCommand ? 'Enter apply · Tab fill' : midToken ? 'Tab · Enter insert' : 'Tab complete · Enter run'}  Esc cancel
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
                placeholder={getPlaceholderText()}
                disabled={disabled}
                rows={1}
              />
            </div>
            <button
              className={`send-btn${isProcessing ? ' processing' : ''}`}
              onClick={isProcessing && onStop ? onStop : handleSubmit}
              disabled={!canSubmit}
              title={isProcessing ? 'Stop (Ctrl+C)' : disabled && disabledReason ? disabledReason : 'Send (Enter)'}
              type="button"
            >
              {isProcessing ? (
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
        </div>
      </div>
    </div>
  );
}
