import React, { useState, type ReactNode } from 'react';
import type { Message } from '@ordewell/core';
import { activityIcon, outcomeLabel, type Activity } from '../activity';

export type { Activity };

interface ChatMessageProps {
  message?: Message;
  role?: 'user' | 'planner' | 'system';
  isQueued?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
  /** The planner turn is still streaming — thinking blocks render open with live text. */
  streaming?: boolean;
  interrupted?: boolean;
  activities?: Activity[];
}

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A thinking dropdown. Collapsed by default — including while its text is
 * still streaming in (the title shows "Thinking…" as the live signal).
 * The title toggles it; clicking anywhere in the opened text collapses it.
 */
function ThinkingBlock({ activity, streaming, label = 'Thinking' }: { activity: Activity; streaming: boolean; label?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`activity-think${open ? ' expanded' : ''}`}>
      <button
        className="activity-think-toggle"
        onClick={() => setOpen(!open)}
      >
        <span className="activity-think-chevron">{open ? '▼' : '▶'}</span>
        {label}{streaming ? '…' : ''}
      </button>
      {open && (
        <div className="activity-think-body" onClick={() => setOpen(false)} title="Click to collapse">
          <pre className="activity-think-pre">{activity.text.trim()}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * A spawned research subagent's own process, nested inside the planner's
 * timeline (opencode-style). Collapsed by default; expands to the subagent's
 * own tool calls (rendered through ActivityBlock, so nested thinking is
 * itself independently expandable) plus its final digest.
 */
function SubagentBlock({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const children = activity.children ?? [];

  return (
    <div className={`activity-subagent${open ? ' expanded' : ''}`}>
      <button className="activity-subagent-toggle" onClick={() => setOpen(!open)}>
        <span className="activity-subagent-chevron">{open ? '▼' : '▶'}</span>
        <span className="activity-subagent-icon">{activityIcon(activity)}</span>
        <span className="activity-subagent-label">Subagent: {activity.text}</span>
        {!activity.done && <span className="activity-subagent-badge">running…</span>}
      </button>
      {open && (
        <div className="activity-subagent-body">
          {children.map((child) => (
            <ActivityBlock key={child.id} activity={child} streaming={false} />
          ))}
          {activity.resultText && (
            <ThinkingBlock activity={{ id: `${activity.id}-digest`, type: 'thinking', text: activity.resultText }} streaming={false} label="Digest" />
          )}
        </div>
      )}
    </div>
  );
}

function ActivityBlock({ activity, streaming }: { activity: Activity; streaming: boolean }) {
  if (activity.type === 'thinking') {
    return <ThinkingBlock activity={activity} streaming={streaming} />;
  }
  if (activity.type === 'subagent') {
    return <SubagentBlock activity={activity} />;
  }
  return <ToolCallBlock activity={activity} />;
}

/**
 * A command execution: one line, spinner while pending, outcome icon and
 * summary once done. The result body expands under a chevron — the same
 * affordance a subagent's digest uses, so "what did that command actually
 * return?" is answerable without leaving the chat.
 */
function ToolCallBlock({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const label = outcomeLabel(activity.outcome);
  const expandable = !!activity.resultText;

  // The glyph alone did not separate a refused `rm` from a successful one at a
  // glance; the outcome also drives colour, through this attribute.
  const outcome = activity.done ? (activity.outcome ?? 'success') : 'pending';

  return (
    <div className={`activity-tool-call${open ? ' expanded' : ''}`} data-outcome={outcome}>
      <button
        className="activity-tool-toggle"
        onClick={() => expandable && setOpen(!open)}
        disabled={!expandable}
        title={expandable ? (open ? 'Hide output' : 'Show output') : activity.text}
      >
        {/* A call with nothing to expand still reserves the chevron column, or
            rows with and without output would not line up. */}
        {expandable
          ? <span className="activity-tool-chevron">{open ? '▼' : '▶'}</span>
          : <span className="activity-tool-chevron-spacer" aria-hidden="true" />}
        <span className="activity-tool-icon">{activityIcon(activity)}</span>
        <span className="activity-tool-name">{activity.text}</span>
        {label && <span className="activity-tool-outcome">{label}</span>}
      </button>
      {open && activity.resultText && (
        <div className="activity-tool-body" onClick={() => setOpen(false)} title="Click to collapse">
          <pre className="activity-tool-pre">{activity.resultText}</pre>
        </div>
      )}
    </div>
  );
}

export default function ChatMessage({ message, role: _explicitRole, isQueued, children, actions, streaming, interrupted, activities }: ChatMessageProps) {
  if (!message) return null;

  const isSystem = message.role === 'system';
  const isUser = message.role === 'user';
  const trimmedContent = isUser ? message.content : message.content.trim();
  const content = isUser ? trimmedContent : renderMarkdown(trimmedContent);
  // Prose still streaming in is not yet a message: it is the model narrating
  // (or emitting plan JSON), so it renders as a live thinking dropdown and
  // only becomes the message text once the turn finalizes.
  const liveProse: Activity | null = !isUser && streaming && trimmedContent
    ? { id: 'live-prose', type: 'thinking', text: message.content }
    : null;
  const effectiveActivities = liveProse ? [...(activities ?? []), liveProse] : (activities ?? []);
  const showContent = !streaming && !!trimmedContent;
  const isEmptyStreamingTurn = streaming && effectiveActivities.length === 0;

  const classNames = [
    'chat-msg',
    `chat-msg-${message.role}`,
    interrupted ? 'chat-msg-interrupted' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classNames}>
      {isQueued && isUser && (
        <span className="chat-msg-queued-badge">queued</span>
      )}
      {isSystem ? (
        <span className="chat-msg-content">{message.content}</span>
      ) : (
        <>
          <div className="chat-msg-bubble">
            {/* Activities (thinking, command executions) come first — they happen
                before the planner's message text, and the order is preserved. */}
            {effectiveActivities.length > 0 && (
              <div className="chat-msg-activities">
                {effectiveActivities.map((act, i) => (
                  <ActivityBlock
                    key={act.id}
                    activity={act}
                    streaming={!!streaming && i === effectiveActivities.length - 1}
                  />
                ))}
              </div>
            )}
            {isEmptyStreamingTurn && (
              <div className="chat-msg-content chat-msg-working">
                <span className="chat-msg-spinner" /> Working&hellip;
              </div>
            )}
            {showContent && (
              <div
                className="chat-msg-content"
                dangerouslySetInnerHTML={isUser ? undefined : { __html: content }}
              >
                {isUser ? content : undefined}
              </div>
            )}
            {!isUser && children && (
              <div className="chat-msg-artifacts">
                {children}
              </div>
            )}
            {interrupted && (
              <span className="chat-msg-interrupted-label">Interrupted</span>
            )}
            {!isUser && !streaming && <span className="chat-msg-time">{formatTime(message.timestamp)}</span>}
          </div>
          {isUser && <span className="chat-msg-time">{formatTime(message.timestamp)}</span>}
          {actions && (
            <div className="chat-msg-actions">
              {actions}
            </div>
          )}
        </>
      )}
    </div>
  );
}
