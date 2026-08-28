import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { sizedExternalUrl, SCREEN_IMG_WIDTH } from '../lib/catalogImages.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import { ImageOff } from 'lucide-react';

export interface ImageViewProps {
  id: string | null | undefined;
  /**
   * Rendered when `id` is absent or resolves to nothing — e.g. a Ligne Roset
   * swatch URL derived from a color code. A loaded `id` (an uploaded photo)
   * always wins; if the chosen URL fails to load we fall to the placeholder.
   */
  fallbackUrl?: string | null;
  alt?: string;
  className?: string;
  placeholderClassName?: string;
  style?: CSSProperties;
  /**
   * When true, hovering the (small) image on a fine-pointer device pops up an
   * enlarged floating preview next to it. No-op on touch (no real hover) — the
   * customer-facing preview keeps its tap-to-zoom Modal there.
   */
  hoverPreview?: boolean;
  /**
   * Opt-in: fade the image from transparent to opaque over ~500ms once it has
   * actually loaded. Default off so every existing caller renders unchanged.
   * Honors prefers-reduced-motion (shows instantly, no transition).
   */
  fadeIn?: boolean;
  /**
   * Opt-in: this image is the reason the surface exists (a full-screen product
   * sheet, a hero), so fetch it NOW at high priority instead of letting the
   * default `loading="lazy"` deprioritize it. Lazy is right for the dozens of
   * images in a grid and wrong for the one the visitor just asked to see.
   */
  eager?: boolean;
  /**
   * Opt-in responsive candidates for THIS image. Only applied when the rendered
   * url is the caller's own `fallbackUrl` — the caller built the set from that
   * url, so if ImageView resolved a different one (the `id` lookup path) the
   * set would describe the wrong file and is dropped rather than mismatched.
   */
  srcSet?: string | null;
  sizes?: string | null;
}

interface PreviewBox { left: number; top: number; width: number }

/**
 * Resolve the url of a STORED image (an `images` row) — the only path that
 * needs `db` + the Storage client, and the reason both are behind an import().
 *
 * ImageView is app-wide, but the public configurator (the logged-out iframe at
 * /configurador) renders every image from a plain url — `id` is null on all of
 * them — and the static imports still dragged `db/database` plus the Supabase
 * auth client into that boot path: a module-scope `createClient`
 * (persistSession + autoRefreshToken + detectSessionInUrl → localStorage reads,
 * a refresh timer, URL parsing) for a lookup that surface never performs.
 * Behind `safeDynamicImport` (the repo rule for code-split imports — it
 * survives a stale deploy) the chunk is fetched by the first id-bearing image
 * of the session and cached from then on. The resolution ORDER is unchanged
 * (externalUrl → publicImageUrl(storagePath) → the caller's fallbackUrl →
 * placeholder) and the extra await is invisible: the placeholder already
 * covered the db round-trip this replaces.
 */
async function resolveStoredUrl(id: string): Promise<string | null> {
  const [{ db }, { publicImageUrl }] = await Promise.all([
    safeDynamicImport(() => import('../db/database.js')),
    safeDynamicImport(() => import('../db/supabaseClient.js')),
  ]);
  const rec = await db.images.get(id);
  // A CDN pointer row (LSG catalog photo) serves straight from the store's
  // CDN — width-capped; bytes never live in our bucket.
  return (rec?.externalUrl ? sizedExternalUrl(rec.externalUrl, SCREEN_IMG_WIDTH) : null)
    || (rec?.storagePath ? publicImageUrl(rec.storagePath) : null);
}

