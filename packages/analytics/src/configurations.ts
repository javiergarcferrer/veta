// WHAT PEOPLE ACTUALLY BUILD — most-placed models, most-picked materials and
// grades, and which models keep showing up TOGETHER.
//
// The unit of counting is a DESIGN, not an event: one browsing session and one
// saved configuration each count once for a pair, so a visitor who nudged the
// same corner unit eleven times does not invent a trend. Placements are still
// reported raw (`placements`) next to the design count (`units`) — the two
// answer different questions and are never added to each other.
//
// PAIRS ARE COUNTED WITHIN A COLLECTION. A model from the Vira sofa and one from
// the Duna bed appearing in the same browsing session is two designs, not one
// combination, so a session that spans collections contributes to each of them
// separately (and its cross-collection pairs are never minted).
//
// Every list is a top-N that SAYS it was capped, and a design too large to pair
// (junk data, a scripted stream) is skipped and REPORTED as `oversizedUnits`
// rather than silently exploding into a quarter-million pairs.

import { collectionOf, dataRange, inPeriod, normalizeEvents, payloadOf, readStamp, readString, resolvePeriod } from './normalize.ts';
import { byCountThenKey, resolveLimit, topN } from './stats.ts';
import { EVENT_KINDS } from './types.ts';
import type { TopList } from './stats.ts';
import type { AnalyticsEvent, DateInput, Period, ResolvedPeriod } from './types.ts';

/** Models one design may pair. Beyond this the design is skipped and reported. */
export const MAX_COMBINATION_MODELS = 24;

// Composite map keys join on a control character rather than a space or a pipe:
// a model id or a collection slug may legally contain either, and a separator a
// key can also contain is a silent collision (two different pairs, one bucket).
const PAIR_SEP = '\u001f';
const SCOPE_SEP = '\u001f';

/** Keys under which a payload or a placed piece names its model. */
const MODEL_KEYS = ['modelId', 'model_id', 'pieceId', 'piece_id', 'model'] as const;
const CODE_KEYS = ['code', 'materialCode', 'material_code', 'colorCode', 'color_code'] as const;
const GRADE_KEYS = ['grade', 'gradeCode', 'grade_code'] as const;

/** A stored configuration row, read loosely (both casings, unknown build shape). */
export interface ConfigurationRow {
  id?: string | null;
  collectionId?: string | null;
  collection_id?: string | null;
  createdAt?: DateInput | null;
  created_at?: DateInput | null;
  status?: string | null;
  build?: unknown;
  [key: string]: unknown;
}

export interface ModelCount {
  key: string;
  modelId: string;
  /** Every placement observed (events + build pieces). */
  placements: number;
  /** Distinct designs containing it. */
  units: number;
}

export interface MaterialCount {
  key: string;
  code: string;
  picks: number;
  units: number;
}

export interface GradeCount {
  key: string;
  grade: string;
  picks: number;
  units: number;
}

export interface CombinationCount {
  key: string;
  models: [string, string];
  /** Designs in which both models appear. */
  units: number;
}

export interface CombinationList extends TopList<CombinationCount> {
  /** Designs skipped for exceeding MAX_COMBINATION_MODELS. */
  oversizedUnits: number;
}

export interface PopularityBlock {
  collectionId: string | null;
  units: { sessions: number; configurations: number; total: number };
  models: TopList<ModelCount>;
  materials: TopList<MaterialCount>;
  grades: TopList<GradeCount>;
  combinations: CombinationList;
}

export interface PopularConfigurationsReport extends PopularityBlock {
  period: ResolvedPeriod;
  /** Per-collection breakdown; a design with no collection lands under null. */
  collections: PopularityBlock[];
  excluded: {
    undated: number;
    unkinded: number;
    outOfPeriod: number;
    otherKind: number;
    otherCollection: number;
    unattributed: number;
    /** Placements observed with no session — they can name a model, never a pair. */
    untrackedPlacements: number;
    /** Configuration rows with no readable piece. */
    emptyConfigurations: number;
    /** Configuration rows outside the window (or undated, when a bound was set). */
    outOfPeriodConfigurations: number;
  };
}

export interface PopularConfigurationsOptions {
  period?: Period | null;
  collectionId?: string | null;
  /** Rows per list before truncation is reported. Clamped to [1, MAX_TOP_N]. */
  limit?: number | null;
}

/** One design's contribution inside ONE collection. */
interface UnitScope {
  unitId: string;
  unitKind: 'session' | 'configuration';
  collectionId: string | null;
  models: Map<string, number>;
  materials: Map<string, number>;
  grades: Map<string, number>;
}

