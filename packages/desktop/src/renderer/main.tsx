import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@ordewell/ui/tokens.css';
import '@ordewell/ui/scale.css';
import '@ordewell/ui/design.css';
import './theme.css';
import './app.css';
import './frame/frame.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
