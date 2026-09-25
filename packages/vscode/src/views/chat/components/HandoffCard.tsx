import React from 'react';
import type { IsolationMergeBlock, IsolationMergeResult } from '@ordewell/core';

export interface HandoffLandedTask {
  taskId: string;
  order: number;
  title: string;
}

export interface HandoffRepo {
  path: string;
  integrationBranch: string;
  baseRef: string;
  /** Tasks whose work landed in this repo, in plan order. */
  landed?: HandoffLandedTask[];
}

interface HandoffCardProps {
  repos: HandoffRepo[];
  landed: HandoffLandedTask[];
  /** The result of the last Merge all, so a blocked or part-landed group is visible. */
  mergeResult?: IsolationMergeResult | null;
  /** The run is settled, so every action here is available. */
  onAction: (action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup') => void;
}

function sortLanded(tasks: HandoffLandedTask[]): HandoffLandedTask[] {
  return [...tasks].sort((a, b) => a.order - b.order);
}

/** Why one repo kept Merge all from touching anything, as one line. */
function blockReason({ reason, files }: IsolationMergeBlock): string {
  switch (reason) {
    case 'merge-in-progress': return 'has a merge in progress';
    case 'conflict': return `would conflict${files.length > 0 ? ` in ${files.join(', ')}` : ''}`;
    case 'uncommitted-changes': return `has uncommitted changes${files.length > 0 ? ` to ${files.join(', ')}` : ''}`;
    case 'partial-landing': return 'holds part of a task whose landing could not be rolled back';
    case 'git-error': return 'could not be checked by git';
  }
}

/**
 * What Merge all did after it ran. `blocked` is all-or-nothing across the group;
 * a group old enough to lack `merge-tree --write-tree` merges in turn and names
 * the repos it already landed instead.
 */
function MergeOutcome({ result, branch }: { result: IsolationMergeResult; branch: string }) {
  if (result.outcome === 'merged') {
    return <div className="isolation-merge-result merged">Merged every repository&rsquo;s integration branch.</div>;
  }
  if (result.outcome === 'blocked') {
    return (
      <div className="isolation-merge-result blocked">
        <div className="isolation-merge-blocked-title">Merged nothing, so every tree is as it was:</div>
        <ul className="isolation-merge-blocks">
          {result.blocked.map((block) => (
            <li key={block.repo} className="isolation-merge-block">
              <code>{block.repo}</code> {blockReason(block)}
            </li>
          ))}
        </ul>
        <div className="isolation-merge-hint">
          Each repository&rsquo;s <code>{branch}</code> branch can be merged by hand.
        </div>
      </div>
    );
  }
  return (
    <div className={`isolation-merge-result ${result.outcome}`}>
      <div className="isolation-merge-stopped">
        Merging stopped in <code>{result.repo}</code>
        {result.files && result.files.length > 0 ? ` (${result.files.join(', ')})` : ''}.
      </div>
      {result.landed && result.landed.length > 0 && (
        <div className="isolation-merge-landed">{result.landed.join(', ')} were merged already and stay merged.</div>
      )}
    </div>
  );
}

/**
 * The end of an isolated run (ADR-0013). Ordewell never merges into the
 * checked-out branch on its own, so this is where that irreversible step is
 * offered — next to the one artifact to review it with, the integration branch.
 * A repo group (ADR-0014) reports per repo and merges all-or-nothing; a group
 * of one reads exactly as it did before.
 */
export default function HandoffCard({ repos, landed, mergeResult, onAction }: HandoffCardProps) {
  const sorted = sortLanded(landed);
  const isGroup = repos.length > 1;
  // Every repo's integration branch has the same name.
  const branch = [...new Set(repos.map((r) => r.integrationBranch))].join(', ');
  const baseRef = repos.map((r) => r.baseRef.slice(0, 12)).join(', ');
  return (
    <div className="isolation-handoff">
      <div className="isolation-handoff-header">
        <span className="isolation-handoff-title">Run complete &mdash; review the integration branch</span>
        <code className="isolation-handoff-branch">{branch}</code>
      </div>
      {isGroup ? (
        <>
          <div className="isolation-handoff-base">
            {sorted.length} task{sorted.length === 1 ? '' : 's'} landed across {repos.length} repositories
          </div>
          <div className="isolation-handoff-repos">
            {repos.map((repo) => (
              <div key={repo.path} className="isolation-handoff-repo">
                <code className="isolation-handoff-repo-path">{repo.path}</code>
                <span className="isolation-handoff-repo-base">on <code>{repo.baseRef.slice(0, 12)}</code></span>
                {repo.landed && repo.landed.length > 0 && (
                  <ul className="isolation-handoff-landed">
                    {sortLanded(repo.landed).map((t) => (
                      <li key={t.taskId}>
                        <span className="isolation-handoff-order">{t.order}</span>
                        {t.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="isolation-handoff-base">
            {sorted.length} task{sorted.length === 1 ? '' : 's'} landed on top of <code>{baseRef}</code>
          </div>
          {sorted.length > 0 && (
            <ul className="isolation-handoff-landed">
              {sorted.map((t) => (
                <li key={t.taskId}>
                  <span className="isolation-handoff-order">{t.order}</span>
                  {t.title}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {mergeResult && isGroup && <MergeOutcome result={mergeResult} branch={repos[0]?.integrationBranch ?? ''} />}
      <div className="isolation-handoff-actions">
        <button className="task-action-btn" onClick={() => onAction('reviewDiff')}>Review diff</button>
        <button className="task-action-btn run" onClick={() => onAction('merge')}>{isGroup ? 'Merge all' : 'Merge'}</button>
        <button className="task-action-btn skip" onClick={() => onAction('cleanup')}>Clean up</button>
        <button className="task-action-btn cancel" onClick={() => onAction('discard')}>Discard</button>
      </div>
    </div>
  );
}