function scopeFor(
  scopes: Map<string, UnitScope>,
  unitId: string,
  unitKind: 'session' | 'configuration',
  collectionId: string | null,
): UnitScope {
  const key = `${unitId}${SCOPE_SEP}${collectionId ?? ''}`;
  let scope = scopes.get(key);
  if (!scope) {
    scope = {
      unitId,
      unitKind,
      collectionId,
      models: new Map(),
      materials: new Map(),
      grades: new Map(),
    };
    scopes.set(key, scope);
  }
  return scope;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** The material pick a payload or piece carries: `{code, grade}` or nothing. */
function pickOf(source: Record<string, unknown>): { code: string; grade: string } {
  const nested = payloadOf(source.material);
  const code = readString(source, CODE_KEYS) || readString(nested, CODE_KEYS);
  const grade = readString(source, GRADE_KEYS) || readString(nested, GRADE_KEYS);
  return { code, grade };
}

/** Every pick on a placed piece: its own material plus each part's. */
function picksOfPiece(piece: Record<string, unknown>): { code: string; grade: string }[] {
  const picks: { code: string; grade: string }[] = [];
  const own = pickOf(piece);
  if (own.code || own.grade) picks.push(own);
  const parts = payloadOf(piece.partMaterials ?? piece.part_materials);
  for (const value of Object.values(parts)) {
    const part = pickOf(payloadOf(value));
    if (part.code || part.grade) picks.push(part);
  }
  return picks;
}

function piecesOf(build: unknown): Record<string, unknown>[] {
  const raw = payloadOf(build).pieces;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p),
  );
}

/** Ranked counts + pairs over a set of per-collection design scopes. */
function summarize(
  scopes: readonly UnitScope[],
  collectionId: string | null,
  limit: number,
): PopularityBlock {
  const models = new Map<string, { placements: number; units: Set<string> }>();
  const materials = new Map<string, { picks: number; units: Set<string> }>();
  const grades = new Map<string, { picks: number; units: Set<string> }>();
  const pairs = new Map<string, Set<string>>();
  const sessions = new Set<string>();
  const configurations = new Set<string>();
  let oversizedUnits = 0;

  for (const scope of scopes) {
    if (scope.unitKind === 'session') sessions.add(scope.unitId);
    else configurations.add(scope.unitId);

    for (const [modelId, count] of scope.models) {
      let entry = models.get(modelId);
      if (!entry) models.set(modelId, (entry = { placements: 0, units: new Set() }));
      entry.placements += count;
      entry.units.add(scope.unitId);
    }
    for (const [code, count] of scope.materials) {
      let entry = materials.get(code);
      if (!entry) materials.set(code, (entry = { picks: 0, units: new Set() }));
      entry.picks += count;
      entry.units.add(scope.unitId);
    }
    for (const [grade, count] of scope.grades) {
      let entry = grades.get(grade);
      if (!entry) grades.set(grade, (entry = { picks: 0, units: new Set() }));
      entry.picks += count;
      entry.units.add(scope.unitId);
    }

    const distinct = [...scope.models.keys()].sort();
    if (distinct.length > MAX_COMBINATION_MODELS) {
      oversizedUnits += 1;
      continue;
    }
    for (let i = 0; i < distinct.length; i += 1) {
      for (let j = i + 1; j < distinct.length; j += 1) {
        const key = `${distinct[i]}${PAIR_SEP}${distinct[j]}`;
        let units = pairs.get(key);
        if (!units) pairs.set(key, (units = new Set()));
        units.add(scope.unitId);
      }
    }
  }

  const modelRows: ModelCount[] = [...models.entries()]
    .map(([modelId, entry]) => ({
      key: modelId,
      modelId,
      placements: entry.placements,
      units: entry.units.size,
    }))
    .sort(byCountThenKey<ModelCount>((row) => row.placements));

  const materialRows: MaterialCount[] = [...materials.entries()]
    .map(([code, entry]) => ({ key: code, code, picks: entry.picks, units: entry.units.size }))
    .sort(byCountThenKey<MaterialCount>((row) => row.picks));

  const gradeRows: GradeCount[] = [...grades.entries()]
    .map(([grade, entry]) => ({ key: grade, grade, picks: entry.picks, units: entry.units.size }))
    .sort(byCountThenKey<GradeCount>((row) => row.picks));

  const pairRows: CombinationCount[] = [...pairs.entries()]
    .map(([key, units]) => {
      const [a, b] = key.split(PAIR_SEP);
      return { key, models: [a, b] as [string, string], units: units.size };
    })
    .sort(byCountThenKey<CombinationCount>((row) => row.units));

  return {
    collectionId,
    units: {
      sessions: sessions.size,
      configurations: configurations.size,
      total: sessions.size + configurations.size,
    },
    models: topN(modelRows, limit),
    materials: topN(materialRows, limit),
    grades: topN(gradeRows, limit),
    combinations: { ...topN(pairRows, limit), oversizedUnits },
  };
}

/**
 * Popular models / materials / grades / model pairs, over the event stream and
 * the saved configurations together.
 *
 * `configurations` is optional: events alone answer "what did visitors try",
 * configurations alone answer "what did they keep", and both together are the
 * dashboard's default.
 */
