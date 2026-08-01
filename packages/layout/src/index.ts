// @veta/layout — the placement/layout engine. Pure geometry in plan centimetres:
// where a piece lands, how a run connects, what fits in the room, and how a build
// travels between devices. No React, no three.js, no catalog, no siblings.

export {
  DEFAULT_LAYOUT_PARAMS,
  norm360,
  linkOverlap,
  resolvePlacement,
  footprintOf,
  overlapsAny,
  resolveCollision,
  snapPlacement,
  snapPlacementInfo,
  compactPlaced,
  duplicatePlacement,
  cyclePieceUid,
} from './placement.ts';
export type {
  LayoutParams,
  PieceBox,
  SnapResult,
  SnapOptions,
  CollisionResult,
  Placed,
  PlacementOverride,
  PieceModel,
  PieceModelMap,
  DuplicateResult,
} from './placement.ts';

export {
  ROOM_MIN_CM,
  ROOM_MAX_CM,
  clampRoomDim,
  makeRectRoom,
  normalizeRoom,
  roomBounds,
  roomSize,
  roomCenter,
  pointInRoom,
  roomFit,
} from './room.ts';
export type { Room, RoomShape, RoomCorner, RoomBounds } from './room.ts';

export { SOFA_ROLES, SOFA_QUICK_STARTS, roleOf, resolveQuickStarts } from './quickStarts.ts';
export type { QuickStartSpec, QuickStartRole, QuickStartCatalogItem, QuickStart } from './quickStarts.ts';

export { BUILD_SHARE_VERSION, encodeBuild, decodeBuild, decodeRoomFromBuild } from './buildShare.ts';
export type { BuildPlacement, BuildMaterial, EncodeBuildOptions, DecodeBuildOptions } from './buildShare.ts';

export { HISTORY_LIMIT, makeHistory, historyPush, historyUndo, historyRedo, canUndo, canRedo } from './history.ts';
export type { History } from './history.ts';
