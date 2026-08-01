/**
 * @veta/materials — how a piece is UPHOLSTERED: one code in, one appearance out.
 *
 * Three things live here, in dependency order:
 *   • the injected boundaries (`MaterialSource` — the catalog half; `ImageOps` —
 *     the pixel half). No DOM, no network, no three.js anywhere in this package;
 *   • `resolveAppearance` — THE ordered decision (swatch tone → material rgb
 *     wins → tint | neutral-tint | scan-correct → relief). `@veta/scene`
 *     consumes its plain description and builds the actual material;
 *   • the pCon/OFML adapter (`pconOfml`) and the part-ROLE taxonomy, which is
 *     what makes a module editable part by part.
 */

// ── Injected boundaries + the data they trade ────────────────────────────
export type {
  Awaitable,
  ImageLike,
  ImageOps,
  MaterialColor,
  MaterialPbr,
  MaterialSource,
} from './types.ts';

// ── THE appearance pipeline ──────────────────────────────────────────────
export { resolveAppearance, hexToInt, NEUTRAL_COLORFULNESS } from './appearance.ts';
export type {
  Appearance,
  AppearanceInput,
  AppearanceDeps,
  MapChoice,
  NormalChoice,
} from './appearance.ts';

// ── pCon/OFML adapter — both flat and under its own namespace ────────────
export * from './pconOfml/index.ts';
export * as pconOfml from './pconOfml/index.ts';

// ── Part-role taxonomy ───────────────────────────────────────────────────
export {
  PART_ROLES,
  MATERIALIZATION_ROLES,
  UNPRICED_ROLES,
  PART_LABELS,
  DEFAULT_PART_ROLES,
  DEFAULT_ROLE_SET,
  COUNT_MAX,
  partKeyFor,
  partRoleFor,
  baseKeyOf,
  hasParts,
  accessoryRoleFor,
  partKeysFor,
  partCount,
} from './partRoles.ts';
export type { PartRoleSet, PartsMap, PartNode } from './partRoles.ts';
export {
  mergedKeyOf,
  partLabelOf,
  roleLabelOf,
  finishSpecOf,
  finishOptionOf,
  structureStarterFinish,
  structureGroupsOf,
  structureGroupFor,
  sanitizePartFinishes,
} from './finishes.ts';
export type { FinishOption, FinishSpec } from './finishes.ts';
