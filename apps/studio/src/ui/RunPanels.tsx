/** The two batch surfaces — a folder drop and the catalogue-wide re-export.
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

export function OptimizePanel({
  count, running, progress, summary, onRun,
}: {
  count: number;
  running: boolean;
  progress: QueueProgress | null;
  summary: OptimizeRunSummary | null;
  onRun: () => void;
}) {
  return (
    <div className="card">
      <h3>Optimize meshes</h3>
      <div className="row">
        <button type="button" onClick={onRun} disabled={running || !count}>Run</button>
        <span className="tiny muted">{count} optimizable GLB(s)</span>
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
    </div>
  );
}
