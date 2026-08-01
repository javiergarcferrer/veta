/** Browser entry. The store is injected HERE and nowhere else — swapping the
 *  in-memory one for the member-plane adapter (`store/supabase.ts`, typed and
 *  mocked until a live project exists) is a one-line change at this boundary.
 *
 *  The demo seed exists so `vite build` produces something a human can open and
 *  click through; it is data, not behaviour, and no rule is stated in it. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import { createMemoryAdminStore } from './store/memory.ts';
import { demoSeed } from './demo.ts';
import './ui/admin.css';

const host = document.getElementById('root');
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App store={createMemoryAdminStore(demoSeed())} />
    </StrictMode>,
  );
}
