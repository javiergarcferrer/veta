/**
 * LIBRARY PATH taxonomy — where a dropped `.3ds` files itself.
 *
 * The dealer drags Ligne Roset's whole ARCHVIZ tree onto the Modelos studio
 * (thousands of files, one drop) and every one of them has to land under three
 * levels without anybody typing a word:
 *
 *   GRUPO      LR's top division — Upholstery, Dining, Bedroom…
 *   CATEGORÍA  what the piece IS  — Sofa, Beds, Coffee Tables…
 *   COLECCIÓN  the model family   — Togo, Prado, Hypna…
 *
 * THE STRATEGY: INFER THE SHAPE FROM THE BATCH, THEN READ POSITIONALLY.
 *
 * The library is structurally regular even where its WORDS are not:
 *
 *   <roots…>/<GROUP>/<CATEGORY>/[<model folder>/[<variant folder>/]]<file>.3ds
 *
 * A dropped tree shares ONE root, so the whole batch tells us WHERE each level
 * sits — and once the level is known, no vocabulary is needed to interpret the
 * name that sits there. `resolveLibraryShape` walks the batch once and answers
 * "the group is at index N"; `parseLibraryPath` then reads each path BY INDEX.
 *
 * This replaced a vocabulary-driven parser (a `LR_CATEGORIES` list + a
 * CATEGORÍA→GRUPO table) that read every folder name against enumerated words.
 * It filed `Upholstery/Sofa Bed/Multy_Convertible120_NoBackWedge.3ds` as
 * { Upholstery, null, 'Sofa Bed' } — the singular `Sofa Bed` wasn't in the list,
 * so the "sits below a resolved taxonomy segment ⇒ packaging" rule ate the
 * CATEGORY level and handed its name to the collection. That is not a missing
 * word: a real library ALWAYS contains names we haven't enumerated (French
 * categories, singular/plural drift, new families), so any strategy that must
 * recognize a word to place it will keep misfiling exactly the pieces nobody
 * anticipated. Positionally, `Sofa Bed` is simply whatever sits at the category
 * index, and it reads correctly BECAUSE we never ask what it means.
 *
 * So the reading order is:
 *
 *   • THE VOCABULARY LOCATES A LEVEL, IT NEVER INTERPRETS A NAME. LR_GROUPS is
 *     read for exactly two questions — "at which index does this batch keep its
 *     top division?" and "does THIS path have that level, or does it start at
 *     the category?" — and for nothing else. The category is never checked
 *     against a list; whatever sits at its index IS the categoría.
 *   • A GROUP LEVEL CAN BE ABSENT PER BRANCH. LR's own tree hangs
 *     `Cabinet/` beside `Upholstery/` — the owner's rule verbatim: «cabinets
 *     should all be categories. no parent group.» A segment at the group index
 *     that carries no group token is therefore the CATEGORY of a branch that
 *     has no grupo, and the answer is `group: null` — a blank the dealer fills
 *     in one click, never a guessed division he has to notice first.
 *   • THE COLLECTION IS THE MODEL'S FOLDER, REFINED BY THE FILENAME. The owner's
 *     rule reads «its first string before the _ is the collection», and that
 *     held only while the files led with the family (`Togo_gb`, `Hypna_160_v_G`).
 *     The real library also holds `Cabinet/Oka/gd module laqué.3ds`, where the
 *     FILE names the piece and only the FOLDER names the family. So: the model
 *     folder names the collection, the filename's leading token REFINES it when
 *     the two agree at a word boundary (`Hypna 160 2Versions` + `Hypna_160_v_G`
 *     ⇒ the shorter, cleaner `Hypna`), and with no model folder at all the
 *     filename is all there is — which is why `Cabinet/Marechiaro_Straight.3ds`
 *     correctly reads Marechiaro.
 *   • A VARIANT FOLDER IS A RENDERING, NOT A LEVEL. `2Versions`, `VersionLeft`,
 *     `Gauche` are the same model shot twice (LR_VARIANT_MARKERS). They are
 *     dropped wherever they trail a path and can never name a family — or a
 *     category, by being the last thing standing.
 *
 * Every field is `string | null` — null means "the path doesn't say", never a
 * guess, because a guessed GRUPO is a piece the dealer can never find again.
 * Pure, throw-free, importable from anywhere (no app imports, no React, no db):
 * the drop handler, the importer and the taxonomy UI all read the SAME answer,
 * and the answer is a pure function of (string, shape), so re-dropping the same
 * folder can never file the same file twice.
 */

