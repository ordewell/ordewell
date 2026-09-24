import { sanitize } from './ansi';
import type { ChatMessage, MessageRole, TuiState } from './state';

export function say(
  state: TuiState,
  role: MessageRole,
  content: string,
  research?: ChatMessage['research'],
  extra?: Partial<Pick<ChatMessage, 'research' | 'streaming'>>,
): TuiState {
  // The daemon, not just the keyboard, can hand us a literal tab (a planner
  // turn, a research summary) — see `sanitize` for why one left in breaks
  // the frame just as a pasted one would.
  const message: ChatMessage = {
    role,
    content: sanitize(content),
    timestamp: new Date().toISOString(),
    ...(research ? { research } : {}),
    ...extra,
  };
  // A new turn snaps a scrolled-back transcript to the tail — following the
  // conversation beats preserving the reading position.
  return { ...state, messages: [...state.messages, message], scroll: 0 };
}
