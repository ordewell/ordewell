import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { rendererDelay, RENDERER_TIMING_SOURCE } from '../rendererTiming';

describe('renderer timing', () => {
  it('reports a blocked visible renderer, without ordinary work or hidden-window throttling', () => {
    let now = 0;
    let tick: (() => void) | undefined;
    const listeners: Record<string, () => void> = {};
    const info = vi.fn();
    const document = { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; }, removeEventListener: vi.fn() };
    const clearInterval = vi.fn();
    runInNewContext(RENDERER_TIMING_SOURCE, {
      performance: { now: () => now }, document, console: { info },
      window: { addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; } },
      setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval,
      setTimeout: (fn: () => void) => { listeners.timeout = fn; },
    });
    now = 1000;
    tick?.();
    expect(info).not.toHaveBeenCalled();
    now = 4500;
    tick?.();
    expect(info).toHaveBeenCalledWith('__ordewell_renderer_delay__:2500');
    expect(rendererDelay(String(info.mock.calls[0]?.[0]))).toBe(2500);
    document.visibilityState = 'hidden';
    now = 30000;
    tick?.();
    expect(info).toHaveBeenCalledTimes(1);
    document.visibilityState = 'visible';
    listeners.visibilitychange?.();
    now = 31000;
    tick?.();
    expect(info).toHaveBeenCalledTimes(1);
    listeners.timeout?.();
    expect(clearInterval).toHaveBeenCalledWith(1);
    expect(document.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it.each(['a user message', '__ordewell_renderer_delay__:secret', '__ordewell_renderer_delay__:NaN', '__ordewell_renderer_delay__:999', '__ordewell_renderer_delay__:1000\nprivate', '__ordewell_renderer_delay__:999999999'])('rejects non-timing console content: %s', (message) => {
    expect(rendererDelay(message)).toBeUndefined();
  });
});
