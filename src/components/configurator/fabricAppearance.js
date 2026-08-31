/**
 * Resolve ONE fabric code into the three.js appearance `buildConfiguratorGroup` wants:
 * `{ color, texture, normal, pbr }`.
 *
 * This is the single-code port of the live stage's texture pipeline (ConfiguratorStage's
 * scene rebuild), pulled out so a surface that only ever shows ONE fabric — the
 * embed launch card's turntable — can upholster a piece exactly like the
 * configurator does, without carrying the stage's whole rebuild machinery.
 *
 * The order matters, and each step exists because of a real fabric in the
 * dealer's library:
 *   • the LR SWATCH tone is sampled first — it's both the fallback flat colour
 *     AND the correction target a real pCon scan is anchored to;
 *   • a linked `.matz` rgb beats the sampled photo (it IS the exact tone);
 *   • a linked texture is TINTED when it's a sibling's weave (family fallback)
 *     or a neutral greyscale detail map, and otherwise gain-corrected onto the
 *     swatch tone so a scan captured dark doesn't upholster the piece black;
 *   • the weave RELIEF is pCon's own `bumps` map where one shipped, else one
 *     derived from the (possibly tinted) diffuse.
 *
 * Everything cached here is flagged `userData.shared` so `disposeGroup` leaves
 * it alone — a group swap must never free a texture the next build re-binds
 * (that's the "textures don't come through" failure). Callers own the cache and
 * dispose it when their renderer goes away.
 *
 * Every failure degrades to the flat colour; nothing here throws.
 */
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import {
  sampleSwatchColor, makeTintedWeave, makeWeaveNormal, imageColorfulness, correctScanToSwatch, loadScanExtras,
} from './sceneBuilder.js';

/** A fresh cache bundle for one renderer's lifetime. */
export function makeAppearanceCache() {
  return { color: new Map(), texture: new Map(), normal: new Map(), swatch: new Map(), extra: new Map() };
}

/** Free every texture the cache holds (call when the renderer is torn down). */
export function disposeAppearanceCache(cache) {
  if (!cache) return;
  for (const t of cache.texture.values()) t?.dispose?.();
  for (const n of cache.normal.values()) n?.dispose?.();
  for (const e of cache.extra.values()) { e?.roughness?.dispose?.(); e?.metalness?.dispose?.(); e?.displacement?.dispose?.(); e?.anisotropy?.dispose?.(); }
  cache.texture.clear(); cache.normal.clear(); cache.color.clear(); cache.swatch.clear(); cache.extra.clear();
}

const hexToInt = (hex) => {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : null;
};

/**
 * `code` → `{ color, texture, normal, pbr }`, memoized in `cache`. `fab` is the
 * per-code descriptor the catalog builds (`{ textureUrl, normalUrl, rgb, tint,
 * pbr }`); null/absent is fine — the swatch alone still yields a colour.
 */
export async function loadFabricAppearance(THREE, code, fab, cache) {
  const empty = { color: null, texture: null, normal: null, pbr: null };
  if (!THREE || !code) return empty;

  // ── The LR swatch tone: the customer's own reference colour.
  if (!cache.swatch.has(code)) {
    let tone = null;
    const url = swatchProxyUrl(code) || swatchUrl(code);
    if (url) {
      try {
        const t = await new THREE.TextureLoader().loadAsync(url);
        tone = sampleSwatchColor(t.image);
        t.dispose?.();
      } catch { /* no swatch → no correction target, colour falls to the .matz rgb */ }
    }
    cache.swatch.set(code, tone ?? null);
  }
  const swInt = cache.swatch.get(code);

  if (!cache.color.has(code)) {
    const matz = fab?.rgb ? hexToInt(fab.rgb) : null;
    cache.color.set(code, matz ?? swInt ?? null);
  }
  const color = cache.color.get(code);

  // ── The real weave, when the dealer's pCon library linked one.
  if (fab?.textureUrl && !cache.texture.has(code)) {
    try {
      const tex = await new THREE.TextureLoader().loadAsync(fab.textureUrl);
      let keep = tex;
      // Tint when the map is a SIBLING's weave (family fallback) or a neutral
      // greyscale detail map — rendering either verbatim gives a colourless
      // silver piece instead of the fabric the customer picked.
      const neutral = !fab.tint && !fab.pbr?.dif && color != null
        && (imageColorfulness(tex.image) ?? 999) < 14;
      if (fab.tint || neutral) {
        keep = makeTintedWeave(THREE, tex.image, color);
        tex.dispose?.();
      } else if (fab.rgb && swInt != null) {
        // A real scan → anchor it to its swatch (the .matz capture and the LR
        // swatch photo are different exposures of the same cloth).
        const matzInt = hexToInt(fab.rgb);
        const corrected = matzInt != null ? correctScanToSwatch(THREE, tex.image, matzInt, swInt) : null;
        if (corrected) { keep = corrected; tex.dispose?.(); }
      }
      if (keep) {
        keep.userData.shared = true;
        cache.texture.set(code, keep);
        let nrm = null;
        if (fab.normalUrl && !fab.tint) {
          try {
            nrm = await new THREE.TextureLoader().loadAsync(fab.normalUrl);
            nrm.colorSpace = THREE.NoColorSpace;   // normal data is linear, never sRGB
          } catch { nrm = null; }
        }
        if (!nrm) nrm = makeWeaveNormal(THREE, keep.image);
        if (nrm) { nrm.userData.shared = true; cache.normal.set(code, nrm); }
      } else cache.texture.set(code, null);
    } catch { cache.texture.set(code, null); /* broken texture → colour fallback */ }
  }

  // The rest of the scan's measured PBR maps (roughness/metalness/displacement/
  // anisotropy) — so a turntable/launch card shows the same velvet the stage does.
  if (fab?.textureUrl && !cache.extra.has(code)) {
    cache.extra.set(code, await loadScanExtras(THREE, fab, (u) => new THREE.TextureLoader().loadAsync(u)));
  }

  return {
    color,
    texture: cache.texture.get(code) || null,
    normal: cache.normal.get(code) || null,
    pbr: fab?.pbr || null,
    extra: cache.extra.get(code) || null,
  };
}
