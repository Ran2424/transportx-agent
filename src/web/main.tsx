import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppProviders } from './app/AppProviders';
import { startBrowserApplication } from './app/composition-root';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('React root element is missing');

startBrowserApplication();

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
