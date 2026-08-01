/**
 * LIBRARY LAYOUTS — where a dropped model files itself.
 *
 * A manufacturer's 3D library is a TREE, and the whole tree lands in one drop:
 * thousands of files that must each land under their taxonomy without anybody
 * typing a word. HOW that tree is read is manufacturer-specific (Ligne Roset's
 * ARCHVIZ export is adapter #1), so the reading is an ADAPTER behind this
 * interface rather than a hardcoded parser — a second library is a second
 * adapter, never a branch inside the first one.
 *
 * The two-call shape is load-bearing. A drop is measured ONCE
 * (`resolveShape`) and every path is then read against that ONE plan
 * (`parsePath`): read per file instead and two siblings in the same folder can
 * land at different levels the moment one of them is missing a segment.
 */

/**
 * What one path says about the piece it names.
 *
 * EVERY FIELD IS `string | null`, and null means "the path doesn't say" — never
 * a guess, because a guessed field is a piece the dealer can never find again.
 */
export interface LibraryPathFields {
  /** The library's top division (Upholstery, Dining…), when it has one. */
  group: string | null;
  /** What the piece IS (Sofa, Beds, Coffee Tables…). */
  category: string | null;
  /** The model family (Togo, Prado, Hypna…). */
  collection: string | null;
  /** The folder that names the model, when the path has one. */
  modelFolder: string | null;
  /** The packaging folder that renders the same model twice (`2Versions`,
   *  `VersionLeft`, `Gauche`) — verbatim, since it is not a name we present. */
  variant: string | null;
  /** The file's own name, verbatim (extension included). */
  fileName: string | null;
}

/** Nothing derivable — the answer for empty and garbage input. */
export const NO_LIBRARY_FIELDS: Readonly<LibraryPathFields> = Object.freeze({
  group: null,
  category: null,
  collection: null,
  modelFolder: null,
  variant: null,
  fileName: null,
});

/** A fresh all-null result. Fresh per call on purpose: a caller mutating one
 *  answer must not poison the next file's. */
export const noLibraryFields = (): LibraryPathFields => ({ ...NO_LIBRARY_FIELDS });

/**
 * One library's reading rules.
 *
 * `Shape` is OPAQUE to callers — a token handed back to `parsePath`, never a bag
 * of fields to read. `parsePath` must accept an absent shape (a single-file drop
 * derives that one path's own) and must be TOTAL: junk in answers all-null
 * rather than throwing, because a shape is inferred from ten thousand paths and
 * an import must not die on the one `.DS_Store`-shaped entry.
 */
export interface LibraryLayout<Shape = unknown> {
  /** Stable adapter id, for persisting which layout read a drop. */
  readonly id: string;
  /** Human label for a layout picker. */
  readonly label: string;
  /** Measure ONE drop: where each level sits across the whole batch. */
  resolveShape(relPaths: string[]): Shape;
  /** File ONE path against that plan. */
  parsePath(relPath: string, shape?: Shape): LibraryPathFields;
}
