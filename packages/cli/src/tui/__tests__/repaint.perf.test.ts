import { describe, expect, it } from 'vitest';
import { monitorEventLoopDelay } from 'perf_hooks';
import type { MessageBlock } from '@ordewell/core';
import { createApp } from '../app';
import { initialState, type TuiState, type TaskView } from '../state';
import type { Action } from '../reducers/shared';
import { patient } from '@ordewell/core/testing';

const yieldMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function task(id: string, order: number): TaskView {
  return {
    id, order, title: `Task ${order}: make the ${id} route handle a long and winding request`, type: 'ai',
    status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits',
    assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' },
  };
}

/** The transcript a long run leaves: enough blocks that re-drawing all of them is visible. */
function longConversation(): TuiState['conversation'] {
  const blocks: MessageBlock[] = Array.from({ length: 300 }, (_, i) => ({
    type: 'message',
    id: `b${i + 1}`,
    role: i % 3 === 0 ? 'user' : 'planner',
    text: `Message ${i + 1}: ${'the planner is working through a long plan and its reply keeps growing. '.repeat(3)}`,
    streaming: false,
  }));
  return { blocks, nextId: blocks.length + 1 };
}

function harness(state: TuiState) {
  const frames: { rows: number; bytes: number; at: number }[] = [];
  let lastDispatch = 0;
  let blocked = 0;
  let drawTime = 0;
  const app = createApp({
    initial: state,
    draw: (frame) => {
      const at = performance.now();
      blocked += at - lastDispatch;
      const started = performance.now();
      frames.push({ rows: frame.length, bytes: frame.reduce((n, row) => n + row.length, 0), at });
      drawTime += performance.now() - started;
    },
    perform: async () => {},
    onExit: () => {},
  });
  return {
    app,
    frames,
    dispatch(action: Action) {
      lastDispatch = performance.now();
      app.dispatch(action);
    },
    mark() {
      lastDispatch = performance.now();
      blocked = 0;
      drawTime = 0;
    },
    blocked: () => blocked,
    drawTime: () => drawTime,
  };
}

describe('repaint measurement', () => {
  it('measures the flood and the huge block', async () => {
    const h = harness(initialState({
      rows: 50, cols: 200, sessionId: 's1', status: 'executing', focus: 'plan',
      tasks: Array.from({ length: 6 }, (_, i) => task(`t${i + 1}`, i + 1)),
      conversation: longConversation(),
    }));
    h.app.start();
    h.frames.length = 0;
    h.mark();
    await yieldMacrotask();

    const started = performance.now();
    const floodFrom = h.frames.length;
    const flood: Action[] = [];
    for (let i = 0; i < 400; i++) {
      if (i % 4 === 0) {
        flood.push({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_text_delta', turnId: 'turn', segmentId: 'seg', text: `token ${i} ` } });
      } else if (i % 4 === 1) {
        flood.push({ type: 'runMessage', message: { type: 'status_update', tasks: Array.from({ length: 6 }, (_, n) => ({ id: `t${n + 1}`, status: 'in_progress', verdict: null })) }, sessionId: 's1' });
      } else if (i % 4 === 2) {
        flood.push({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: `step ${i}\n` }] });
      } else {
        flood.push({ type: 'spinnerTick' });
      }
    }
    for (const action of flood) {
      h.dispatch(action);
      await yieldMacrotask();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const floodMs = performance.now() - started;
    const floodFrames = h.frames.length;
    const floodPainted = h.frames.slice(floodFrom);

    // Open the task view, then deliver one multi-megabyte test run at once.
    h.dispatch({ type: 'taskViewRequested', sessionId: 's1', taskId: 't1' });
    await yieldMacrotask();
    h.dispatch({ type: 'taskLogLoaded', sessionId: 's1', taskId: 't1', attempt: 1, events: [] });
    await yieldMacrotask();
    h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'turn_start', message: 'Run the tests.' }] });
    await yieldMacrotask();
    h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'command', name: 'npm', args: 'test' }] });
    await yieldMacrotask();

    const huge = Array.from({ length: 80_000 }, (_, i) => `  ✓ test case ${i} passes in the integration suite`).join('\n');
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const beforeFrames = h.frames.length;
    const hugeStart = performance.now();
    h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'command_output', text: huge }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hugeMs = performance.now() - hugeStart;
    delay.disable();
    const hugeFrames = h.frames.length - beforeFrames;

    // The same amount again, but as the live stream a test run actually sends:
    // one action per chunk, so every frame re-reads a block that grew.
    const streamDelay = monitorEventLoopDelay({ resolution: 5 });
    streamDelay.enable();
    const streamedStart = performance.now();
    const streamedBefore = h.frames.length;
    const chunk = `${'  ✓ a test case in the integration suite passed\n'.repeat(200)}`;
    for (let i = 0; i < 500; i++) {
      h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'command_output', text: chunk }] });
      await yieldMacrotask();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const streamedMs = performance.now() - streamedStart;
    streamDelay.disable();
    const streamedFrames = h.frames.length - streamedBefore;

    if (process.env.TUI_PERF) {
      console.log(JSON.stringify({
        floodActions: flood.length,
        floodMs: Math.round(floodMs),
        floodFrames,
        framesPerSecond: Math.round((floodFrames / floodMs) * 1000),
        floodBlockedMs: Math.round(h.blocked()),
        floodFrameBytes: floodPainted.reduce((n, f) => n + f.bytes, 0),
        hugeBytes: huge.length,
        hugeMs: Math.round(hugeMs),
        hugeFrames,
        hugeMaxDelayMs: Math.round(delay.max / 1e6),
        hugeP99DelayMs: Math.round(delay.percentile(99) / 1e6),
        streamedBytes: chunk.length * 500,
        streamedMs: Math.round(streamedMs),
        streamedFrames,
        streamedMaxDelayMs: Math.round(streamDelay.max / 1e6),
        streamedP99DelayMs: Math.round(streamDelay.percentile(99) / 1e6),
        totalBlockedMs: Math.round(h.blocked()),
        totalDrawMs: Math.round(h.drawTime() * 10) / 10,
      }, null, 2));
    }

    // The flood coalesces rather than painting once per action. The ratio is
    // the claim, not an absolute frame count: a loaded machine may take longer
    // over the same macrotasks, and painting at the budget is still correct.
    expect(floodFrames).toBeGreaterThan(0);
    expect(floodFrames).toBeLessThan(flood.length / 4);

    // A huge block is laid out at its head, not parsed whole: neither its
    // arrival nor a stream of chunks may hold the loop for a noticeable time.
    expect(hugeFrames).toBeGreaterThan(0);
    expect(delay.max / 1e6).toBeLessThan(1_000);
    expect(streamedFrames).toBeGreaterThan(0);
    expect(streamedMs).toBeLessThan(15_000);
    expect(streamDelay.max / 1e6).toBeLessThan(1_000);
  }, patient(60_000));
});