/**
 * LR's top division. Exported because the UI offers these as the GRUPO picker's
 * options — the parser and the dropdown must agree, or a file lands in a group
 * the dealer can't select. English because the library's folders are English
 * (this is LR's own vocabulary, not app copy); the Spanish labels belong to the
 * surface that renders them.
 *
 * This is the ONLY vocabulary the taxonomy read consults, and it answers ONE
 * question: which index a batch keeps its top division at. Extending it teaches
 * the parser to RECOGNIZE a new division — never to interpret a category.
 */
export const LR_GROUPS = [
  'Upholstery',
  'Occasional',
  'Dining',
  'Bedroom',
  'Storage',
  'Outdoor',
  'Lighting',
  'Rugs',
  'Accessories',
  'Complements',
  'Office',
  'Kids',
];

/**
 * Folder names that name the LIBRARY rather than the taxonomy. The dealer may
 * drop `LIGNE ROSET DATA/ARCHVIZ/International-3DS/…` or just the inner folder,
 * so these can show up at ANY depth (or not at all) — they are dropped wherever
 * they appear, BEFORE any index is counted, so two dealers dropping the same
 * tree from different heights infer the same shape. Deliberately a short,
 * documented list rather than a heuristic: LR adds a wrapper folder now and then
 * and this is the one line to extend when they do.
 */
export const LIBRARY_ROOTS = [
  'International-3DS',
  'ARCHVIZ',
  'LIGNE ROSET DATA',
  '3DS',
  'Models',
];

/**
 * Folder names that name a VARIANT of the model rather than a taxonomy level.
 *
 * LR splits a model's left/right and multi-configuration renders into their own
 * folder (`Hypna 160 2Versions`, `Hypna 160 VersionLeft`, and the French
 * `Gauche`/`Droite` and `v_G`/`v_D` the file names themselves use). Those are
 * packaging: a bare one is dropped even when it doesn't repeat the collection at
 * all, at ANY depth, because a rendering is never a level.
 *
 * Exported and documented rather than inlined: this is the one line to extend
 * when the library turns up another marker.
 */
export const LR_VARIANT_MARKERS = [
  'Versions',
  'Version',
  '2Versions',
  'Version Left',
  'Version Right',
  'VersionLeft',
  'VersionRight',
  'Left',
  'Right',
  'Gauche',
  'Droite',
  'v G',
  'v D',
  'Variantes',
  'Variants',
  'Variant',
  'Ambiance',
  'Ambiances',
];

// Comparison key for a folder/collection name: separators unified, case folded.
// `toUpperCase()` is LOCALE-INDEPENDENT by spec — `toLocaleUpperCase()` is not,
// and under a Turkish locale "International" would fold to a different key than
// it does here, filing the same folder twice on the same library. Never swap it.
const keyOf = (s) => String(s == null ? '' : s).replace(/[-_\s]+/g, ' ').trim().toUpperCase();

const ROOT_KEYS = new Set(LIBRARY_ROOTS.map(keyOf));
const GROUP_BY_KEY = new Map(LR_GROUPS.map((g) => [keyOf(g), g]));
const VARIANT_KEYS = new Set(LR_VARIANT_MARKERS.map(keyOf));

// A Windows drive stub ("C:") survives normalization of an absolute path that
// arrived by drag-and-drop. It names a disk, not a taxonomy — same treatment as
// a library root, so no level can ever be counted at "C:".
const DRIVE = /^[a-z]:$/i;

// The GENERATED variant names LR_VARIANT_MARKERS can't enumerate: the count is
// whatever the model has (`2Versions`, `3 Versions`) and the side is written
// glued or spaced, in English, in French, or as the file's own `v_G` / `v_D`.
// Tested against a `keyOf` key, so separators are already single spaces.
const VARIANT_SHAPES = [
  /^\d+\s*VERSIONS?$/,
  /^VERSIONS?\s*(LEFT|RIGHT|GAUCHE|DROITE|[GD])$/,
  /^V\s*[GD]$/,
];

