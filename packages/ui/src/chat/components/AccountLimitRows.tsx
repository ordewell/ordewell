import React, { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { accountLimitsText, accountLimitsTitle, resumeTime } from '@ordewell/core/plan-utils';
import type { AccountLimitSnapshot } from '@ordewell/core';

/*
 * Inline limits for the account selected by the caller. Core words the
 * label and its details; an account with nothing known draws no label, so an
 * unread or signed-out account never reads as one with room left.
 *
 * The details — resets, plan, how current the read is — are the hover for a
 * mouse, and for everyone else the label's description and a keyboard tooltip.
 * Limits are not a live region: a poll moving a percentage is no reason to
 * interrupt a screen reader.
 */

export default function AccountLimitRows({ limits }: { limits: readonly AccountLimitSnapshot[] }) {
  const rows = limits.flatMap((snapshot) => {
    const text = accountLimitsText(snapshot);
    return text ? [{ snapshot, text }] : [];
  });
  if (rows.length === 0) return null;

  return (
    <span className="account-limits" role="group" aria-label="Account limits">
      {rows.map(({ snapshot, text }) => <InlineLimit key={snapshot.harness} snapshot={snapshot} text={text} />)}
    </span>
  );
}

function InlineLimit({ snapshot, text }: { snapshot: AccountLimitSnapshot; text: string }) {
  const detailsId = useId();
  const [bottom, setBottom] = useState<number>();
  const now = new Date();
  const details = accountLimitsTitle(snapshot, (at) => resumeTime(at, now));

  return (
    <>
      <span className={`account-limit${snapshot.status === 'stale' ? ' stale' : ''}`}
        tabIndex={0} title={details} aria-describedby={detailsId}
        onFocus={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setBottom(window.innerHeight - rect.top + 6);
        }}
        onBlur={() => setBottom(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setBottom(undefined);
            event.stopPropagation();
          }
        }}>
        {text}
      </span>
      <span id={detailsId} className="account-limit-details">
        {details.split('\n').map((line, index) => <span key={index}>{line}</span>)}
      </span>
      {bottom !== undefined && createPortal(
        <div className="account-limit-tooltip" role="tooltip" style={{ bottom }}>{details}</div>,
        document.body,
      )}
    </>
  );
}
