/** Browser entry. The store is injected here and NOWHERE else — swapping the
 *  in-memory one for the member-plane adapter is a one-line change at this
 *  boundary (see `store/supabase.ts`, which is typed and mocked until a live
 *  project exists). */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/studio.css';

const host = document.getElementById('root');
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
