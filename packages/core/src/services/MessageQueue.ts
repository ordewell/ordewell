import type { QueuedMessage, SkillLoad } from '../models/Task';

/**
 * The follow-ups a user sends while a run executes, held until the scheduler
 * drains them between batches. Each send gets an id: a sequence, not just the
 * clock, because two sends inside one millisecond must stay distinguishable —
 * a surface removes one by id.
 */
export class MessageQueue {
  private messages: QueuedMessage[] = [];
  private seq = 0;

  get length(): number { return this.messages.length; }

  enqueue(text: string, skills: readonly SkillLoad[] = []): void {
    this.messages.push({
      id: `q-${Date.now()}-${++this.seq}`,
      text,
      timestamp: new Date().toISOString(),
      ...(skills.length > 0 ? { skills: [...skills] } : {}),
    });
  }

  /** A copy, so a surface cannot reshape the queue it is showing. */
  all(): QueuedMessage[] {
    return [...this.messages];
  }

  /** Take one unsent message back out; false when it was never there (or already drained). */
  remove(id: string): boolean {
    const index = this.messages.findIndex((m) => m.id === id);
    if (index < 0) return false;
    this.messages.splice(index, 1);
    return true;
  }

  replace(messages: QueuedMessage[]): void {
    this.messages = [...messages];
  }

  clear(): void {
    this.messages = [];
  }

  /** The oldest message, removed; null when the queue is empty. */
  next(): QueuedMessage | null {
    return this.messages.shift() ?? null;
  }
}
