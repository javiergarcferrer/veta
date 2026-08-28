/**
 * VARIANT FACETS — turning a supplier's configuration STRING into the layers a
 * human actually chooses in.
 *
 * ── THE PROBLEM, AS IT APPEARS ON SCREEN ────────────────────────────────────
 * An imported catalog row names itself by everything that was configured:
 *
 *   Klint Armchair · Oak Oiled · Natural Paper Cord
 *   Klint Armchair · Oak Soap  · Natural Paper Cord
 *
 * Those are ONE CHAIR. A picker that lists them as two rows is showing the
 * dealer a flat cross-product — Carl Hansen's Wishbone alone is 41 of them —
 * and asking a person to read the same words nine times to spot the one word
 * that changed. The model is the thing you pick; the finish is a layer under it.
 *
 * ── HOW THE TWO HOUSES ACTUALLY WRITE IT ────────────────────────────────────
 * Measured on the real payloads, not assumed:
 *
 *   Carl Hansen — `FormattedConfiguration`, COMMA-separated, and the SEGMENT
 *   COUNT VARIES:
 *     "FSC™-certified oak, oil, natural paper cord"                  (3)
 *     "FSC™-certified oak, soap, natural paper cord"                 (3)
 *     "FSC™-certified beech, painted, Soft Blue, black paper cord"   (4)
 *     "FSC™-certified beech, soft paint, Soft Black, black paper cord"
 *   A painted frame inserts a COLOUR that an oiled one does not have. So the
 *   third segment is "seat" on one row and "colour" on the next, and ANY
 *   positional rule mislabels a third of the range. Its axes are named
 *   (`Frame`, `Seat`, `ExtraMont`) but those names never reach `products` —
 *   only the rendered string does.
 *
 *   Fredericia — the store's option VALUES, ' · '-joined:
 *     "Spine Barstool (w/ Back) · Black Lacquered · Counter Height"
 *     "Pato Dining Chair · Beech · Khaki Green"
 *   Same shape, different separator, same variable arity.
 *
 * So the layer a token belongs to is decided BY WHAT THE TOKEN SAYS, never by
 * where it sits. That is the whole of this module.
 *
 * ── WHY A CLASSIFIER AND NOT A LOOKUP ───────────────────────────────────────
 * The vocabularies are small, closed and shared: both houses are Danish, both
 * sell oak/beech/walnut/ash/teak, both finish in oil/soap/lacquer/paint, both
 * seat in paper cord, leather or Kvadrat cloth. A token is matched on its
 * WORDS, so "FSC™-certified oak" and "Oak Oiled" both find wood without either
 * being enumerated, and a spelling nobody predicted still lands somewhere
 * honest.
 *
 * ── AND WHY AN UNKNOWN TOKEN IS NOT GUESSED ─────────────────────────────────
 * A token that matches nothing goes to `otros` and is SHOWN, under that name.
 * The alternative — folding it into the nearest facet — is how "Soft Olive
 * Green" becomes a wood and a dealer picks a chair that does not exist. A
 * layer labelled "Otros" is a small ugliness; a mislabelled one is a wrong
 * order.
 *
 * Pure: no React, no db, no imports up the layer graph.
 */

/** A layer a configuration token can belong to. Ordered as a person chooses:
 *  the piece's material first, then how it is finished, then its colour, then
 *  what you sit on, then the hardware and the sizes. */
export type FacetId =
  | 'madera' | 'acabado' | 'color' | 'tapiceria' | 'base' | 'medida' | 'otros';

export interface Facet {
  id: FacetId;
  /** What the layer is called on screen, in the dealer's language. */
  label: string;
  /** Sort weight — the order the layers stack in a picker. */
  order: number;
}

/**
 * The layers, in the order they stack.
 *
 * THIS ORDER IS THE AESTHETIC CLAIM, and it is deliberate: a designer picks
 * the SPECIES before the finish (oak vs. walnut is the piece; oiled vs. soaped
 * is a treatment of it), the finish before the colour (a painted frame only
 * has a colour because it is painted), and the upholstery last because it is
 * the choice that gets changed most and priced separately. `medida` sits at
 * the end because a height is a constraint, not a taste.
 */
export const FACETS: readonly Facet[] = [
  { id: 'madera',    label: 'Madera',     order: 1 },
  { id: 'acabado',   label: 'Acabado',    order: 2 },
  { id: 'color',     label: 'Color',      order: 3 },
  { id: 'tapiceria', label: 'Tapicería',  order: 4 },
  { id: 'base',      label: 'Base',       order: 5 },
  { id: 'medida',    label: 'Medida',     order: 6 },
  { id: 'otros',     label: 'Otros',      order: 7 },
];

