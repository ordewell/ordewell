import React from 'react';
import { capConflictFiles, handoffBaseLine, handoffBranchName, isRepoGroup, mergeOutcome, repoBaseLine, repairedLanded } from '@ordewell/core/plan-utils';
import type { IsolationHandoffRepo, IsolationLandedTask, IsolationMergeResult } from '@ordewell/core';

/** So the reviewer knows where to look (ADR-0015). */
function RepairedNote({ files }: { files: string[] }) {
  return <span className="isolation-handoff-repaired">: repaired ({capConflictFiles(files)})</span>;
}

interface HandoffCardProps {
  /** The run's repos, in core's handoff shape: the card only draws what core worded. */
  repos: readonly IsolationHandoffRepo[];
  landed: readonly IsolationLandedTask[];
  /** An Act supervisor looks at this run when it wakes and may merge it; the actions stay the user's too. */
  deferredTo?: 'supervisor';
  /** The result of the last Merge all, so a blocked or part-landed group is visible. */
  mergeResult?: IsolationMergeResult | null;
  /**
   * Set while the run is still going and tasks wait at a merge gate
   * (ADR-0020): only reviewing and Merge all are offered, and `paused` says
   * nothing else is running.
   */
  midRun?: { paused: boolean };
  /** Every action here is available once the run is settled; mid-run, only review and merge. */
  onAction: (action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup') => void;
}

function sortLanded(tasks: readonly IsolationLandedTask[]): IsolationLandedTask[] {
  return [...tasks].sort((a, b) => a.order - b.order);
}

/**
 * What Merge all did and what to do next, in core's words so the card and the
 * TUI cannot disagree about a blocked, part-landed or failed merge — for a
 * lone repo as well as a group.
 */
function MergeOutcome({ result, branch, group, repaired }: { result: IsolationMergeResult; branch: string; group: boolean; repaired: readonly IsolationLandedTask[] }) {
  const { message } = mergeOutcome(result, branch, group, repaired);
  return <div className={`isolation-merge-result ${result.outcome}`}>{message}</div>;
}

/**
 * The end of an isolated run (ADR-0013). Unless the user opted in to automatic
 * merging or a supervisor at Act merges, Ordewell does not merge into the
 * checked-out branch, so this is where that irreversible step is offered — next to the one artifact to review it with, the integration branch.
 * A repo group (ADR-0014) reports per repo and merges all-or-nothing; a group
 * of one reads exactly as it did before.
 */
export default function HandoffCard({ repos, landed, deferredTo, mergeResult, midRun, onAction }: HandoffCardProps) {
  const sorted = sortLanded(landed);
  const isGroup = isRepoGroup({ repos });
  const branch = handoffBranchName({ repos });
  const base = handoffBaseLine({ repos }, 12);
  return (
    <div className="isolation-handoff">
      <div className="isolation-handoff-header">
        <span className="isolation-handoff-title">
          {midRun
            ? midRun.paused ? 'Paused for Merge all: tasks wait for this work in your branch' : 'Tasks wait for Merge all: merge what has landed so far'
            : <>Run complete: review the integration branch</>}
        </span>
        <code className="isolation-handoff-branch">{branch}</code>
      </div>
      {deferredTo === 'supervisor' && (
        <div className="isolation-handoff-deferred">The supervisor may merge this when it wakes. You can review or merge it yourself meanwhile.</div>
      )}
      {isGroup ? (
        <>
          <div className="isolation-handoff-base">
            {sorted.length} task{sorted.length === 1 ? '' : 's'} landed across {repos.length} repositories
          </div>
          <div className="isolation-handoff-repos">
            {repos.map((repo) => (
              <div key={repo.path} className="isolation-handoff-repo">
                <code className="isolation-handoff-repo-path">{repo.path}</code>
                <span className="isolation-handoff-repo-base">on <code>{repoBaseLine(repo, 12)}</code></span>
                {repo.landed.length > 0 && (
                  <ul className="isolation-handoff-landed">
                    {sortLanded(repo.landed).map((t) => (
                      <li key={t.taskId}>
                        <span className="isolation-handoff-order">{t.order}</span>
                        {t.title}
                        {t.repairedFiles && t.repairedFiles.length > 0 && <RepairedNote files={t.repairedFiles} />}
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
            {sorted.length} task{sorted.length === 1 ? '' : 's'} landed on top of <code>{base}</code>
          </div>
          {sorted.length > 0 && (
            <ul className="isolation-handoff-landed">
              {sorted.map((t) => (
                <li key={t.taskId}>
                  <span className="isolation-handoff-order">{t.order}</span>
                  {t.title}
                  {t.repairedFiles && t.repairedFiles.length > 0 && <RepairedNote files={t.repairedFiles} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {mergeResult && (
        <MergeOutcome
          result={mergeResult}
          branch={branch}
          group={isGroup}
          repaired={repairedLanded({ landed: sorted })}
        />
      )}
      <div className="isolation-handoff-actions">
        <button className="task-action-btn" onClick={() => onAction('reviewDiff')}>Review diff</button>
        <button className="task-action-btn run" onClick={() => onAction('merge')}>{isGroup ? 'Merge all' : 'Merge'}</button>
        {!midRun && <button className="task-action-btn skip" onClick={() => onAction('cleanup')}>Clean up</button>}
        {!midRun && <button className="task-action-btn cancel" onClick={() => onAction('discard')}>Discard</button>}
      </div>
    </div>
  );
}