// Segment → its words, the same split the group matcher reads.
const tokensOf = (s) => String(s == null ? '' : s).split(/[-_\s]+/).filter(Boolean);

// TRUE when a folder names a VARIANT rather than the family — `2Versions`,
// `Gauche`, `VersionLeft`. It is one model rendered twice, so it is never a
// family and never a level.
const isVariantFolder = (key) => VARIANT_KEYS.has(key) || VARIANT_SHAPES.some((re) => re.test(key));

// TRUE when `key` opens with `prefix` at a WORD boundary — `Hypna 160 2Versions`
// opens with `Hypna`, `Avalon` does not open with `Ava`. The one comparison that
// decides whether the filename and its model folder are naming the same family.
const opensWith = (key, prefix) => !!prefix && !!key && (key === prefix || key.startsWith(`${prefix} `));

// The GROUP token inside one segment, if any: `{ group, rest }` where `rest` is
// everything else in that segment — non-empty exactly when the segment spells
// group AND category together (`Upholstery-Sofa`). null ⇒ this segment carries
// no top division at all.
const groupSplit = (segment) => {
  const tokens = tokensOf(segment);
  const at = tokens.findIndex((t) => GROUP_BY_KEY.has(keyOf(t)));
  if (at < 0) return null;
  return {
    group: GROUP_BY_KEY.get(keyOf(tokens[at])),
    rest: tokens.filter((_, k) => k !== at).join(' '),
  };
};

// A path's segments: separators unified, empties (leading `/`, `//`) and `.`
// hops dropped. The filename is the last one.
const splitPath = (relPath) => (typeof relPath !== 'string' ? [] : relPath
  .replace(/\\/g, '/').split('/')
  .map((s) => s.trim())
  .filter((s) => s && s !== '.'));

// The FOLDER segments a level can be counted at: the file dropped, library roots
// and drive stubs dropped wherever they appear, and trailing VARIANT folders
// dropped (a rendering is never a level — and it always trails, since it sits
// under the model folder). Shape resolution and the per-path read share this one
// cleaner, so the indices the batch counts are exactly the ones a path reads.
const cleanFolders = (segments) => {
  const folders = segments.slice(0, -1).filter((s) => !ROOT_KEYS.has(keyOf(s)) && !DRIVE.test(s));
  let end = folders.length;
  while (end > 0 && isVariantFolder(keyOf(folders[end - 1]))) end--;
  return folders.slice(0, end);
};

/**
 * The shared name cleaner: `Coffee-Tables` / `coffee_tables` → `Coffee Tables`.
 *
 * Separators become spaces, whitespace collapses, each word's first letter is
 * upper-cased and THE REST IS LEFT ALONE — which is what preserves an acronym
 * that was already all-caps (`LED`, `MDF`) instead of mangling it to `Led`. It
 * falls out of not lower-casing the tail; nothing here detects acronyms.
 *
 * Always returns a STRING ('' when nothing survives), so a caller can chain
 * `.toLowerCase()` / `.length` on it without a null check. `parseLibraryPath` is
 * the one that turns '' into the null its contract promises.
 */
export function prettifyLibraryName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// '' → null, so every field of the result honours "null means not derivable".
const orNull = (s) => (s ? s : null);