const FACET_BY_ID = new Map(FACETS.map((f) => [f.id, f]));

/** The layer for an id — never null, so a caller can always render something. */
export const facetById = (id: string | null | undefined): Facet =>
  FACET_BY_ID.get(String(id || '') as FacetId) || FACET_BY_ID.get('otros')!;

/**
 * Fold a token for matching: lower-case, accent-stripped, punctuation reduced
 * to single spaces. `FSC™-certified` and `FSC certified` must fold the same, or
 * every Carl Hansen frame reads as unknown.
 */
export function foldToken(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Noise a supplier prints that names no choice. `FSC™-certified` is a
 * certification on EVERY Carl Hansen wood, so it distinguishes nothing and
 * only makes the layer harder to read; it is stripped for DISPLAY, never used
 * to decide the facet.
 */
const NOISE = /\bfsc\b[\s™®\-–—]*|\bcertified\b/gi;

/** Word sets, deliberately small and shared by both houses. Matched as WORDS
 *  so "Oak Oiled", "oak, oil" and "FSC™-certified oak" all find wood. */
const WORDS: ReadonlyArray<{ facet: FacetId; words: readonly string[] }> = [
  // Species. Danish furniture's whole material vocabulary is ~8 woods.
  { facet: 'madera', words: ['oak', 'roble', 'beech', 'haya', 'walnut', 'nogal', 'ash', 'fresno',
                             'teak', 'teca', 'mahogany', 'caoba', 'cherry', 'cerezo', 'maple', 'arce',
                             'birch', 'abedul', 'pine', 'pino'] },
  // What you sit on / what wraps it. ASKED BEFORE THE FINISH, and that order is
  // load-bearing: "natural paper cord" carries `natural`, which is also a wood
  // treatment. The cord is the choice; natural is an attribute of it. Asked the
  // other way round, every Wishbone seat in the book reads as a finish.
  { facet: 'tapiceria', words: ['cord', 'cordel', 'paper', 'papel', 'leather', 'piel', 'cuero',
                                'fabric', 'tela', 'canvas', 'lona', 'wool', 'lana', 'linen', 'lino',
                                'sheepskin', 'borrego', 'hide', 'upholstered', 'tapizado',
                                'seat', 'asiento', 'wicker', 'mimbre', 'rattan', 'ratan',
                                // Fredericia names its leathers by TANNAGE, never by the word
                                // "leather": a Spanish Chair is "Natural Saddle", "Cognac
                                // Saddle", "Black Saddle". Without these the four hides of one
                                // chair scattered across three layers — natural→acabado,
                                // black→color, cognac→otros — and the spec sheet asked three
                                // questions where the manufacturer asked one.
                                'saddle', 'montura', 'aniline', 'anilina', 'nubuck', 'suede',
                                'ante', 'shearling', 'boucle', 'velvet', 'terciopelo'] },
  // How the wood is treated. `painted`/`soft paint`/`lacquer` also IMPLY that a
  // colour token follows — which is why colour is its own layer below.
  { facet: 'acabado', words: ['oil', 'oiled', 'aceitado', 'soap', 'soaped', 'jabonado',
                              'lacquer', 'lacquered', 'lacado', 'painted', 'paint', 'pintado',
                              'smoked', 'ahumado', 'stained', 'tenido', 'white', 'blanco',
                              'natural', 'untreated', 'brushed', 'matte', 'mate', 'gloss', 'brillo'] },
  // Hardware / how it stands.
  { facet: 'base', words: ['base', 'swivel', 'giratoria', 'giratorio', 'castors', 'ruedas',
                           'legs', 'patas', 'frame', 'estructura', 'steel', 'acero',
                           'chrome', 'cromo', 'brass', 'laton', 'aluminium', 'aluminum', 'aluminio'] },
  // A constraint, not a taste.
  { facet: 'medida', words: ['height', 'altura', 'counter', 'bar', 'low', 'high', 'baja', 'alta',
                             'seater', 'plazas', 'cm', 'width', 'ancho', 'depth', 'fondo',
                             'left', 'right', 'izquierda', 'derecha', 'small', 'large'] },
];

/** Colour words, checked LAST among the sets: "Soft Blue", "Khaki Green",
 *  "Soft Anthracite Gray". Kept separate because a colour only exists when the
 *  piece was painted, and it deserves its own layer rather than being buried
 *  in the finish. */
const COLOUR_WORDS: readonly string[] = [
  'black', 'negro', 'blue', 'azul', 'green', 'verde', 'red', 'rojo', 'gray', 'grey', 'gris',
  'brown', 'marron', 'beige', 'olive', 'oliva', 'anthracite', 'antracita', 'silver', 'plata',
  'orange', 'naranja', 'yellow', 'amarillo', 'pink', 'rosa', 'purple', 'morado', 'ivory', 'marfil',
  'khaki', 'caqui', 'sand', 'arena', 'cream', 'crema', 'taupe', 'burgundy', 'navy',
];

const has = (folded: string, words: readonly string[]): boolean => {
  const tokens = folded.split(' ').filter(Boolean);
  return words.some((w) => tokens.includes(w));
};

/**
 * Which layer this configuration token belongs to.
 *
 * ORDER OF QUESTIONS IS THE RULE, and it resolves the real collisions:
 *
 *   • "black paper cord" contains BOTH a colour word and a textile word, and
 *     "natural paper cord" contains a FINISH word (`natural`). Both are
 *     TAPICERÍA — the cord is the choice; black and natural are attributes of
 *     it. So the textile question is asked before BOTH the finish and the
 *     colour questions.
 *   • "Soft Black" contains only a colour word → COLOR.
 *   • "white oil" contains a finish word and a colour word → ACABADO, because
 *     the finish question is asked before colour too.
 *   • "Oak Oiled" contains a species AND a finish → MADERA, because species is
 *     asked first: the piece is oak, and oiled is what was done to it. A row
 *     that names both belongs under the species, which is what a person looks
 *     for.
 *
 * An empty or unrecognised token is `otros` — see WHY AN UNKNOWN TOKEN IS NOT
 * GUESSED.
 */
export function facetOf(token: string | null | undefined): FacetId {
  const folded = foldToken(String(token ?? '').replace(NOISE, ' '));
  if (!folded) return 'otros';
  for (const { facet, words } of WORDS) {
    if (has(folded, words)) return facet;
  }
  if (has(folded, COLOUR_WORDS)) return 'color';
  return 'otros';
}

/**
 * Break a supplier's configuration string into its tokens.
 *
 * Both separators are accepted because both houses are in this table: Carl
 * Hansen renders with COMMAS ("oak, oil, natural paper cord") and the
 * Fredericia importer joins option values with ' · '. Splitting on either
 * costs nothing and means one function reads both.
 *
 * A comma INSIDE a token would be mis-split — none occurs in either book (the
 * separator is the supplier's own list separator), and a value that genuinely
 * carried one would show as two layers rather than silently vanish.
 */
export function splitConfiguration(text: string | null | undefined): string[] {
  return String(text ?? '')
    .split(/\s*[·,;|]\s*|\s+\/\s+/)
    .map((t) => t.replace(NOISE, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Title-case a token for display, leaving already-capitalised words alone.
 *  "oak" → "Oak"; "Soft Anthracite Gray" stays as the supplier wrote it. */
export function displayToken(token: string | null | undefined): string {
  const t = String(token ?? '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** One layer of a model: the facet plus every distinct value seen under it. */
export interface FacetLayer {
  facet: Facet;
  /** Distinct display values, in first-seen order. */
  values: string[];
}

/**
 * Every configuration string of one model → its layers.
 *
 * Values are DEDUPED on their folded form but shown in the supplier's own
 * spelling, first one wins — so "Oak Oiled" and "oak oiled" are one value and
 * the catalogue's capitalisation survives. Layers come back in FACETS order,
 * and a layer with nothing in it is omitted rather than rendered empty.
 *
 * A layer whose every row shares ONE value is still returned: "Asiento ·
 * Cordel de papel natural" tells the dealer what they are getting, and a
 * picker can render a single-value layer as a caption instead of a choice.
 */
export function facetLayers(configurations: readonly (string | null | undefined)[]): FacetLayer[] {
  const seen = new Map<FacetId, Map<string, string>>();
  for (const text of configurations || []) {
    for (const token of splitConfiguration(text)) {
      const id = facetOf(token);
      const key = foldToken(token);
      if (!key) continue;
      let bucket = seen.get(id);
      if (!bucket) { bucket = new Map(); seen.set(id, bucket); }
      if (!bucket.has(key)) bucket.set(key, displayToken(token));
    }
  }
  const out: FacetLayer[] = [];
  for (const facet of FACETS) {
    const bucket = seen.get(facet.id);
    if (bucket && bucket.size) out.push({ facet, values: [...bucket.values()] });
  }
  return out;
}
