import { AlertTriangle, Check, GitMerge } from 'lucide-react';
import type { GitActionResponse } from '@ordewell/core';
import { Badge, Icon } from '@ordewell/ui/design';
import type { ConfirmationRequest } from '@ordewell/ui/host';
import type { FrameApi } from '../../frame/api';
import { confirmWith } from '../../session/ConfirmDialog';
import { callDaemon, messageOf } from '../../session/daemon';
import type { DaemonHost } from '../../session/DaemonHost';
import { parsePreflight, preflightModel, repoName, stashPlan, type PreflightChoice, type PreflightRow } from './preflight';

/**
 * The command the checkout's changes (design slice 13) registers to put the
 * cursor in its commit box: Commit first hands over to it. Until it is
 * registered, Commit first only shows the Changes activity.
 */
export const FOCUS_COMMIT_COMMAND = 'checkout.focusCommit';

export type Ask = (request: ConfirmationRequest<PreflightChoice>, body: JSX.Element) => Promise<PreflightChoice | null>;

function Repos({ rows }: { rows: PreflightRow[] }): JSX.Element {
  return (
    <ul className="changes-preflight" aria-label="Where it lands">
      {rows.map((row) => (
        <li key={row.repo} className="changes-preflight-repo">
          <div className="changes-preflight-line">
            <Icon icon={GitMerge} size={16} />
            <span className="changes-preflight-landing">Lands on <strong>{row.branch}</strong> in {repoName(row.repo)}</span>
            {row.overlap.length === 0 && <Badge tone="passed" icon={Check}>clean</Badge>}
          </div>
          {row.overlap.length > 0 && (
            <>
              <p className="changes-preflight-warning"><Icon icon={AlertTriangle} size={16} />Your uncommitted changes touch files this merge changes:</p>
              <ul className="changes-preflight-files" aria-label={`Your uncommitted files in ${repoName(row.repo)} the run also changed`}>
                {row.overlap.map((path) => <li key={path} title={path}><code>{path}</code></li>)}
              </ul>
            </>
          )}
          {row.otherDirty && <p className="changes-preflight-other">Other uncommitted files stay as they are: the merge does not touch them.</p>}
        </li>
      ))}
    </ul>
  );
}

/** Gives back what a Stash choice set aside, each repo's by the stash it made (never the top of the shared stack). */
async function restore(api: FrameApi, stashes: Array<{ repo: string; sha: string }>): Promise<string[]> {
  const said: string[] = [];
  for (const { repo, sha } of stashes) {
    try {
      const answer = await callDaemon('git.stashPop', {}, { workspace: api.workspace, repo, stash: sha }) as GitActionResponse;
      if (answer.warning) said.push(answer.warning);
    } catch (error) {
      said.push(`${repoName(repo)}: ${messageOf(error)} Your changes are kept in stash ${sha.slice(0, 12)}.`);
    }
  }
  return said;
}

function offerRestore(api: FrameApi, stashes: Array<{ repo: string; sha: string }>, merged: boolean): void {
  const close = api.showBanner({
    id: 'changes.restoreStash',
    tone: merged ? 'info' : 'warning',
    title: merged ? 'The run merged. Your uncommitted changes are stashed.' : 'The run did not merge. Your uncommitted changes are stashed.',
    actions: [{
      label: 'Restore my changes',
      run: async () => {
        close();
        const problems = await restore(api, stashes);
        if (problems.length === 0) { api.announce('Your changes are restored.'); return; }
        api.showBanner({ id: 'changes.restoreStash', tone: 'warning', title: 'Some changes could not be restored as they were', body: problems.join('\n') });
      },
    }],
  });
}

/**
 * Commit first opens the commit box with the overlapping files staged (G8). A
 * file that will not stage is said, and the box opens regardless: committing
 * is still the person's to do, by hand.
 */
async function stageOverlap(api: FrameApi, plan: Array<{ repo: string; paths: string[] }>): Promise<void> {
  const problems: string[] = [];
  for (const { repo, paths } of plan) {
    try {
      await callDaemon('git.stage', {}, { workspace: api.workspace, repo, paths });
    } catch (error) {
      problems.push(`${repoName(repo)}: ${messageOf(error)}`);
    }
  }
  if (problems.length > 0) {
    api.showBanner({ id: 'changes.mergeAll', tone: 'warning', title: 'Your overlapping files could not be staged', body: problems.join('\n') });
  }
}

/**
 * Merge all, preflight first (ADR-0062 G8): the daemon names the user's
 * uncommitted files the run also changed, and the person chooses before
 * anything moves. A Stash sets aside only those files, under the message the
 * daemon gave, and the stash is restored by its own sha after the merge.
 */
export async function mergeAll(api: FrameApi, host: DaemonHost, ask: Ask = confirmWith): Promise<void> {
  let model;
  let stashMessage: string;
  let plan: Array<{ repo: string; paths: string[] }>;
  try {
    const response = parsePreflight(await callDaemon('plans.mergePreflight', { sessionId: host.sessionId, workspace: api.workspace }));
    if (!response) throw new Error('The daemon sent a preflight this app cannot read.');
    const { state } = host.getSnapshot();
    model = preflightModel(response, state.run.handoff ?? state.run.runMerge, state.isExecuting);
    stashMessage = response.stashMessage;
    plan = stashPlan(response);
  } catch (error) {
    api.showBanner({ id: 'changes.mergeAll', tone: 'error', title: 'Merge all could not check your checkout', body: messageOf(error) });
    return;
  }

  const choice = await ask(model.request, <Repos rows={model.rows} />);
  switch (choice) {
    case null:
      return;
    case 'commit':
      await stageOverlap(api, plan);
      api.showActivity('changes');
      api.runCommand(FOCUS_COMMIT_COMMAND);
      return;
    case 'merge':
      await host.mergeConfirmed();
      return;
    case 'stash': {
      const stashes: Array<{ repo: string; sha: string }> = [];
      try {
        for (const { repo, paths } of plan) {
          const answer = await callDaemon('git.stash', {}, { workspace: api.workspace, repo, paths, message: stashMessage }) as GitActionResponse;
          if (answer.stash) stashes.push({ repo, sha: answer.stash.sha });
        }
      } catch (error) {
        // A merge over half the files set aside is not what was asked: put back what was taken, and stop.
        const problems = await restore(api, stashes);
        api.showBanner({ id: 'changes.mergeAll', tone: 'error', title: 'Merge all stopped: your changes could not be stashed', body: [messageOf(error), ...problems].join('\n') });
        return;
      }
      const merged = await host.mergeConfirmed();
      if (stashes.length > 0) offerRestore(api, stashes, merged);
      return;
    }
  }
}
