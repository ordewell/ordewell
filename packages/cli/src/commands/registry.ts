import { handlePlan } from './plan';
import { handleRun } from './run';
import { handleStatus } from './status';
import { handleStop } from './stop';
import { handleWeb } from './web';
import { handleModels } from './models';
import { handleSetup } from './setup';
import { handleSkills } from './skills';
import { handleAllowlist } from './allowlist';
import { handleMarkComplete, handleSkip, handleUncomplete } from './mark-complete';
import { handleRevert } from './revert';
import { handleRunTask, handleForceStart, handleRetry, handleCancel, handleContinue, handleCheckpoint } from './task-control';
import { handleAddTask } from './add-task';
import { handleRemoveTask } from './remove-task';
import { handleSessions } from './sessions';
import { handleCompact, handleFork, handleResend, handleRewind } from './conversation';
import { handleHandoff } from './handoff';
import { handlePlanner, handlePlannerEffort } from './planner';
import { handleModel } from './model';
import { handleParallel } from './parallel';
import { handleAutomerge, handleAutorun, handleSupervisor, handleTrailer } from './runSettings';
import { handleKey } from './key';
import { handleAuto, handleRefresh, handleRunners } from './runners';
import { handleApprove } from './approve';
import {
  handleTaskDeps, handleTaskEffort, handleTaskMode, handleTaskModel, handleTaskOps, handleTaskRunner, handleTaskSkills,
} from './task-assign';
import { handleTui } from '../tui';

/**
 * The command surface. Feature-parity contract with the TUI's `SLASH_COMMANDS`:
 * anything reachable from a slash command is reachable from here, under the
 * same name, so `ordewell --help` and `/help` describe one product. The
 * exceptions are the TUI-only commands listed in `__tests__/parity.test.ts`,
 * each with the shell command that stands in for it or the reason none does,
 * and starting a plan, which is `plan --goal` here and typing the goal
 * there. `__tests__/parity.test.ts` holds the two lists to each other.
 */
export const COMMANDS: Record<string, (args: string[]) => Promise<void> | void> = {
  allowlist: handleAllowlist,
  web: handleWeb,
  plan: handlePlan,
  run: handleRun,
  approve: handleApprove,
  status: handleStatus,
  stop: handleStop,
  // An alias for `stop --server`: without the injected flag, handleStop takes
  // its no-argument branch and stops the last session instead of the daemon.
  'stop-server': (args) => handleStop(['--server', ...args]),
  models: handleModels,
  model: handleModel,
  planner: handlePlanner,
  'planner-effort': handlePlannerEffort,
  parallel: handleParallel,
  key: handleKey,
  runners: handleRunners,
  auto: handleAuto,
  supervisor: handleSupervisor,
  automerge: handleAutomerge,
  trailer: handleTrailer,
  autorun: handleAutorun,
  refresh: handleRefresh,
  setup: handleSetup,
  skills: handleSkills,
  'mark-complete': handleMarkComplete,
  complete: handleMarkComplete,
  uncomplete: handleUncomplete,
  revert: handleRevert,
  skip: handleSkip,
  'run-task': handleRunTask,
  'force-start': handleForceStart,
  'retry': handleRetry,
  'cancel': handleCancel,
  continue: handleContinue,
  checkpoint: handleCheckpoint,
  'add-task': handleAddTask,
  'remove-task': handleRemoveTask,
  'task-runner': handleTaskRunner,
  'task-model': handleTaskModel,
  'task-effort': handleTaskEffort,
  'task-mode': handleTaskMode,
  'task-deps': handleTaskDeps,
  'task-skills': handleTaskSkills,
  'task-ops': handleTaskOps,
  'sessions': handleSessions,
  fork: handleFork,
  compact: handleCompact,
  rewind: handleRewind,
  resend: handleResend,
  handoff: handleHandoff,
  tui: handleTui,
};
