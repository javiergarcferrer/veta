/**
 * THE PASTE-IN SNIPPET — the lowest-common-denominator embed: a self-sizing
 * iframe plus ~300 bytes of inline script, no build step, no npm, works in a
 * CMS text block. Ported from the reference's `togoEmbedSnippet` with its two
 * hard-won layout decisions intact (see the comments inside `embedSnippet`).
 *
 * The generated markup is deliberately boring — one wrapper div, one iframe, one
 * IIFE — because it is pasted into pages we do not control and must not fight
 * their CSS, their CSP nonces (no external script), or their other embeds
 * (the listener checks BOTH the message marker and the frame identity).
 */

import { EMBED_ALLOW, widgetUrl, type WidgetUrlOptions } from './urls.ts';
import { WIDGET_SOURCE } from './protocol.ts';

export interface EmbedSnippetOptions extends WidgetUrlOptions {
  /** `<iframe title>` — what a screen reader announces. Default: the brand-neutral
   *  "Configurator". Pass the brand name; it is read aloud. */
  title?: string;
  /**
   * The height the frame renders at BEFORE the app reports its own. See the
   * long note in the implementation: seeding TALL is the safe direction.
   */
  seedHeightPx?: number;
  /** Horizontal inset around the frame; the default eases down on phones. */
  inset?: string;
  /** Extra attributes on the wrapper (`data-*` for the host's own analytics). */
  wrapperAttributes?: Record<string, string> | null;
}

/** The wrapper's marker attribute — how the inline script finds its own frame. */
export const EMBED_MARKER = 'data-veta-embed';

/** The default seed height. */
export const DEFAULT_SEED_HEIGHT_PX = 700;

const escapeAttr = (value: string): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * The self-sizing embed, as a string of HTML.
 *
 * TWO decisions carried over verbatim from the reference, both of them scars:
 *
 * • FULL WIDTH of whatever column it is dropped into, inset a little. An earlier
 *   `max-width:480px` left the card as a narrow strip in a ~1000px content
 *   column with a third of the page empty either side. The app is responsive on
 *   its own (it re-lays out at its breakpoints), so handing it the real width is
 *   what lets that work at all; the cap was pinning it in its phone layout
 *   forever. The inset is a `clamp()` because a fixed 80px of total padding on a
 *   375px phone would cramp everything inside the frame.
 *
 * • The SEED HEIGHT is generous (700px). The postMessage below only ever
 *   RESIZES — a phone reports ~560 and the frame shrinks to it immediately.
 *   Seeding SHORT is the bad direction: the host page visibly jumps the moment
 *   the app reports, and a host whose CSP or ad-blocker never runs the script at
 *   all would clip the call-to-action outright.
 */
export function embedSnippet(opts: EmbedSnippetOptions): string {
  const src = widgetUrl(opts);
  const title = escapeAttr(opts.title ?? 'Configurator');
  const seed = Number(opts.seedHeightPx);
  const height = Number.isFinite(seed) && seed > 0 ? Math.round(seed) : DEFAULT_SEED_HEIGHT_PX;
  const inset = opts.inset ?? 'clamp(16px,4vw,40px)';
  const extra = Object.entries(opts.wrapperAttributes ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');

  // The listener: last-marked wrapper (so several embeds on one page each bind
  // their OWN frame), guarded against double-binding, and accepting a height
  // ONLY from this frame's contentWindow carrying our marker.
  const script =
    `(function(){var B=document.querySelectorAll('[${EMBED_MARKER}]');var box=B[B.length-1];`
    + `if(!box||box.getAttribute('data-ready'))return;box.setAttribute('data-ready','1');`
    + `var ifr=box.querySelector('iframe');window.addEventListener('message',function(e){var d=e.data;`
    + `if(d&&d.source==='${WIDGET_SOURCE}'&&d.type==='height'&&d.payload&&d.payload.height>0`
    + `&&ifr&&e.source===ifr.contentWindow){ifr.style.height=d.payload.height+'px'}})})();`;

  return `<!-- VETA configurator — self-sizing embed -->
<div ${EMBED_MARKER} style="width:100%;margin:0 auto;padding:0 ${inset};box-sizing:border-box"${extra}>
  <iframe src="${escapeAttr(src)}" title="${title}" scrolling="no" allow="${EMBED_ALLOW}" style="width:100%;border:0;display:block;height:${height}px;overflow:hidden;color-scheme:light"></iframe>
</div>
<script>${script}</script>`;
}
