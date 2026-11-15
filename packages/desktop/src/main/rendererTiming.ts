const PREFIX = '__ordewell_renderer_delay__:';

/** Numeric-only reports keep page content out of the local startup log. */
export const RENDERER_TIMING_SOURCE = `(() => {
  let last = performance.now();
  const reset = () => { last = performance.now(); };
  document.addEventListener('visibilitychange', reset);
  const timer = setInterval(() => {
    const now = performance.now();
    const delay = Math.round(now - last - 1000);
    last = now;
    if (document.visibilityState === 'visible' && delay >= 1000) console.info(${JSON.stringify(PREFIX)} + delay);
  }, 1000);
  const stop = () => { clearInterval(timer); document.removeEventListener('visibilitychange', reset); };
  window.addEventListener('pagehide', stop, { once: true });
  setTimeout(stop, 10 * 60 * 1000);
})()`;

export function rendererDelay(message: string): number | undefined {
  if (!message.startsWith(PREFIX)) return undefined;
  const value = message.slice(PREFIX.length);
  if (!/^\d{4,8}$/.test(value)) return undefined;
  const delay = Number(value);
  return delay >= 1000 && delay <= 86_400_000 ? delay : undefined;
}
