/**
 * What the first-run feedback notice says and where its actions go
 * (ADR-0075), one table for every surface so the TUI, the desktop app and
 * VS Code say the same. Pure, so a renderer may hold it; whether to show it
 * is `claimFirstRunFeedback`'s to say.
 */

export const FEEDBACK_DISCUSSION_URL = 'https://github.com/ordewell/ordewell/discussions/115';
export const REPOSITORY_URL = 'https://github.com/ordewell/ordewell';

export interface FeedbackAction {
  label: string;
  url: string;
}

export const FIRST_RUN_FEEDBACK: {
  readonly title: string;
  readonly text: string;
  readonly actions: readonly [feedback: FeedbackAction, star: FeedbackAction];
} = {
  title: 'How did it go?',
  text: 'Ordewell is open source and built in the open, and feedback from a first run is what it needs most.',
  actions: [
    { label: 'Tell us how it went', url: FEEDBACK_DISCUSSION_URL },
    { label: 'Star on GitHub', url: REPOSITORY_URL },
  ],
};
