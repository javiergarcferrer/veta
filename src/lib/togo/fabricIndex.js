/**
 * FABRIC APPEARANCE BY COLOUR CODE — what the 3D upholsters with.
 *
 * The renderer would otherwise sample a flat hue off the CDN swatch photo; this
 * hands it the real thing: the scanned pCon weave (public `togo-textures`
 * bucket), its relief map, the exact RGB, and the .mat PBR port (pCon's diffuse
 * multiplier, Phong→GGX roughness, specular intensity, physical tile size in
 * cm).
 *
 * THE FAMILY FALLBACK is the interesting part. Every colour of a material
 * shares ONE physical weave — only the dye differs — so a colour with no scan of
 * its own inherits a linked SIBLING's texture marked `tint: true`, and the 3D
 * re-tints that weave to this colour's own tone (`makeTintedWeave`) rather than
 * rendering it flat. The cloth PHYSICS are the family's too (own .mat values win
 * where present), but never the sibling's diffuse multiplier: the tint bake
 * already carries this colour's tone, and applying the sibling's on top would
 * dye it twice.
 *
 * WHY THIS IS A MODEL AND NOT A `useMemo` IN THE WIDGET (where it lived until
 * the catalogue started being photographed in the back-office): the studio bakes
 * each piece dressed in its collection's cloth, and the widget decides whether
 * that baked picture is still valid by rebuilding its store key — which
 * INCLUDES this descriptor. Two implementations would drift, and the drift is
 * silent: every baked photo would read as stale and the widget would re-render
 * the whole catalogue, which is the exact cost the bake exists to remove. One
 * builder, both callers (pinned in tests/togoConfigurator.test.js).
 */

/** The .mat PBR port for one colour. */
function pbrOf(c) {
  return {
    dif: c?.dif || null,
    rough: Number.isFinite(Number(c?.rough)) ? Number(c.rough) : null,
    spec: Number.isFinite(Number(c?.spec)) ? Number(c.spec) : null,
    tileCm: Number(c?.tileCm) > 0 ? Number(c.tileCm) : null,
    tileCmY: Number(c?.tileCmY) > 0 ? Number(c.tileCmY) : null,
  };
}

/**
 * `materials` (the public togo-embed catalog rows, or the dealer's own
 * `materials` table — same shape) → `{ [code]: { textureUrl, normalUrl?, rgb,
 * tint?, pbr? } }`. A code with neither a weave nor an RGB gets no entry at
 * all: the renderer's own fallback is better than a descriptor that describes
 * nothing.
 */
export function buildFabricByCode(materials) {
  const map = {};
  for (const m of (materials || [])) {
    const sib = (m?.colors || []).find((c) => c?.textureUrl) || null;
    for (const c of (m?.colors || [])) {
      if (!c?.code) continue;
      // normalUrl = the pCon `bumps` map (real weave relief) when imported.
      if (c.textureUrl) {
        map[c.code] = { textureUrl: c.textureUrl, normalUrl: c.normalUrl || null, rgb: c.rgb || null, pbr: pbrOf(c) };
      } else if (sib) {
        const own = pbrOf(c), fam = pbrOf(sib);
        map[c.code] = {
          textureUrl: sib.textureUrl, rgb: c.rgb || null, tint: true,
          pbr: {
            dif: null,
            rough: own.rough ?? fam.rough,
            spec: own.spec ?? fam.spec,
            tileCm: own.tileCm ?? fam.tileCm,
            tileCmY: own.tileCmY ?? fam.tileCmY,
          },
        };
      } else if (c.rgb) {
        map[c.code] = { textureUrl: null, rgb: c.rgb };
      }
    }
  }
  return map;
}