/**
 * Infer ONE batch's SHAPE — the plan `parseLibraryPath` reads paths by.
 *
 * A drop is a TREE, not a bag of strings: every file in it hangs off the same
 * root, so the batch as a whole settles where each level sits even where a
 * single path is ambiguous. That is the entire point — one drop, one shape,
 * every sibling treated identically.
 *
 * The plan (opaque; treat it as a token to hand back, not as fields to read):
 *
 *   groupDepth     the index the GROUP sits at, counted over the CLEANED folder
 *                  segments (roots/drive/variant folders already gone), or NULL
 *                  when no group token appears anywhere in the batch — the
 *                  dealer dropped from inside, so there simply is no group.
 *   categoryDepth  where the CATEGORÍA sits: groupDepth + 1 normally, groupDepth
 *                  itself when the batch spells both in one segment, and 0 when
 *                  there is no group level at all.
 *   compound       the batch writes `Upholstery-Sofa` (group and category share
 *                  one segment) rather than `Upholstery/Sofa`.
 *
 * LEVEL-FINDING RULE: each path votes with the SHALLOWEST index at which a known
 * LR_GROUPS token appears; the most-voted index wins, ties resolving shallowest.
 * Majority, not first-seen, because a stray folder must not move the level — a
 * lone `Divers/Storage/` (a family named like a division) among two thousand
 * `Upholstery/…` paths would otherwise push the whole library down one level and
 * misfile every file in the drop. Vocabulary is used HERE, to locate the level,
 * and nowhere else: no name is ever interpreted.
 *
 * Both shapes coexist in LR's own tree, so `compound` reports what the batch
 * mostly does while the reader still confirms it SEGMENT BY SEGMENT — a branch
 * written `Upholstery-Sofa/` files correctly next to one written
 * `Upholstery/Sofa/`, in the same drop.
 *
 * Non-array input, junk entries and an empty batch all answer the no-group plan
 * rather than throwing: a shape is inferred from ten thousand paths and must not
 * die on the one `.DS_Store`-shaped entry.
 */
export function resolveLibraryShape(relPaths) {
  const votes = new Map();   // depth → { plain, compound }
  for (const relPath of Array.isArray(relPaths) ? relPaths : []) {
    const folders = cleanFolders(splitPath(relPath));
    let at = -1;
    let split = null;
    for (let i = 0; i < folders.length && at < 0; i++) {
      split = groupSplit(folders[i]);
      if (split) at = i;
    }
    if (at < 0) continue;   // this path has no group level — it votes for nothing
    const tally = votes.get(at) || { plain: 0, compound: 0 };
    if (split.rest) tally.compound++; else tally.plain++;
    votes.set(at, tally);
  }

  // Most-voted depth wins; sorted ascending + strict `>` so a tie keeps the
  // SHALLOWEST index (the top division sits closest to the root) and the answer
  // never depends on the order the files happened to arrive in.
  let groupDepth = null;
  let best = 0;
  for (const [depth, tally] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
    const n = tally.plain + tally.compound;
    if (n > best) { best = n; groupDepth = depth; }
  }
  if (groupDepth == null) return Object.freeze({ groupDepth: null, categoryDepth: 0, compound: false });

  const tally = votes.get(groupDepth);
  const compound = tally.compound > tally.plain;
  return Object.freeze({ groupDepth, categoryDepth: compound ? groupDepth : groupDepth + 1, compound });
}

// A caller's shape, or null when it isn't one (a stale object, a File, junk) —
// so a bad plan degrades to the single-path reading instead of throwing halfway
// through a ten-thousand-file import.
const usableShape = (shape) => (shape && typeof shape === 'object'
  && (shape.groupDepth === null || (Number.isInteger(shape.groupDepth) && shape.groupDepth >= 0))
  ? shape
  : null);

