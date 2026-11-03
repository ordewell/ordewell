import React from 'react';
import type { IsolationPreview } from '@ordewell/core';
import { describeIsolationPreview } from '@ordewell/core/plan-utils';

interface IsolationNoticeProps {
  /** `undefined`: the host has not said yet; `null`: it is reading the repositories again. */
  preview: IsolationPreview | null | undefined;
}

/**
 * Core's row sentence names a branch and its commit as `on main (3a775192)`,
 * with what the row warns about after it. The card sets the commit apart as its
 * own token, so the one head shape that carries one is split; a detached HEAD,
 * an unborn branch or an unread one is shown whole, exactly as core said it,
 * since nothing is gained by putting its commit in a chip of its own.
 */
function splitRepoDetail(detail: string): { head: string; commit?: string; flag?: string } {
  const match = /^(on \S+) \(([0-9a-f]{7,40})\)(?: · (.*))?$/.exec(detail);
  if (!match) return { head: detail };
  return { head: match[1], commit: match[2], flag: match[3] };
}

/** The one repo of a workspace is named; a group's repos are named by their workspace-relative path. */
const isPathRepo = (preview: IsolationPreview, i: number) => preview.repos[i]?.path !== '.';

/**
 * Which repositories and branches Ordewell found and whether code tasks get
 * isolated worktrees, on both first screens: a card of its own, so the one
 * block on the screen that describes the workspace reads as a thing rather
 * than as more prose. The text is selectable and wraps, so a long path or
 * branch stays whole in a narrow sidebar.
 */
export default function IsolationNotice({ preview }: IsolationNoticeProps) {
  if (preview === undefined) return null;
  // Before the first answer there is nothing to put in a card, and an empty one would be a promise.
  if (preview === null) return <p className="isolation-notice isolation-notice-checking" role="status">Checking repositories…</p>;
  const notice = describeIsolationPreview(preview);
  return (
    <section className="isolation-notice" data-status={preview.status} aria-label="Repositories and branches">
      <h3 className="isolation-notice-title">Repositories and branches</h3>
      <p className="isolation-notice-summary">{notice.summary}</p>
      {notice.repos.length > 0 && (
        <ul className="isolation-repos">
          {notice.repos.map((repo, i) => {
            const { head, commit, flag } = splitRepoDetail(repo.detail);
            return (
              <li key={`${i}:${repo.name}`} className="isolation-repo">
                <span className={`isolation-repo-name${isPathRepo(preview, i) ? ' path' : ''}`}>{repo.name}</span>
                <span className="isolation-repo-detail">
                  <span className="isolation-repo-head">{head}</span>
                  {commit && <code className="isolation-repo-commit">{commit}</code>}
                  {flag && <span className="isolation-repo-flag">{flag}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(notice.shared || notice.note) && (
        <div className="isolation-notice-footer">
          {notice.shared && <p className="isolation-notice-shared">{notice.shared}</p>}
          {notice.note && <p className="isolation-notice-note">{notice.note}</p>}
        </div>
      )}
    </section>
  );
}
