import React from 'react';
import ReactDOM from 'react-dom/client';
import { TaskLogApp, TaskLogBridgeContext } from '@ordewell/ui';
import { vscodeBridge } from '../vscodeBridge';
import '../styles.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <TaskLogBridgeContext.Provider value={vscodeBridge()}>
    <TaskLogApp />
  </TaskLogBridgeContext.Provider>,
);
