import { useEffect, useState } from 'react';
import type { DaemonStatus } from '../shared/bridge';

/** The connection as main last reported it, kept current by its pushes. */
export function useDaemonStatus(): DaemonStatus | undefined {
  const [status, setStatus] = useState<DaemonStatus>();
  useEffect(() => {
    let live = true;
    const off = window.ordewell.daemon.onStatus(setStatus);
    void window.ordewell.daemon.status().then((first) => { if (live) setStatus((seen) => seen ?? first); });
    return () => { live = false; off(); };
  }, []);
  return status;
}
