import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@ordewell/ui/tokens.css';
import '@ordewell/ui/scale.css';
import '@ordewell/ui/design.css';
// ui's chat and task-log styles; before the desktop's own, so the frame's rules win where both speak.
import '@ordewell/ui/styles.css';
import './theme.css';
import './app.css';
import './welcome/welcome.css';
import './frame/frame.css';
import './session/session.css';
import './views/graph/graph.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
