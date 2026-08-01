/**
 * The widget's entry point. Deliberately tiny: mount the app, and nothing else.
 *
 * No global side effects, no analytics, no theme stamping — this bundle runs
 * inside someone else's page and should touch exactly one DOM node.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

const host = document.getElementById('veta-widget');
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
