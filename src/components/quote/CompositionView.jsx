import { useMemo } from 'react';
import { composePlanPreview } from '../../lib/togo/planPreview.js';
import { sanitizeSvg } from '../../lib/sanitizeSvg.js'; // SECURITY (L6): scrub untrusted SVG before innerHTML
import { resolveTogoScene, scenePlacementsFromPlaced } from '../../core/quote/index.js';
import { useTogoSceneSnapshot } from '../togo/togoThumbnails.js';

/**
 * WHAT THE CUSTOMER BUILT, in one frame — the picture every quoting surface
 * shows (the lead's detail, the quote, and the customer's own page).
 *
 * Sources, in order of truth:
 *   1. `image` — a node the caller already knows how to draw (the signed-in
 *      list hands its <ImageView> in). Kept as a prop rather than importing
 *      ImageView here, so the LOGGED-OUT customer page doesn't drag the whole
 *      data layer along to show one picture;
 *   2. `snapshotUrl` — the snapshot the VISITOR's own browser captured at
 *      submit, their exact view, frozen onto the quote: a document shows the
 *      picture that was made with it, never a re-render of today's catalog;
 *   3. failing that, a live offscreen 3D render of the same placements (older
 *      leads, captured before the widget sent a snapshot);
 *   4. failing that (no WebGL, still rendering), the flat top-down PLAN — the
 *      same `composePlanPreview` drawing the dealer inbox falls back to.
 *
 * The frame keeps the snapshot's own 3:2 so the page never reflows as the
 * render lands, and every source is centred inside it.
 */
export default function CompositionView({
  image = null,
  snapshotUrl = null,
  models = {},
  planItems = [],
  placed = [],
  alt = '',
  className = '',
}) {
  const plan = useMemo(
    () => (planItems.length ? composePlanPreview(models, planItems) : null),
    [models, planItems],
  );
  // Only pay for the 3D when there is no stored snapshot to show.
  const stored = !!image || !!snapshotUrl;
  const scene = useMemo(
    () => (stored || !placed.length ? null : resolveTogoScene(scenePlacementsFromPlaced(placed, models))),
    [stored, placed, models],
  );
  const rendered = useTogoSceneSnapshot(scene);
  const src = snapshotUrl || rendered;

  if (!image && !src && !plan) return null;
  return (
    <div className={`relative w-full aspect-[3/2] overflow-hidden ${className}`}>
      {image || (src ? (
        <img src={src} alt={alt} className="absolute inset-0 w-full h-full object-contain" />
      ) : (
        <div
          role="img"
          aria-label={alt}
          className="absolute inset-0 p-3 [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain"
          dangerouslySetInnerHTML={{ __html: sanitizeSvg(plan.svg) }}
        />
      ))}
    </div>
  );
}
