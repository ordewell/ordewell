import React from 'react';
import TaskLogApp from '../tasklog/TaskLogApp';
import { TaskLogBridgeContext } from '../bridge';
import type { HostToTaskLog, TaskLogToHost } from '../shared/taskLogProtocol';
import { testBridge } from './hostApi';

const bridge = testBridge<TaskLogToHost, HostToTaskLog>();

/** The task log as a host mounts it, wired to the test's host. */
export default function TestTaskLogApp() {
  return <TaskLogBridgeContext.Provider value={bridge}><TaskLogApp /></TaskLogBridgeContext.Provider>;
}