/**
 * File a library path under { group, category, collection }, reading it BY INDEX
 * against the batch's shape.
 *
 * `relPath` is POSIX and relative to the dropped root
 * (`International-3DS/Upholstery-Sofa/Togo/Togo_gb.3ds`); a Windows path with
 * backslashes normalizes first, because a folder drop on Windows hands us its
 * own separator and the same library must parse identically on both.
 *
 * `shape` is `resolveLibraryShape`'s plan for the WHOLE drop. It is OPTIONAL: a
 * single-file caller (the one-model drop, the taxonomy UI) may omit it and gets
 * the shape of that one path — the same answer the batch gives whenever the path
 * carries its own group segment.
 *
 * The read, in order:
 *
 *   1. FILE TOKEN — basename without its extension, cut at the FIRST `_`
 *      (`Hypna_160_v_G` → Hypna, `Prado_MediumSofa_120` → Prado); no `_` at all
 *      means the whole basename (`gd module laqué`). This is the PIECE's leading
 *      word, and only sometimes the family's.
 *   2. FOLDERS — roots, drive stubs and trailing variant folders dropped, so the
 *      indices match the ones the batch counted.
 *   3. GROUP + CATEGORY BY INDEX. At the shape's group index the segment either
 *      carries a known token ALONE (group; the category is the next segment),
 *      carries it WITH a remainder (`Upholstery-Sofa` — group and category in
 *      one segment, the remainder is the categoría), or carries none at all —
 *      and then this branch has no grupo, so that segment IS the categoría
 *      (`Cabinet/…` ⇒ { null, Cabinet, … }). Whatever name sits at the category
 *      index is taken VERBATIM: no membership test, which is what lets
 *      `Sofa Bed`, `Méridiennes` and next season's folder read correctly.
 *   4. COLLECTION from everything deeper: variant folders dropped (a rendering
 *      never names a family), the SHALLOWEST remaining folder is the model
 *      folder, and the file token REFINES it when the two agree at a word
 *      boundary (`Hypna 160 2Versions` + `Hypna` ⇒ the shorter, cleaner
 *      `Hypna`). They disagree ⇒ the folder wins (`Oka` + `gd module laqué` ⇒
 *      Oka). No model folder ⇒ the token, which is all a standalone file has.
 *
 * Non-string, empty and garbage input answer all-null rather than throwing — a
 * drop of ten thousand files must not die on the one `.DS_Store`-shaped entry.
 */
export function parseLibraryPath(relPath, shape) {
  const none = { group: null, category: null, collection: null };
  if (typeof relPath !== 'string') return none;

  const segments = splitPath(relPath);
  if (!segments.length) return none;

  // ── 1. FILE TOKEN — the filename's first string before the `_`.
  const file = segments[segments.length - 1];
  // Only ONE trailing dot-suffix goes (`Togo_gb.3ds` → `Togo_gb`), so a name
  // that carries a decimal ("Togo 1.5.3ds") keeps it.
  const base = file.replace(/\.[^./]+$/, '');
  const cut = base.indexOf('_');
  const fileToken = prettifyLibraryName(cut >= 0 ? base.slice(0, cut) : base);
  const tokenKey = keyOf(fileToken);

  // ── 2. The folders a level can be counted at.
  const folders = cleanFolders(segments);
  const plan = usableShape(shape) || resolveLibraryShape([relPath]);
  const groupDepth = plan.groupDepth;
  const categoryDepth = Number.isInteger(plan.categoryDepth) ? plan.categoryDepth : 0;

  // ── 3. GROUP + CATEGORY by index. `at` clamps to the deepest folder the path
  // actually has: a branch shallower than the batch's group level is missing
  // that level, not missing its taxonomy — its own folder still names it.
  let group = '';
  let category = '';
  let modelStart = 0;
  if (folders.length) {
    if (groupDepth == null) {
      const at = Math.min(Math.max(categoryDepth, 0), folders.length - 1);
      category = folders[at];
      modelStart = at + 1;
    } else {
      const at = Math.min(groupDepth, folders.length - 1);
      const split = groupSplit(folders[at]);
      if (!split) {
        // No top division on THIS branch (`Cabinet/` beside `Upholstery/`) —
        // the taxonomy starts here, and the grupo stays blank rather than
        // borrowing the neighbour's.
        category = folders[at];
        modelStart = at + 1;
      } else if (split.rest) {
        group = split.group;                  // `Upholstery-Sofa` — both in one
        category = split.rest;
        modelStart = at + 1;
      } else {
        group = split.group;                  // `Upholstery/Sofa` — one level each
        category = folders[at + 1] || '';
        modelStart = at + 2;
      }
    }
  }

  // ── 4. COLLECTION — the model folder, or the token when it agrees or stands alone.
  const models = folders.slice(modelStart).filter((f) => !isVariantFolder(keyOf(f)));
  const modelFolder = models[0] || '';
  const collection = !modelFolder || opensWith(keyOf(modelFolder), tokenKey)
    ? fileToken
    : prettifyLibraryName(modelFolder);

  return {
    // The grupo is emitted VERBATIM from LR_GROUPS (never re-cased through the
    // prettifier): the picker offers those exact strings, and a group spelled
    // two ways is a piece the dealer can't find under either.
    group: orNull(group),
    category: orNull(prettifyLibraryName(category)),
    collection: orNull(collection),
  };
}
