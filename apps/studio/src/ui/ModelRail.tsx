/** The rail of models: what exists, what ships, what is still blocked. Renders
 *  `resolvePublishSummary` — no counting happens here. */
import type { PublishSummary } from '../vm/publish.ts';
import type { StudioModel } from '../vm/types.ts';

interface RailProps {
  models: readonly StudioModel[];
  selectedId: string | null;
  summary: PublishSummary;
  onSelect: (id: string) => void;
}

export function ModelRail({ models, selectedId, summary, onSelect }: RailProps) {
  return (
    <div className="rail">
      <div className="pane tiny muted">
        {summary.total} models · {summary.published} published · {summary.ready} ready
      </div>
      {models.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`rail-item${m.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(m.id)}
        >
          <span className={`dot ${m.status}`} />
          <span className="name">{m.name || '(unnamed)'}</span>
          <div className="tiny muted">
            {[m.collection || 'no collection', m.mesh ? 'mesh' : 'no mesh', m.productRoot || 'no SKU'].join(' · ')}
          </div>
        </button>
      ))}
      {!models.length ? <div className="pane muted tiny">Drop a folder to ingest a library.</div> : null}
    </div>
  );
}
