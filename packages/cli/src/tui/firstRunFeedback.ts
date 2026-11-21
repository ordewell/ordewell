import { FIRST_RUN_FEEDBACK } from '@ordewell/core';

/**
 * The first-run feedback notice as the terminal says it (ADR-0075): a line in
 * the conversation, since anything that took keys would take them from the
 * composer, and a slash command for each of core's actions, since a terminal
 * has no button and a link it prints may not be one it opens.
 */
const [feedback, star] = FIRST_RUN_FEEDBACK.actions;

/** Each action's command, by name without its slash, and the page it opens. */
export const FEEDBACK_COMMANDS: Readonly<Record<'feedback' | 'star', string>> = {
  feedback: feedback.url,
  star: star.url,
};

export const FIRST_RUN_FEEDBACK_LINE =
  `${FIRST_RUN_FEEDBACK.title} ${FIRST_RUN_FEEDBACK.text} ${feedback.label}: /feedback · ${star.label}: /star`;
