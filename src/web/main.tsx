import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WebAuthGate } from './app/WebAuthGate';
import { LocaleProvider } from './i18n/LocaleProvider';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('React root element is missing');

const desktopPlatform = new URLSearchParams(window.location.search).get('desktop-platform');
if (desktopPlatform) document.documentElement.dataset.desktopPlatform = desktopPlatform;

createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <WebAuthGate />
    </LocaleProvider>
  </StrictMode>,
);