function canHover(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Renders an image stored in Supabase Storage by its image-table id.
 * Falls back to a neutral placeholder when missing.
 */
export default function ImageView({ id, fallbackUrl = null, alt = '', className = '', placeholderClassName = '', style, hoverPreview = false, fadeIn = false, eager = false, srcSet = null, sizes = null }: ImageViewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [errored, setErrored] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [preview, setPreview] = useState<PreviewBox | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setErrored(false);
    if (!id) {
      setUrl(fallbackUrl);
      setMissing(!fallbackUrl);
      return () => { active = false; };
    }
    setMissing(false);
    resolveStoredUrl(id).then((stored) => {
      if (!active) return;
      const u = stored || fallbackUrl;
      setUrl(u);
      setMissing(!u);
    }).catch(() => {
      if (!active) return;
      setUrl(fallbackUrl);
      setMissing(!fallbackUrl);
    });
    return () => { active = false; };
  }, [id, fallbackUrl]);

  // Dismiss the floating preview if the page scrolls or resizes underneath it.
  useEffect(() => {
    if (!preview) return undefined;
    const close = () => setPreview(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [preview]);

  // Fade-in reveal: seed `loaded` from the element whenever the URL (re)mounts.
  // A cached image is already `complete` and never fires onLoad, so without this
  // ref check it would stay stuck at opacity 0 (flash-from-0); a fresh image
  // resets to false and waits for the onLoad handler below.
  useLayoutEffect(() => {
    if (!fadeIn) return;
    setLoaded(Boolean(imgRef.current?.complete));
  }, [fadeIn, url]);

  function openPreview() {
    if (!hoverPreview || !url || !canHover()) return;
    const el = imgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const width = Math.min(420, Math.round(vw * 0.4));
    // Prefer to the right of the thumbnail; flip to the left when it would
    // overflow; clamp into the viewport either way.
    let left = r.right + margin;
    if (left + width > vw - margin) left = r.left - margin - width;
    if (left < margin) left = margin;
    // Keep the (variable-height) box on screen: reserve a generous estimate
    // and clamp the top edge so it never spills past the bottom.
    const estH = Math.min(Math.round(vh * 0.7), Math.round(width * 1.4));
    let top = r.top;
    if (top + estH > vh - margin) top = Math.max(margin, vh - margin - estH);
    if (top < margin) top = margin;
    setPreview({ left, top, width });
  }

  if (missing || !url || errored) {
    return (
      <div className={`flex items-center justify-center bg-ink-100 text-ink-500 ${placeholderClassName || className}`}>
        <ImageOff size={18} />
      </div>
    );
  }
  // Fade classes merge on top of the caller's className; when fadeIn is off (or
  // reduced motion is requested) the className passes through untouched so
  // existing consumers render byte-identically.
  const imgClassName = fadeIn && !prefersReducedMotion()
    ? `${className} transition-opacity duration-500 ease-out ${loaded ? 'opacity-100' : 'opacity-0'}`.trim()
    : className;
  // The candidate set describes the caller's OWN url, so only honour it when
  // that is what we ended up rendering (see the prop docs).
  const responsive = srcSet && url === fallbackUrl;
  return (
    <>
      <img
        ref={imgRef}
        src={url}
        srcSet={responsive ? srcSet : undefined}
        sizes={responsive && sizes ? sizes : undefined}
        alt={alt}
        className={imgClassName}
        style={style}
        loading={eager ? 'eager' : 'lazy'}
        // Decoding off the main thread keeps a big photo from janking the
        // surface it lands in; the hero also jumps the fetch queue.
        decoding="async"
        {...(eager ? { fetchPriority: 'high' as const } : null)}
        onLoad={fadeIn ? () => setLoaded(true) : undefined}
        onError={() => setErrored(true)}
        onMouseEnter={hoverPreview ? openPreview : undefined}
        onMouseLeave={hoverPreview ? () => setPreview(null) : undefined}
      />
      {preview && createPortal(
        <div
          className="fixed z-[80] pointer-events-none rounded-lg overflow-hidden bg-white shadow-pop border border-ink-200"
          style={{ left: preview.left, top: preview.top, width: preview.width }}
        >
          <img src={url} alt={alt} className="block w-full h-auto max-h-[70vh] object-contain bg-white" />
        </div>,
        document.body,
      )}
    </>
  );
}
