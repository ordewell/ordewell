import React, { useEffect, useState } from 'react';
import { elapsedSince } from '@ordewell/core/plan-utils';

/**
 * How long a turn has run (#81), counted from its start here rather than sent
 * by the host: the host posts the start once and this ticks on its own timer.
 * Nothing when there is no start to count from. Out of the accessibility tree
 * because it sits in a live region, which would announce every second.
 */
export default function ElapsedTime({ since, className }: { since: string | undefined; className: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const elapsed = elapsedSince(since, now);
  return elapsed ? <span className={className} aria-hidden="true">{elapsed}</span> : null;
}
