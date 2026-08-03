/** The two batch surfaces — a folder drop, and the pipeline's own read-out.
 *  Presentational: both render state a vm produced and call back up. */
import type { IngestState } from '../vm/ingest.ts';
import type { OptimizeRunSummary } from '../vm/optimize.ts';
import type { QueueProgress } from '../vm/queue.ts';

export function IngestPanel({ state, onFiles }: { state: IngestState; onFiles: (files: File[]) => void }) {
  return (
    <div className="card">
      <h3>Ingest</h3>
      <input
        type="file"
        multiple
        // A folder drop is the real workflow: pCon has no batch export, so a
        // collection arrives as one file per model.
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length) onFiles(files);
        }}
      />
      {state.total ? (
        <>
          <div className="tiny muted">{state.done}/{state.total} · {state.current || (state.running ? 'working' : 'done')}</div>
          <div className="bar"><span style={{ width: `${Math.round((state.done / Math.max(1, state.total)) * 100)}%` }} /></div>
        </>
      ) : null}
      {state.pieces.length ? <div className="tiny">{state.pieces.length} piece(s) found.</div> : null}
      {state.failed.length ? (
        <ul className="list tiny level-warn">
          {state.failed.map((f, i) => <li key={`${f.name}-${i}`}>{f.name}: {f.error}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * THE PIPELINE, PASSIVELY. There is no «Run» button and no «Detect parts»
 * button: both were maintenance, not decisions — nobody should have to know
 * that a 3D file predates the current pipeline, or that a model was never
 * tagged. They run themselves; this only says what is in flight.
 */
export function PipelinePanel({
  status, progress, summary,
}: {
  status: { busy: boolean; label: string };
  progress: QueueProgress | null;
  summary: OptimizeRunSummary | null;
}) {
  return (
    <div className="card">
      <h3>Mesh pipeline</h3>
      <div className="tiny muted" aria-live="polite">
        {status.busy ? <span className="spinner" aria-hidden /> : null}{status.label}
      </div>
      {progress ? (
        <>
          <div className="bar"><span style={{ width: `${Math.round(progress.ratio * 100)}%` }} /></div>
          <div className="tiny muted">{progress.finished}/{progress.total} · {progress.current.join(', ') || '—'}</div>
        </>
      ) : null}
      {summary ? (
        <div className="tiny muted">
          {summary.optimized} re-exported · {summary.skipped} already current · {summary.failed} failed
          {summary.saved ? ` · saved ${(summary.saved / 1024 / 1024).toFixed(2)} MB (${Math.round(summary.savedRatio * 100)}%)` : ''}
        </div>
      ) : null}
      {summary?.casualties.length ? (
        <ul className="list tiny level-warn">
          {summary.casualties.map((c) => <li key={c}>{c}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
