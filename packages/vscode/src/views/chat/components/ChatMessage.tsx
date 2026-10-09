import React, { useState } from 'react';
import type {
  ApprovalBlock, ApprovalDecision, ApprovalKind, ApprovalSource, DisplayBlock, MessageBlock, PlanBlock, SkillLoadBlock, SubagentBlock, SubagentStatus,
  ThinkingDisplayBlock, ToolBlock, ToolStatus, DiffRow, DiffStat,
} from '@ordewell/core';
import { diffRows, diffSummary, loadedSkillTokens, outputLines, outputPreview } from '@ordewell/core/plan-utils';

/*
 * The planner conversation (#51 display blocks) as the webview draws it.
 * Whether thinking, command and subagent blocks show their detail is one
 * switch for the whole conversation, like the TUI's ctrl+o — so no block here
 * opens on its own.
 */

const PREVIEW_LINES = 3;
// A diff is read rather than skimmed, so its preview runs longer than a command's.
const DIFF_PREVIEW_ROWS = 10;

// One word with a slash and no scheme: a file path, whose end is the part
// worth keeping when the row is too narrow. A URL keeps its host instead.
const PATH_LIKE = /^(?![a-z][a-z0-9+.-]*:\/\/)\S*\/\S*$/i;

// The text is a model's, and can be steered by what it read: quotes are
// escaped so nothing leaves the href, and only a web URL becomes a link.
export function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export default function ChatMessage({ block }: { block: MessageBlock }) {
  if (block.role === 'system' || block.role === 'error') {
    return (
      <div className={`chat-msg chat-msg-${block.role}`}>
        <span className="chat-msg-content">{block.text}</span>
      </div>
    );
  }
  if (block.role === 'user') {
    return (
      <div className="chat-msg chat-msg-user">
        <div className="chat-msg-bubble">
          <div className="chat-msg-content">{block.skills ? <SkillMarkedText text={block.text} skills={block.skills} /> : block.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`chat-msg chat-msg-planner${block.streaming ? ' streaming' : ''}`}>
      <div className="chat-msg-bubble">
        <div className="chat-msg-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text.trim()) }} />
        {block.streaming && <span className="chat-msg-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}

/** The user's text with each `/name` that loaded a skill marked, as the composer marks one being typed. */
function SkillMarkedText({ text, skills }: { text: string; skills: readonly string[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const token of loadedSkillTokens(text, skills)) {
    parts.push(text.slice(at, token.start), <mark key={token.start} className="skill-token">{text.slice(token.start, token.end)}</mark>);
    at = token.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function skillLoadText(block: SkillLoadBlock): string {
  if (block.attaches) return `/${block.name} will be attached to fitting tasks`;
  return block.invokedBy === 'planner' ? `${block.name} skill loaded by planner` : `/${block.name} skill loaded`;
}

function SkillLoadNotice({ block }: { block: SkillLoadBlock }) {
  return (
    <div className="chat-msg chat-msg-system chat-msg-skill-load">
      <span className="chat-msg-content">
        <span className="skill-load-mark">●</span> {skillLoadText(block)} · <bdi className="skill-load-path" title={block.path}>{block.path}</bdi>
      </span>
    </div>
  );
}

export function ThinkingBlock({ block, expanded }: { block: ThinkingDisplayBlock; expanded: boolean }) {
  const text = block.text.trim();
  return (
    <div className={`activity-think${expanded ? ' expanded' : ''}`}>
      <div className="activity-think-head">
        <span className="activity-think-label">Thinking{block.streaming ? '…' : ''}</span>
        {!expanded && <span className="activity-think-line">{text.split('\n')[0]}</span>}
      </div>
      {expanded && <pre className="activity-think-pre">{text}</pre>}
    </div>
  );
}

const STATUS_ICON: Record<ToolStatus, string> = {
  pending: '⚙',
  ok: '✓',
  error: '✗',
  denied: '⊘',
  interrupted: '–',
};

// `status` alone reads a refused command and a denied path the same way; the
// finer outcome says which.
function outcomeLabel(block: ToolBlock): string {
  if (block.outcome && block.outcome !== 'success') return block.outcome === 'not_executed' ? 'not executed' : block.outcome;
  return block.status === 'interrupted' ? 'interrupted' : '';
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

const DIFF_SIGN: Record<DiffRow['kind'], string> = { added: '+', removed: '-', context: ' ', gap: '' };

function moreLines(count: number): string {
  return `+${count} line${count === 1 ? '' : 's'}`;
}

/** An edit as an editor shows one: what it changed, then its lines numbered and marked. */
function DiffView({ output, diff, expanded }: { output: string; diff: DiffStat; expanded: boolean }) {
  const rows = diffRows(output);
  const shown = expanded ? rows : rows.slice(0, DIFF_PREVIEW_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <>
      <div className="diff-summary">{diffSummary(diff)}</div>
      <div className="diff-view">
        {shown.map((row, i) => (row.kind === 'gap'
          ? <div key={i} className="diff-gap">⋮</div>
          : (
            <div key={i} className="diff-line" data-kind={row.kind}>
              <span className="diff-num">{row.line}</span>
              <span className="diff-sign">{DIFF_SIGN[row.kind]}</span>
              <span className="diff-text">{row.text}</span>
            </div>
          )))}
      </div>
      {hidden > 0 && <span className="cmd-row-more">{moreLines(hidden)}</span>}
    </>
  );
}

export function CommandRow({ block, expanded }: { block: ToolBlock; expanded: boolean }) {
  const label = outcomeLabel(block);
  const preview = outputPreview(block.output, PREVIEW_LINES);
  const { keyArg } = block.headline;
  const path = PATH_LIKE.test(keyArg);
  const diff = block.diff && block.status === 'ok' ? block.diff : null;
  return (
    <div className={`cmd-row${expanded ? ' expanded' : ''}`} data-status={block.status}>
      <div className="cmd-row-header">
        <span className="cmd-row-icon">{STATUS_ICON[block.status]}</span>
        <code className="cmd-row-head">
          <span className="cmd-row-name">{block.headline.name}(</span>
          <span className={`cmd-row-arg${path ? ' path' : ''}`} title={path ? keyArg : undefined}><bdi>{keyArg}</bdi></span>
          <span className="cmd-row-name">)</span>
        </code>
        {label && <span className="cmd-row-outcome">{label}</span>}
      </div>
      {diff ? <DiffView output={block.output} diff={diff} expanded={expanded} /> : expanded ? (
        <>
          <pre className="cmd-row-args">{prettyArgs(block.args)}</pre>
          {block.output && <pre className="cmd-row-output">{outputLines(block.output).join('\n')}</pre>}
        </>
      ) : preview.lines.length > 0 && (
        <>
          <pre className="cmd-row-preview">{preview.lines.join('\n')}</pre>
          {preview.hiddenLineCount > 0 && <span className="cmd-row-more">{moreLines(preview.hiddenLineCount)}</span>}
        </>
      )}
    </div>
  );
}

const SUBAGENT_STATUS: Record<SubagentStatus, string> = {
  running: 'running…',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

export function SubagentCard({ block, expanded }: { block: SubagentBlock; expanded: boolean }) {
  return (
    <div className={`subagent-card${expanded ? ' expanded' : ''}`} data-status={block.status}>
      <div className="subagent-card-header">
        <span className="subagent-card-title">Agent</span>
        <span className="subagent-card-brief">{block.brief}</span>
        {block.model && <span className="subagent-card-model">{block.model}</span>}
        <span className="subagent-card-status">{SUBAGENT_STATUS[block.status]}</span>
      </div>
      {expanded && block.children.length > 0 && (
        <div className="subagent-card-steps">
          {block.children.map((child) => <Block key={child.id} block={child} expanded onShowPlan={noop} />)}
        </div>
      )}
      {block.digest && <div className="subagent-card-digest">{block.digest}</div>}
    </div>
  );
}

function planLabel(block: PlanBlock): string {
  if (block.status === 'building') return 'Building plan…';
  const count = block.taskCount === undefined ? '' : ` · ${block.taskCount} task${block.taskCount === 1 ? '' : 's'}`;
  return `Plan ${block.status}${count}`;
}

function PlanMarker({ block, onShowPlan }: { block: PlanBlock; onShowPlan: () => void }) {
  return (
    <div className="plan-revision-chip-row">
      <button type="button" className="plan-revision-chip" onClick={onShowPlan} title="Show the plan" disabled={block.status === 'building'}>
        {planLabel(block)}
      </button>
    </div>
  );
}

function noop(): void {}

const APPROVAL_KIND: Record<ApprovalKind, string> = {
  shell_command: 'Run a command',
  url_fetch: 'Fetch a URL',
  external_path: 'Read outside the workspace',
  runner_tool: 'Use a tool',
};

// The source the policy decided under. `asked` is omitted: a card a user
// answered reads "Approved", not "Approved (asked)".
function approvalSourceLabel(source: ApprovalSource | undefined): string {
  switch (source) {
    case 'pre-approved': return 'pre-approved';
    case 'remembered': return 'remembered';
    case 'mode': return 'policy';
    case 'no-channel': return 'no approval channel';
    default: return '';
  }
}

function approvalStatusLabel(block: ApprovalBlock): string {
  const silent = block.decidedBy !== undefined && block.decidedBy !== 'asked';
  switch (block.status) {
    case 'pending': return 'Waiting for you';
    case 'granted': return silent ? `Auto-approved (${approvalSourceLabel(block.decidedBy)})` : block.forTask ? 'Approved for this task' : 'Approved';
    case 'denied': return silent ? `Auto-denied (${approvalSourceLabel(block.decidedBy)})` : 'Denied';
    case 'withdrawn': return 'Withdrawn';
  }
}

/**
 * A task runner's tool request (ADR-0018, A1), in its task's log. Its answers
 * are the runner's own: Allow, Allow for this task when the runner offered a
 * grant for it, and Deny with an optional note the agent reads.
 */
function RunnerApprovalCard({ block, onAnswer }: { block: ApprovalBlock; onAnswer: (id: string, decision: ApprovalDecision) => void }) {
  const [note, setNote] = useState('');
  const pending = block.status === 'pending' && block.approvalId !== undefined;
  const answer = (decision: ApprovalDecision) => { if (block.approvalId) onAnswer(block.approvalId, decision); };
  return (
    <div className={`approval-card ${block.status}`} data-status={block.status}>
      <div className="approval-card-head">
        <span className="approval-card-kind">{APPROVAL_KIND[block.kind]}</span>
        <span className="approval-card-status">{approvalStatusLabel(block)}</span>
      </div>
      <code className="approval-card-subject">{block.subject}</code>
      {block.note && <div className="approval-card-detail">Note to the agent: {block.note}</div>}
      {pending && (
        <>
          <input className="approval-card-note" type="text" value={note} placeholder="Note to the agent if you deny (optional)"
            onChange={(e) => setNote(e.target.value)} />
          <div className="approval-card-actions">
            <button type="button" className="approval-card-allow" onClick={() => answer({ decision: 'allow' })}>Allow</button>
            {block.allowForTask && (
              <button type="button" className="approval-card-allow-task" title="Allow it, and let the runner keep the grant it proposed for the rest of this task"
                onClick={() => answer({ decision: 'allowForTask' })}>Allow for this task</button>
            )}
            <button type="button" className="approval-card-deny"
              onClick={() => answer(note.trim() ? { decision: 'deny', note: note.trim() } : { decision: 'deny' })}>Deny</button>
          </div>
        </>
      )}
    </div>
  );
}

export function ApprovalCard({ block, onResolve }: { block: ApprovalBlock; onResolve: (id: string, granted: boolean) => void }) {
  const status = approvalStatusLabel(block);
  return (
    <div className={`approval-card ${block.status}`} data-status={block.status}>
      <div className="approval-card-head">
        <span className="approval-card-kind">{APPROVAL_KIND[block.kind]}</span>
        <span className="approval-card-status">{status}</span>
      </div>
      <code className="approval-card-subject">{block.subject}</code>
      {block.detail && <div className="approval-card-detail">{block.detail}</div>}
      <div className="approval-card-scope">
        {block.status === 'pending'
          ? `Approving also allows ${block.scope} for the rest of this session.`
          : `Scope: ${block.scope}`}
      </div>
      {block.status === 'pending' && block.approvalId && (
        <div className="approval-card-actions">
          <button type="button" className="approval-card-allow" onClick={() => onResolve(block.approvalId!, true)}>Allow</button>
          <button type="button" className="approval-card-deny" onClick={() => onResolve(block.approvalId!, false)}>Deny</button>
        </div>
      )}
    </div>
  );
}

function Block({
  block, expanded, onShowPlan, onResolveApproval, onAnswerApproval,
}: {
  block: DisplayBlock;
  expanded: boolean;
  onShowPlan: () => void;
  onResolveApproval: (id: string, granted: boolean) => void;
  onAnswerApproval: (id: string, decision: ApprovalDecision) => void;
}) {
  switch (block.type) {
    case 'message':
      return <ChatMessage block={block} />;
    case 'thinking':
      return <ThinkingBlock block={block} expanded={expanded} />;
    case 'tool':
      return <CommandRow block={block} expanded={expanded} />;
    case 'subagent':
      return <SubagentCard block={block} expanded={expanded} />;
    case 'plan':
      return <PlanMarker block={block} onShowPlan={onShowPlan} />;
    case 'skill_load':
      return <SkillLoadNotice block={block} />;
    case 'approval':
      return block.kind === 'runner_tool'
        ? <RunnerApprovalCard block={block} onAnswer={onAnswerApproval} />
        : <ApprovalCard block={block} onResolve={onResolveApproval} />;
    // The token line is pinned below the conversation, not drawn in it.
    case 'usage':
      return null;
  }
}

const MemoBlock = React.memo(Block);

export function ConversationBlocks({
  blocks, detailAll, onShowPlan, onResolveApproval = noop, onAnswerApproval = noop,
}: {
  blocks: readonly DisplayBlock[];
  detailAll: boolean;
  onShowPlan: () => void;
  onResolveApproval?: (id: string, granted: boolean) => void;
  /** A task runner's request, answered in its task log (ADR-0018, A1). */
  onAnswerApproval?: (id: string, decision: ApprovalDecision) => void;
}) {
  return (
    <div className="conversation">
      {blocks.map((block) => (
        <MemoBlock key={block.id} block={block} expanded={detailAll} onShowPlan={onShowPlan}
          onResolveApproval={onResolveApproval} onAnswerApproval={onAnswerApproval} />
      ))}
    </div>
  );
}
