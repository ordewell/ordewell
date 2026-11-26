import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The plan filter is CSS over the cards' data-status attributes. jsdom has no
 * layout and applies neither :has() nor display:none, so the DOM tests assert
 * the structure this stylesheet acts on; here the rules themselves are what a
 * real renderer would obey, read as text.
 */
const css = readFileSync(fileURLToPath(new URL('../frame.css', import.meta.url)), 'utf8');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function block(selector: string): string {
  const match = new RegExp(`(?:^|\\n)${escape(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `no rule for ${selector}`).not.toBeNull();
  return match![1];
}
const declared = (selector: string, property: string): string | undefined =>
  new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(block(selector))?.[1].trim();

const folded = '.frame-plan .task-row-item:not(.expanded) .task-row-subtasks-folded';
const revealed = '.frame-plan[data-filter] .task-row-item:not(.expanded) .task-row-subtasks-folded';

describe("the plan panel's status filter and folded subtasks", () => {
  it("folds a collapsed row's descendants out of sight when no filter is set", () => {
    expect(declared(folded, 'display')).toBe('none');
  });

  it('reveals them under a filter, so a counted nested task has a visible result', () => {
    expect(declared(revealed, 'display')).toBe('block');
  });

  it('keeps a top-level card shown when it has a matching descendant', () => {
    // The filter hides a card only when it has NO matching status anywhere in it;
    // the folded subtasks are what :has() now finds for a nested running task.
    expect(css).toMatch(/\.frame-plan\[data-filter='running'\][^{]*\.task-list-rows > \[data-task-id\]:not\(:has\(\[data-status='running'\]\)\)/);
  });

  it('keeps a :has() rule for every rail status, so a deep descendant matches any filter', () => {
    // The recursion renders every descendant with data-status; each status filter
    // must remain so a running grandchild is as discoverable as any other status.
    const statuses = ['needs-you', 'failed', 'stalled', 'running', 'blocked', 'waiting-for-merge', 'not-started', 'passed', 'skipped'];
    for (const status of statuses) {
      expect(css, `no ${status} filter rule`).toContain(
        `.frame-plan[data-filter='${status}'] .task-list-rows > [data-task-id]:not(:has([data-status='${status}']))`,
      );
    }
  });
});
