import type { AgentEvent, AgentStartOptions } from './AgentAdapter';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';

/**
 * Tools a planning Claude Code session may use. `--permission-mode plan`
 * already refuses edits; naming the write tools explicitly means a future
 * permission-mode change cannot quietly hand the planner a `Write` (T1).
 */
const DISALLOWED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell'];

interface ClaudeBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> };
  message?: { content?: ClaudeBlock[] | string };
}

/** Tool results arrive as a string, or as a content-block array. Flatten both. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : typeof (block as ClaudeBlock)?.text === 'string' ? (block as ClaudeBlock).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Claude Code as a planner, over its bidirectional streaming-JSON transport
 * (ADR-0009).
 *
 * `-p --input-format stream-json --output-format stream-json` keeps one process
 * alive across turns: user messages go in as JSON lines, and the session's
 * assistant blocks, tool uses, tool results and turn boundaries come back the
 * same way. It is the richest of the three streams — partial messages and
 * separate thinking blocks — which is why this agent went first.
 */
export class ClaudeCodeAdapter extends StdioAgentAdapter {
  readonly agentId = 'claude-code';

  protected spawnSpec(opts: AgentStartOptions): SpawnSpec {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // stream-json output is rejected without it.
      '--verbose',
      '--include-partial-messages',
      // The read-only guarantee, enforced at spawn rather than by prompt.
      '--permission-mode', 'plan',
      '--disallowedTools', DISALLOWED_TOOLS.join(','),
      '--append-system-prompt', opts.systemPrompt,
    ];
    if (opts.model) args.push('--model', opts.model);
    // `adaptive` is a thinking *type*, not an effort rung: `--effort adaptive`
    // is warned about and ignored, and adaptive is the default for every model
    // that offers it. Passing nothing is the same run without the warning on
    // stderr.
    if (opts.effort && opts.effort !== 'adaptive') args.push('--effort', opts.effort);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    return { command: 'claude', args };
  }

  protected turnPayload(message: string): string {
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    })}\n`;
  }

  protected handleLine(line: string, emit: (event: AgentEvent) => void): void {
    const msg = StdioAgentAdapter.parse<ClaudeLine>(line);
    if (!msg) return;

    if (msg.session_id) this.sessionId = msg.session_id;

    switch (msg.type) {
      // The control channel: Claude asks whether a tool may run when its mode
      // cannot decide alone. A read-only planner answers "deny", every time —
      // and must answer, because an unacknowledged request stalls the turn.
      case 'control_request': {
        if (msg.request?.subtype !== 'can_use_tool') return;
        this.writeLine({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: msg.request_id,
            response: { behavior: 'deny', message: 'The Ordewell planner is read-only. Mutation belongs to the runners that execute the plan.' },
          },
        });
        emit({
          type: 'permission_request',
          id: msg.request_id ?? '',
          name: msg.request?.tool_name ?? 'unknown',
          detail: JSON.stringify(msg.request?.input ?? {}),
        });
        return;
      }

      case 'assistant':
        for (const block of Array.isArray(msg.message?.content) ? msg.message!.content as ClaudeBlock[] : []) {
          if (block.type === 'text' && block.text) emit({ type: 'assistant_text', text: block.text });
          else if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking });
          else if (block.type === 'tool_use' && block.name) {
            emit({ type: 'tool_call', id: block.id ?? block.name, name: block.name, args: block.input ?? {} });
          }
        }
        return;

      case 'user':
        // The transport echoes tool results back as a synthetic user message.
        for (const block of Array.isArray(msg.message?.content) ? msg.message!.content as ClaudeBlock[] : []) {
          if (block.type !== 'tool_result') continue;
          emit({
            type: 'tool_result',
            id: block.tool_use_id ?? '',
            name: '',
            output: flattenContent(block.content),
            success: block.is_error !== true,
          });
        }
        return;

      case 'result':
        // `result` closes every turn — success or failure. The final assistant
        // text (which carries the plan JSON) already arrived as assistant
        // blocks, so this only settles the turn.
        if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          emit({ type: 'error', message: msg.result?.trim() || `Claude Code ended the turn: ${msg.subtype ?? 'error'}` });
        } else {
          emit({ type: 'turn_end' });
        }
        return;

      // `system`/`stream_event` carry init metadata and partial deltas. The
      // session id is picked up above; partials are ignored because the
      // complete blocks follow and would otherwise be counted twice.
      default:
        return;
    }
  }
}
