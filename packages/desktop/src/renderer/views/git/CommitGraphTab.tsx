import { GitCommitHorizontal } from 'lucide-react';
import type { FrameApi, Unregister } from '../../frame/api';
import { Stub } from '../Stub';

/** The commit graph and a commit's detail (W12). Design slice 14 owns this file. */
function CommitGraphTab(): JSX.Element {
  return <Stub what="The commit graph" slice={14} />;
}

export function register(api: FrameApi): Unregister {
  return api.registerTabKind({ kind: 'commits', icon: GitCommitHorizontal, render: () => <CommitGraphTab /> });
}
