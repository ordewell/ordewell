import { handlePlan } from './plan';
import { handleRun } from './run';
import { handleStatus } from './status';
import { handleStop } from './stop';
import { handleWeb } from './web';
import { handleModels } from './models';
import { handleSetup } from './setup';
import { handlePlugins } from './plugins';
import { handleTdd } from './tdd';
import { handleAllowlist } from './allowlist';
import { handleVerify } from './verify';
import { handleMarkComplete, handleSkip, handleUncomplete } from './mark-complete';
import { handleRunTask, handleForceStart, handleRetry, handleCancel } from './task-control';
import { handleAddTask } from './add-task';
import { handleRemoveTask } from './remove-task';
import { handleSessions } from './sessions';
import { handlePlanner, handlePlannerEffort } from './planner';
import { handleModel } from './model';
import { handleKey } from './key';
import { handleAuto, handleRefresh, handleRunners } from './runners';
import { handleApprove } from './approve';
import { handleTerminal } from './terminal';
import {
  handleTaskDeps, handleTaskEffort, handleTaskMode, handleTaskModel, handleTaskRunner,
} from './task-assign';
import { handleTui } from '../tui';

/**
 * The command surface. Feature-parity contract with the TUI's `SLASH_COMMANDS`:
 * anything reachable from a slash command is reachable from here, under the
 * same name, so `ordewell --help` and `/help` describe one product. The
 * exceptions are the two that only mean something inside a live TUI (`/new`,
 * `/quit`) and starting a plan, which is `plan --goal` here and typing the goal
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
  'stop-server': handleStop,
  models: handleModels,
  model: handleModel,
  planner: handlePlanner,
  'planner-effort': handlePlannerEffort,
  key: handleKey,
  runners: handleRunners,
  auto: handleAuto,
  refresh: handleRefresh,
  setup: handleSetup,
  plugins: handlePlugins,
  'tdd': handleTdd,
  'verify': handleVerify,
  'mark-complete': handleMarkComplete,
  complete: handleMarkComplete,
  uncomplete: handleUncomplete,
  skip: handleSkip,
  'run-task': handleRunTask,
  'force-start': handleForceStart,
  'retry': handleRetry,
  'cancel': handleCancel,
  'add-task': handleAddTask,
  'remove-task': handleRemoveTask,
  'task-runner': handleTaskRunner,
  'task-model': handleTaskModel,
  'task-effort': handleTaskEffort,
  'task-mode': handleTaskMode,
  'task-deps': handleTaskDeps,
  terminal: handleTerminal,
  'sessions': handleSessions,
  tui: handleTui,
};
