import React, { useCallback, useId, useMemo, useState } from 'react';
import MarkdownContent from './MarkdownContent';
import TaskHandoff from './TaskHandoff';
import ReportBody from './ReportBody';
import type {
  CommandBlock, CompactionBlock, RunnerLoadedBlock,
  ApprovalBlock, ApprovalDecision, DisplayBlock, MessageBlock, PlanBlock, SkillLoadBlock, SubagentBlock, SubagentStatus,
  ThinkingDisplayBlock, ToolBlock, ToolStatus, DiffRow, DiffStat,
} from '@ordewell/core';
import { activitySummary, conversationItems } from '../activity';
import { approvalKindText, approvalStatusText, compactionText, diffRows, diffSummary, loadedSkillTokens, markdownHtml, outputLines, outputPreview, planMarkerParts, wakeUpItems } from '@ordewell/core/plan-utils';

/*
 * The planner conversation (#51 display blocks) as the webview draws it, and
 * a task's log through the same components. Each run of activity between two
 * messages folds into one group that says what it did; opening it shows its
 * rows as previews, and each row opens on its own (ADR-0017, X1). What is open
 * is this surface's state, keyed on block ids — never the blocks'.
 */

const PREVIEW_LINES = 3;
// A diff is read rather than skimmed, so its preview runs longer than a command's.
const DIFF_PREVIEW_ROWS = 10;

// One word with a slash and no scheme: a file path, whose end is the part
// worth keeping when the row is too narrow. A URL keeps its host instead.
const PATH_LIKE = /^(?![a-z][a-z0-9+.-]*:\/\/)\S*\/\S*$/i;

// Core's one parser settles what a model's text may become, so the webview
// cannot loosen it. The newline it ends its last block with would be a stray
// text node after the reply.
export function renderMarkdown(text: string): string {
  return markdownHtml(text).trimEnd();
}