export function resolvePopularConfigurations(
  rows: readonly (AnalyticsEvent | null | undefined)[] | null | undefined,
  configurations: readonly (ConfigurationRow | null | undefined)[] | null | undefined = [],
  options: PopularConfigurationsOptions = {},
): PopularConfigurationsReport {
  const { events, undated, unkinded } = normalizeEvents(rows);
  // Both sources decide the default window: a report over saved configurations
  // alone (or over configurations saved after the last beacon) must not fall
  // outside a window the events narrowed by themselves.
  const configEntries: { row: ConfigurationRow; index: number; at: number | null }[] = [];
  const stamps: { at: number }[] = [...events];
  (configurations ?? []).forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const at = readStamp(row as Record<string, unknown>, [
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
    ]);
    configEntries.push({ row, index, at });
    if (at !== null) stamps.push({ at });
  });

  const period = resolvePeriod(options.period, dataRange(stamps));
  const filterCollection = options.collectionId ? String(options.collectionId).trim() : '';
  const limit = resolveLimit(options.limit);

  const excluded = {
    undated,
    unkinded,
    outOfPeriod: 0,
    otherKind: 0,
    otherCollection: 0,
    unattributed: 0,
    untrackedPlacements: 0,
    emptyConfigurations: 0,
    outOfPeriodConfigurations: 0,
  };

  const scopes = new Map<string, UnitScope>();

  const matchesFilter = (collection: string | null): boolean => {
    if (!filterCollection) return true;
    if (!collection) {
      excluded.unattributed += 1;
      return false;
    }
    if (collection !== filterCollection) {
      excluded.otherCollection += 1;
      return false;
    }
    return true;
  };

  for (const event of events) {
    if (!inPeriod(event.at, period)) {
      excluded.outOfPeriod += 1;
      continue;
    }
    if (event.kind !== EVENT_KINDS.piecePlace && event.kind !== EVENT_KINDS.materialPick) {
      excluded.otherKind += 1;
      continue;
    }
    if (!matchesFilter(event.collectionId)) continue;
    if (!event.sessionId) {
      // No session: the placement is real, but it belongs to no design and can
      // never join a pair. Counted where a reader can see it.
      excluded.untrackedPlacements += 1;
      continue;
    }
    const scope = scopeFor(scopes, `session:${event.sessionId}`, 'session', event.collectionId);
    if (event.kind === EVENT_KINDS.piecePlace) {
      const modelId = readString(event.payload, MODEL_KEYS);
      if (modelId) bump(scope.models, modelId);
    } else {
      const { code, grade } = pickOf(event.payload);
      if (code) bump(scope.materials, code);
      if (grade) bump(scope.grades, grade);
    }
  }

  for (const { row, index, at } of configEntries) {
    // A configuration with no stamp is only excluded when the caller actually
    // asked for a window; otherwise it is part of "all time" by definition.
    if (at === null) {
      if (period.explicit.from || period.explicit.to) {
        excluded.outOfPeriodConfigurations += 1;
        continue;
      }
    } else if (!inPeriod(at, period)) {
      excluded.outOfPeriodConfigurations += 1;
      continue;
    }
    const collection =
      readString(row as Record<string, unknown>, ['collectionId', 'collection_id']) ||
      collectionOf(payloadOf(row.build)) ||
      null;
    if (!matchesFilter(collection)) continue;
    const pieces = piecesOf(row.build);
    if (!pieces.length) {
      excluded.emptyConfigurations += 1;
      continue;
    }
    const unitId = `configuration:${readString(row as Record<string, unknown>, ['id']) || `#${index}`}`;
    const scope = scopeFor(scopes, unitId, 'configuration', collection);
    for (const piece of pieces) {
      const modelId = readString(piece, MODEL_KEYS);
      if (modelId) bump(scope.models, modelId);
      for (const pick of picksOfPiece(piece)) {
        if (pick.code) bump(scope.materials, pick.code);
        if (pick.grade) bump(scope.grades, pick.grade);
      }
    }
  }

  const all = [...scopes.values()];
  const overall = summarize(all, filterCollection || null, limit);

  const byCollection = new Map<string, UnitScope[]>();
  for (const scope of all) {
    const key = scope.collectionId ?? '';
    const found = byCollection.get(key);
    if (found) found.push(scope);
    else byCollection.set(key, [scope]);
  }
  const collections = [...byCollection.entries()]
    .map(([key, group]) => summarize(group, key || null, limit))
    .sort(
      (a, b) =>
        b.units.total - a.units.total ||
        // null (unattributed) sorts last so a real collection never hides behind it
        (a.collectionId === null ? 1 : b.collectionId === null ? -1 : 0) ||
        (a.collectionId! < b.collectionId! ? -1 : a.collectionId! > b.collectionId! ? 1 : 0),
    );

  return { ...overall, period, collections, excluded };
}
