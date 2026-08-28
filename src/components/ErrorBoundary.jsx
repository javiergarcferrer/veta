import React from 'react';
import { AlertCircle, RefreshCw, WifiOff } from 'lucide-react';
import { captureError } from '../lib/errorLog.js';
import { isStaleChunkError, recoveryReload } from '../lib/dynamicImport.js';

/**
 * Last-resort guard against a React tree that throws during render. Without
 * this, an exception in any component crashes the whole SPA to a blank page.
 * The boundary catches it, logs to the console for debugging, and offers a
 * reload button so the user isn't stranded.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
    captureError(error, { type: 'render', source: 'ErrorBoundary', response: info?.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    // A failed code-split chunk fetch is not a code crash — it's a network
    // blip or a stale deploy that exhausted safeDynamicImport's in-place
    // retries + reload. Show connection-flavored copy, and recover via the
    // cache-busted navigation (a plain reload() can re-serve the stale iOS
    // PWA shell and land right back here — see lib/dynamicImport.ts).
    const chunkError = isStaleChunkError(this.state.error);
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50 p-6">
        <div className="card max-w-md w-full p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-50 text-red-600 mb-4">
            {chunkError ? <WifiOff size={22} /> : <AlertCircle size={22} />}
          </div>
          <h1 className="font-display text-lg font-semibold">
            {chunkError ? 'No se pudo cargar esta sección' : 'Algo salió mal'}
          </h1>
          <p className="text-sm text-ink-500 mt-2">
            {chunkError
              ? 'La descarga falló — puede ser un problema de conexión o una actualización de la app. Reintenta en un momento.'
              : 'La aplicación encontró un error inesperado. Recarga la página para continuar.'}
          </p>
          <pre className="surface-subtle mt-4 text-micro text-ink-500 p-3 text-left overflow-x-auto whitespace-pre-wrap break-words">
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => (chunkError ? recoveryReload() : window.location.reload())}
            className="btn-primary w-full justify-center mt-5"
          >
            <RefreshCw size={14} /> {chunkError ? 'Reintentar' : 'Recargar'}
          </button>
        </div>
      </div>
    );
  }
}