/** The run update that woke the planner, with each report it carries. */
function RunUpdate({ text }: { text: string }) {
  return (
    <div className="chat-msg chat-msg-wake-up">
      <span className="chat-msg-label">Run update</span>
      <div className="chat-msg-content">
        {wakeUpItems(text).map((item, i) => {
          if (item.kind === 'line') return <div key={i}>{item.text}</div>;
          return (
            <div key={i} className="chat-report">
              <div className="chat-report-head">Report from task {item.task}</div>
              <ReportBody lines={item.lines} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ChatMessage({ block }: { block: MessageBlock }) {
  if (block.role === 'system' || block.role === 'error') {
    return (
      <div className={`chat-msg chat-msg-${block.role}`}>
        <span className="chat-msg-content">{block.text}</span>
      </div>
    );
  }
  // The run update that woke the supervisor: Ordewell's words to it, shown as they were sent.
  if (block.role === 'wake_up') {
    if (wakeUpItems(block.text).some((item) => item.kind === 'report')) return <RunUpdate text={block.text} />;
    return (
      <div className="chat-msg chat-msg-wake-up">
        <span className="chat-msg-label">Run update</span>
        <span className="chat-msg-content">{block.text.replace(/^Run update:\n/, '')}</span>
      </div>
    );
  }
  if (block.role === 'user') {
    return (
      <div className="chat-msg chat-msg-user">
        <div className="chat-msg-bubble">
          {block.forced && <span className="chat-msg-forced" title="Sent now: it stopped the planner turn in flight">sent now</span>}
          <div className="chat-msg-content">{block.skills ? <SkillMarkedText text={block.text} skills={block.skills} /> : block.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`chat-msg chat-msg-planner${block.role === 'supervisor' ? ' chat-msg-supervisor' : ''}${block.streaming ? ' streaming' : ''}`}>
      <div className="chat-msg-bubble">
        {block.role === 'supervisor' && <span className="chat-msg-label">Supervisor</span>}
        <MarkdownContent className="chat-msg-content" html={renderMarkdown(block.text.trim())} />
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

/** What a row's own disclosure needs: whether it is open, and the switch. Without `onToggle` the row is drawn as it stands. */
interface RowProps<B> {
  block: B;
  expanded: boolean;
  onToggle?: () => void;
}

// A click that ends a drag-selection is someone copying the row's text, not
// asking for its detail.
function selecting(within: Element): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && !!selection.anchorNode && within.contains(selection.anchorNode);
}

function Chevron() {
  return (
    <svg className="disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A row's head as the native button that opens it, with `aria-controls` on
 * the region it opens; or, with no switch, the same head as plain text.
 */
function Head({ className, expanded, controls, onToggle, children }: {
  className: string;
  expanded: boolean;
  controls: string;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  if (!onToggle) return <div className={className}>{children}</div>;
  return (
    <button type="button" className={`${className} disclosure`} aria-expanded={expanded} aria-controls={controls}
      onClick={(e) => { if (!selecting(e.currentTarget)) onToggle(); }}>
      <Chevron />
      {children}
    </button>
  );
}

export function ThinkingBlock({ block, expanded, onToggle }: RowProps<ThinkingDisplayBlock>) {
  const text = block.text.trim();
  const id = useId();
  return (
    <div className={`activity-think${expanded ? ' expanded' : ''}`}>
      <Head className="activity-think-head" expanded={expanded} controls={id} onToggle={onToggle}>
        <span className="activity-think-label">Thinking{block.streaming ? '…' : ''}</span>
        {!expanded && <span className="activity-think-line">{text.split('\n')[0]}</span>}
      </Head>
      <div id={id}>{expanded && <pre className="activity-think-pre">{text}</pre>}</div>
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

export function CommandRow({ block, expanded, onToggle, args = true }: RowProps<ToolBlock> & {
  /** Its arguments drawn when open; a script's step has none its head does not already say. */
  args?: boolean;
}) {
  const label = outcomeLabel(block);
  const preview = outputPreview(block.output, PREVIEW_LINES);
  const { keyArg } = block.headline;
  const path = PATH_LIKE.test(keyArg);
  const diff = block.diff && block.status === 'ok' ? block.diff : null;
  const id = useId();
  return (
    <div className={`cmd-row${expanded ? ' expanded' : ''}`} data-status={block.status}>
      <div className="cmd-row-header">
        <Head className="cmd-row-toggle" expanded={expanded} controls={id} onToggle={onToggle}>
          <span className="cmd-row-icon" aria-hidden="true">{STATUS_ICON[block.status]}</span>
          <code className="cmd-row-head">
            <span className="cmd-row-name">{block.headline.name}(</span>
            <span className={`cmd-row-arg${path ? ' path' : ''}`} title={path ? keyArg : undefined}><bdi>{keyArg}</bdi></span>
            <span className="cmd-row-name">)</span>
          </code>
        </Head>
        {block.sealed && <span className="cmd-row-sealed" title="Ran sealed: no network, no home directory, and nothing it wrote reached the workspace">sealed</span>}
        {label && <span className="cmd-row-outcome">{label}</span>}
      </div>
      <div id={id} className="cmd-row-body">
        {diff ? <DiffView output={block.output} diff={diff} expanded={expanded} /> : expanded ? (
          <>
            {args && <pre className="cmd-row-args">{prettyArgs(block.args)}</pre>}
            {block.output && <pre className="cmd-row-output">{outputLines(block.output).join('\n')}</pre>}
          </>
        ) : preview.lines.length > 0 && (
          <>
            <pre className="cmd-row-preview">{preview.lines.join('\n')}</pre>
            {preview.hiddenLineCount > 0 && <span className="cmd-row-more">{moreLines(preview.hiddenLineCount)}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** A runner command the user ran (#66): its output folded when long, opened on its own. */
function RunnerCommandRow({ block }: { block: CommandBlock }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preview = outputPreview(block.output, PREVIEW_LINES);
  return (
    <div className="cmd-row" data-status={block.status}>
      <div className="cmd-row-header">
        <code>/{block.name}{block.args ? ` ${block.args}` : ''}</code>
        <span className="cmd-row-outcome">{block.status}</span>
      </div>
      {block.output && <pre id={id} className="cmd-row-output">{expanded ? block.output : preview.lines.join('\n')}</pre>}
      {preview.hiddenLineCount > 0 && (
        <button type="button" className="cmd-row-more report-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : moreLines(preview.hiddenLineCount)}
        </button>
      )}
    </div>
  );
}

function RunnerLoaded({ block, expanded, onToggle }: RowProps<RunnerLoadedBlock>) {
  const count = (kind: RunnerLoadedBlock['commands'][number]['kind']) => block.commands.filter((command) => command.kind === kind).length;
  const counted = (n: number, label: string) => `${n} ${label}${n === 1 ? '' : 's'}`;
  const id = useId();
  return (
    <div className="runner-loaded chat-msg chat-msg-system">
      <Head className="runner-loaded-head" expanded={expanded} controls={id} onToggle={onToggle}>
        <span>Runner loaded {counted(count('skill'), 'skill')}, {counted(count('command'), 'command')}, {counted(count('builtin'), 'built-in command')}, {counted(block.mcpServers.length, 'MCP server')}</span>
      </Head>
      <div id={id}>
        {expanded && <div className="runner-loaded-detail">
          {block.commands.map((command) => <div key={command.name}><code>/{command.name}</code> · {command.kind} {command.argumentHint} · {command.description}</div>)}
          {block.mcpServers.map((server) => <div key={server.name}>{server.name}{server.status ? ` (${server.status})` : ''}</div>)}
        </div>}
      </div>
    </div>
  );
}

/**
 * The planner's compaction (ADR-0017): one quiet line while it runs and after,
 * where it happened. A condensed one's summary opens from it, never shown whole.
 */
function CompactionRow({ block, expanded, onToggle }: RowProps<CompactionBlock>) {
  const id = useId();
  const toggle = block.summary ? onToggle : undefined;
  return (
    <div className="compaction-row chat-msg chat-msg-system" data-status={block.status}>
      <Head className="compaction-row-head" expanded={expanded} controls={id} onToggle={toggle}>
        {block.status === 'running' && <span className="chat-msg-spinner" aria-hidden="true" />}
        <span>{compactionText(block)}</span>
      </Head>
      {toggle && <div id={id}>{expanded && <div className="compaction-row-summary">{block.summary}</div>}</div>}
    </div>
  );
}

const SUBAGENT_STATUS: Record<SubagentStatus, string> = {
  running: 'running…',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

const NOTHING_OPEN: ReadonlySet<string> = new Set();

/**
 * A subagent: its header and digest, and once opened its steps as their own
 * previews — opening the agent opens none of them (ADR-0017, X1).
 */
export function SubagentCard({ block, expanded, onToggle, open = NOTHING_OPEN, onToggleRow }: RowProps<SubagentBlock> & {
  open?: ReadonlySet<string>;
  onToggleRow?: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className={`subagent-card${expanded ? ' expanded' : ''}`} data-status={block.status}>
      <Head className="subagent-card-header" expanded={expanded} controls={id} onToggle={onToggle}>
        <span className="subagent-card-title">Agent</span>
        <span className="subagent-card-brief">{block.brief}</span>
        {block.model && <span className="subagent-card-model">{block.model}</span>}
        <span className="subagent-card-status">{SUBAGENT_STATUS[block.status]}</span>
      </Head>
      <div id={id}>
        {expanded && block.children.length > 0 && (
          <div className="subagent-card-steps">
            {block.children.map((child) => (
              <MemoBlock key={child.id} block={child} expanded={open.has(child.id)} onToggle={onToggleRow} onShowPlan={noop}
                onResolveApproval={noop} onAnswerApproval={noop} />
            ))}
          </div>
        )}
      </div>
      {block.digest && <div className="subagent-card-digest">{block.digest}</div>}
    </div>
  );
}

function PlanMarker({ block, onShowPlan }: { block: PlanBlock; onShowPlan: () => void }) {
  return (
    <div className="plan-revision-chip-row">
      <button type="button" className="plan-revision-chip" onClick={onShowPlan} title="Show the plan" disabled={block.status === 'building'}>
        {planMarkerParts(block).join(' · ')}
      </button>
    </div>
  );
}

function noop(): void {}

/**
 * A task runner's tool request (ADR-0018, A1), in its task's log. Its answers
 * are the runner's own: Allow, Allow for this task when the runner offered a
 * grant for it, and Deny with an optional note the agent reads.
 */
function RunnerApprovalCard({ block, onAnswer }: { block: ApprovalBlock; onAnswer: ((id: string, decision: ApprovalDecision) => void) | undefined }) {
  const [note, setNote] = useState('');
  const pending = block.status === 'pending' && block.approvalId !== undefined && onAnswer !== undefined;
  const answer = (decision: ApprovalDecision) => { if (block.approvalId) onAnswer?.(block.approvalId, decision); };
  return (
    <div className={`approval-card ${block.status}`} data-status={block.status}>
      <div className="approval-card-head">
        <span className="approval-card-kind">{approvalKindText(block.kind)}</span>
        <span className="approval-card-status">{approvalStatusText(block)}</span>
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
  return (
    <div className={`approval-card ${block.status}`} data-status={block.status}>
      <div className="approval-card-head">
        <span className="approval-card-kind">{approvalKindText(block.kind)}</span>
        <span className="approval-card-status">{approvalStatusText(block)}</span>
      </div>
      <code className="approval-card-subject">{block.subject}</code>
      {block.detail && <div className="approval-card-detail">{block.detail}</div>}
      {/* What a script task runs, verbatim: the answer is about exactly this (ADR-0035). */}
      {block.body && <pre className="approval-card-body" aria-label="What it runs">{block.body}</pre>}
      {/* A start is asked every time (ADR-0029), so its answer grants nothing more. */}
      {block.kind !== 'task_start' && (
        <div className="approval-card-scope">
          {block.status === 'pending'
            ? `Approving also allows ${block.scope} for the rest of this session.`
            : `Scope: ${block.scope}`}
        </div>
      )}
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
  block, expanded, open, onToggle, onShowPlan, onResolveApproval, onAnswerApproval,
}: {
  block: DisplayBlock;
  expanded: boolean;
  /** What is open among a subagent's steps; only a subagent is given it, so no other block redraws on a toggle. */
  open?: ReadonlySet<string>;
  /** Opens or closes the row with this id. */
  onToggle?: (id: string) => void;
  onShowPlan: () => void;
  onResolveApproval: (id: string, granted: boolean) => void;
  onAnswerApproval: (id: string, decision: ApprovalDecision) => void;
}) {
  const toggle = onToggle ? () => onToggle(block.id) : undefined;
  switch (block.type) {
    case 'handoff':
      return <TaskHandoff handoff={block.handoff} />;
    case 'command':
      return <RunnerCommandRow block={block} />;
    case 'runner_loaded':
      return <RunnerLoaded block={block} expanded={expanded} onToggle={toggle} />;
    case 'compaction':
      return block.origin
        ? <CompactionRow block={block} expanded={expanded} onToggle={toggle} />
        : <div className="chat-msg chat-msg-system">{compactionText(block)}</div>;
    case 'message':
      return <ChatMessage block={block} />;
    case 'thinking':
      return <ThinkingBlock block={block} expanded={expanded} onToggle={toggle} />;
    case 'tool':
      return <CommandRow block={block} expanded={expanded} onToggle={toggle} />;
    case 'subagent':
      return <SubagentCard block={block} expanded={expanded} onToggle={toggle} open={open} onToggleRow={onToggle} />;
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
const MemoCommandRow = React.memo(CommandRow);

interface Handlers {
  onShowPlan: () => void;
  onResolveApproval: (id: string, granted: boolean) => void;
  onAnswerApproval?: (id: string, decision: ApprovalDecision) => void;
}

const groupKey = (block: DisplayBlock) => `activity:${block.id}`;

/**
 * One run of activity as a single line that says what it did. Open, it draws
 * its rows as their previews; closed, it draws none of them.
 */
function ActivityGroup({ blocks, open, onToggleGroup, onToggleRow, handlers }: {
  blocks: readonly DisplayBlock[];
  open: ReadonlySet<string>;
  onToggleGroup: (keys: readonly string[]) => void;
  onToggleRow: (id: string) => void;
  handlers: Handlers;
}) {
  const id = useId();
  const summary = activitySummary(blocks);
  const expanded = blocks.some((b) => open.has(groupKey(b)));
  return (
    <div className="activity-group" data-state={summary.running ? 'running' : summary.failed ? 'failed' : 'done'}>
      <button type="button" className="activity-group-toggle disclosure" aria-expanded={expanded} aria-controls={id}
        onClick={() => onToggleGroup(blocks.map(groupKey))}>
        <Chevron />
        <span className="activity-group-summary">{summary.text}</span>
      </button>
      <div id={id} className="activity-group-body" hidden={!expanded}>
        {expanded && blocks.map((block) => (
          <MemoBlock key={block.id} block={block} expanded={open.has(block.id)} open={block.type === 'subagent' ? open : undefined}
            onToggle={onToggleRow} {...handlers} />
        ))}
      </div>
    </div>
  );
}

export function ConversationBlocks({
  blocks, asRun = false, onShowPlan, onResolveApproval = noop, onAnswerApproval,
}: {
  blocks: readonly DisplayBlock[];
  /**
   * Every block drawn whole, with nothing to open: a script task's log, which
   * is its commands, their output and their exits (ADR-0035) and has no prose
   * for a fold to keep in view.
   */
  asRun?: boolean;
  onShowPlan: () => void;
  onResolveApproval?: (id: string, granted: boolean) => void;
  /** A task runner's request, answered in its task log (ADR-0018, A1). Absent, it only reads: a button that answers nothing misleads. */
  onAnswerApproval?: (id: string, decision: ApprovalDecision) => void;
}) {
  const items = useMemo(() => conversationItems(blocks), [blocks]);
  // Rows by block id, groups by the ids of the blocks they hold: a group stays
  // open when it grows, when its first block changes kind (a call becoming the
  // subagent it started), and when it absorbs the next one because a message
  // between them was taken back. A new conversation remounts this, so nothing
  // carries over.
  const [open, setOpen] = useState<ReadonlySet<string>>(NOTHING_OPEN);
  const onToggleRow = useCallback((id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  const onToggleGroup = useCallback((keys: readonly string[]) => setOpen((prev) => {
    const next = new Set(prev);
    if (keys.some((key) => next.has(key))) keys.forEach((key) => next.delete(key));
    else next.add(keys[0]);
    return next;
  }), []);
  const handlers = useMemo(() => ({ onShowPlan, onResolveApproval, onAnswerApproval }), [onShowPlan, onResolveApproval, onAnswerApproval]);
  if (asRun) {
    return (
      <div className="conversation">
        {blocks.map((block) => (block.type === 'tool'
          ? <MemoCommandRow key={block.id} block={block} expanded args={false} />
          : <MemoBlock key={block.id} block={block} expanded {...handlers} />))}
      </div>
    );
  }
  return (
    <div className="conversation">
      {items.map((item) => (item.kind === 'activity'
        ? <ActivityGroup key={item.key} blocks={item.blocks} open={open} onToggleGroup={onToggleGroup} onToggleRow={onToggleRow} handlers={handlers} />
        : item.block.type === 'compaction'
          ? <MemoBlock key={item.block.id} block={item.block} expanded={open.has(item.block.id)} onToggle={onToggleRow} {...handlers} />
          : <MemoBlock key={item.block.id} block={item.block} expanded={false} {...handlers} />))}
    </div>
  );
}
