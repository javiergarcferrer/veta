/**
 * Carl Hansen & Søn — qué SUPERFICIE lleva puesta una opción del configurador.
 *
 * El binding dice QUÉ grupo de la malla responde a qué eje; esto dice CÓMO se
 * ve la opción elegida. Es lo único que separa una malla que gira de un
 * configurador: tocar «Nogal, aceite» tiene que oscurecer la madera, y
 * «Stainless Steel» tiene que volverse metal, no un gris pintado.
 *
 * ── DE DÓNDE SALE EL COLOR, EN ORDEN ────────────────────────────────────────
 *  1. EL SWATCH PUBLICADO, muestreado. Si el árbol trae la imagen del tejido o
 *     del cuero, ese color ES el color — no hay tabla que lo mejore, y una
 *     colorway nueva de Kvadrat entra sola sin tocar este archivo.
 *  2. La tabla de abajo, por palabra publicada. Sólo maderas, metales y cuerdas
 *     — un puñado de sustancias que el fabricante nombra igual en todo el
 *     catálogo («walnut», «stainless steel», «natural paper cord»).
 *  3. Nada. Devolver `null` deja el material tal como salió de fábrica en el
 *     GLB, que es la respuesta honesta: pintar un gris inventado sobre una
 *     pieza cuyo material no reconocemos es peor que no tocarla.
 *
 * LA ESPECIE ESTÁ EN EL GRUPO, EL ACABADO EN LA HOJA. Medido en el árbol real:
 * el eje Frame de la CH24 nombra sus hojas «Oil» / «Lacquer» / «Soap» y cuelga
 * la especie del nodo de arriba («FSC™-certified Oak»). Por eso el tono se lee
 * del `groupLabel` y el brillo de la `label` — leerlo al revés pinta todas las
 * maderas del mismo color y sólo cambia el brillo.
 *
 * Puro: sin React, sin three.js, sin fetch. Fijado por tests/carlHansen3d.test.js.
 */

/** Lo que un material de la malla tiene que adoptar. Un campo en `null` = «no
 *  tengo opinión», y el llamador deja ese canal como estaba. */
export interface ChSurface {
  /** 0xRRGGBB, o null para no tocar el color. */
  color: number | null;
  /** 0–1. Cuán difusa es la reflexión: aceite ~0.6, laca ~0.25. */
  roughness: number | null;
  /** 0–1. Sólo los metales pasan de 0. */
  metalness: number | null;
}

export interface ChSurfaceInput {
  /** La familia que declaró el eje: wood · cord · upholstery · metal · finish. */
  kind?: string | null;
  /** La hoja elegida («Oil», «Thor 301», «Stainless Steel»). */
  label?: string | null;
  /** El ancestro visible más cercano — la ESPECIE o la colección. */
  groupLabel?: string | null;
  /** La hoja del eje de acabado, cuando el modelo publica uno aparte. */
  finishLabel?: string | null;
  /** El color muestreado del swatch publicado, si lo había. */
  sampled?: number | null;
}

/** Tonos por palabra publicada. Cortos a propósito: cada entrada es una
 *  sustancia que Carl Hansen nombra igual en todo su catálogo. Lo que no está
 *  aquí no se inventa — se deja como vino. */
const TONES: ReadonlyArray<readonly [string, number]> = [
  // maderas
  ['walnut', 0x6b4a32],
  ['oak', 0xc9a978],
  ['beech', 0xd9c1a1],
  ['ash', 0xdac9ab],
  ['teak', 0x9c7b4e],
  ['mahogany', 0x7d4a38],
  ['cherry', 0x9b5a3c],
  ['maple', 0xe0cba8],
  ['birch', 0xe2d0b0],
  // metales
  ['stainless', 0xb9bdc1],
  ['chrome', 0xd7dbde],
  ['brass', 0xc9a227],
  ['bronze', 0x8c6b3f],
  ['powder coated steel', 0x2b2b2d],
  ['steel', 0xb2b6ba],
  // cuerdas y trenzados
  ['natural paper cord', 0xd9c9a3],
  ['black paper cord', 0x2a2724],
  ['paper cord', 0xd9c9a3],
  ['rattan', 0xcbab77],
  ['cane', 0xcbab77],
  ['flat rope', 0x6f6a60],
  ['webbing', 0xb9a988],
  // colores planos que el fabricante usa como acabado
  ['black', 0x1d1d1f],
  ['white oil', 0xe6ddd0],
  ['white', 0xece7de],
  ['soft grey', 0x9c9a96],
  ['grey', 0x8a8987],
];

/** Cómo cambia el brillo el acabado struck sobre la madera. */
const FINISHES: ReadonlyArray<readonly [string, number]> = [
  ['lacquer', 0.3],
  ['soap', 0.78],
  ['white oil', 0.62],
  ['smoked', 0.6],
  ['oil', 0.58],
  ['painted', 0.45],
  ['untreated', 0.85],
];

/** Rugosidad y metalicidad de base por familia. */
const BASE: Record<string, { roughness: number; metalness: number }> = {
  wood: { roughness: 0.58, metalness: 0 },
  metal: { roughness: 0.28, metalness: 0.92 },
  cord: { roughness: 0.85, metalness: 0 },
  upholstery: { roughness: 0.92, metalness: 0 },
  finish: { roughness: 0.58, metalness: 0 },
};

const fold = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** La primera entrada de la tabla que la frase menciona. El orden de la tabla
 *  ES la precedencia: «white oil» antes que «white», «natural paper cord»
 *  antes que «paper cord». */
function lookup(table: ReadonlyArray<readonly [string, number]>, text: string): number | null {
  if (!text) return null;
  for (const [word, value] of table) {
    if (text.includes(word)) return value;
  }
  return null;
}

/**
 * La superficie de una opción, o `null` cuando no hay nada honesto que decir.
 *
 * El metal es el único caso donde la familia manda sobre la palabra: un eje
 * declarado `metal` cuya hoja no está en la tabla sigue siendo metal (acero sin
 * nombrar), porque pintarlo dieléctrico lo convertiría en plástico gris.
 */
export function chSurfaceFor(input: ChSurfaceInput | null | undefined): ChSurface | null {
  const kind = fold(input?.kind);
  const label = fold(input?.label);
  const group = fold(input?.groupLabel);
  const base = BASE[kind] || null;

  // El tono: la especie del grupo primero, la hoja después.
  const toned = lookup(TONES, group) ?? lookup(TONES, label);
  const sampled = Number.isFinite(input?.sampled as number) ? (input?.sampled as number) : null;
  const color = sampled ?? toned;

  // Sin color y sin familia conocida no hay nada que aplicar.
  if (color == null && !base) return null;

  // Un eje que NO declaró familia todavía puede nombrar un metal («Frame:
  // brass»): la palabra basta para que se comporte como metal.
  const namesMetal = /\b(stainless|chrome|brass|bronze|steel|aluminium|aluminum|nickel)\b/.test(`${group} ${label}`);
  let roughness = base ? base.roughness : (namesMetal ? BASE.metal.roughness : null);
  const metalness = base ? base.metalness : (namesMetal ? BASE.metal.metalness : null);

  // El acabado: el del propio eje si lo nombra, si no el del eje de acabado.
  if (kind === 'wood' || kind === 'finish' || (base && kind !== 'metal')) {
    const struck = lookup(FINISHES, label) ?? lookup(FINISHES, fold(input?.finishLabel));
    if (struck != null) roughness = struck;
  }

  return { color: color ?? null, roughness, metalness };
}
