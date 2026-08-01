/**
 * PUBLISH — the one state machine, and the completeness checks behind it.
 *
 * `draft → published` is the moment a model becomes something a visitor can be
 * shown and a quote can be built from, so the transition is GATED on the four
 * things without which a published piece is a broken promise:
 *
 *   mesh — a servable 3D file, or the client sees a generic shape;
 *   plan — the 2D silhouette every list, tile and layout renders;
 *   dims — a real cm footprint, or the piece cannot be placed at true size;
 *   sku  — a bound base product root, or the piece cannot price at all.
 *
 * Everything else is a WARNING: it may ship, and the studio still says it out
 * loud (a structure role with no palette renders as nothing in the widget, and
 * that silence is the exact failure this panel exists to name).
 *
 * The reverse transition is never gated — un-publishing is how a dealer stops
 * showing something, and refusing it would be refusing the fix.
 */
import { structureGroupsOf } from '@veta/materials';
import { structureKeysOf } from './finishes.ts';
import type { ModelStatus, StudioModel } from './types.ts';

export type PublishLevel = 'ok' | 'warn' | 'blocked';

export interface PublishCheck {
  key: string;
  label: string;
  level: PublishLevel;
  detail: string;
}

/** The four gates plus the advisories, in the order a model gets built. */
export function resolvePublishChecks(model: StudioModel | null | undefined): PublishCheck[] {
  const mesh = model?.mesh || null;
  const plan = model?.plan || null;
  const parts = model?.parts || null;
  const dims = plan && Number(plan.widthCm) > 0 && Number(plan.depthCm) > 0;

  const checks: PublishCheck[] = [
    mesh?.url
      ? { key: 'mesh', label: 'Mesh', level: 'ok', detail: `Servable file (${mesh.upAxis}-up).` }
      : { key: 'mesh', label: 'Mesh', level: 'blocked', detail: 'No 3D file — the visitor would see a generic shape.' },
    plan?.svg
      ? { key: 'plan', label: 'Plan', level: 'ok', detail: 'Top-down silhouette derived from the mesh.' }
      : { key: 'plan', label: 'Plan', level: 'blocked', detail: 'No 2D plan — tiles and layouts have nothing to draw.' },
    dims
      ? { key: 'dims', label: 'Size', level: 'ok', detail: `${Math.round(plan!.widthCm)} × ${Math.round(plan!.depthCm)} cm.` }
      : { key: 'dims', label: 'Size', level: 'blocked', detail: 'No footprint in cm — the piece cannot be placed at true size.' },
    model?.productRoot
      ? { key: 'sku', label: 'SKU', level: 'ok', detail: `Base bound to ${model.productRoot}.` }
      : { key: 'sku', label: 'SKU', level: 'blocked', detail: 'No base product — the piece cannot be quoted.' },
  ];

  // Advisories. A structure role with no palette is the silent one: the widget
  // drops a structure group that has no options, so the dealer sees a finished
  // choice in the studio and the client sees nothing at all.
  const structureKeys = structureKeysOf(parts);
  const withPalette = structureGroupsOf(parts).length;
  if (structureKeys.length && withPalette < structureKeys.length) {
    checks.push({
      key: 'structure',
      label: 'Structure',
      level: 'warn',
      detail: `${structureKeys.length - withPalette} structure group(s) carry no finish palette — the client is offered nothing.`,
    });
  }
  if (!model?.collection) {
    checks.push({
      key: 'collection',
      label: 'Collection',
      level: 'warn',
      detail: 'No collection — finishes cannot be shared with sibling models.',
    });
  }
  return checks;
}

/** The checks that BLOCK, i.e. what is left to do before publishing. */
export function blockingChecks(model: StudioModel | null | undefined): PublishCheck[] {
  return resolvePublishChecks(model).filter((c) => c.level === 'blocked');
}

export function canPublish(model: StudioModel | null | undefined): boolean {
  return blockingChecks(model).length === 0;
}

export interface PublishTransition {
  model: StudioModel;
  changed: boolean;
  /** Why it was refused; empty when it wasn't. */
  blocked: PublishCheck[];
}

/**
 * The transition itself. Publishing stamps `publishedAt` (the first time only —
 * a re-publish is not a new debut); un-publishing keeps the stamp, because when
 * a piece was first shown is history and history is not edited.
 */
export function setPublishState(model: StudioModel, want: ModelStatus, now: number): PublishTransition {
  if (model.status === want) return { model, changed: false, blocked: [] };
  if (want === 'published') {
    const blocked = blockingChecks(model);
    if (blocked.length) return { model, changed: false, blocked };
    return {
      model: { ...model, status: 'published', publishedAt: model.publishedAt ?? now, updatedAt: now },
      changed: true,
      blocked: [],
    };
  }
  return { model: { ...model, status: 'draft', updatedAt: now }, changed: true, blocked: [] };
}

export interface PublishSummary {
  total: number;
  published: number;
  drafts: number;
  /** Drafts that would publish right now — the "ready to ship" count. */
  ready: number;
  blockedByCheck: Record<string, number>;
}

/** The rail's header line: how much of the library is actually shippable. */
export function resolvePublishSummary(models: readonly StudioModel[] | null | undefined): PublishSummary {
  const list = models || [];
  const blockedByCheck: Record<string, number> = {};
  let ready = 0;
  let published = 0;
  for (const m of list) {
    if (m.status === 'published') { published++; continue; }
    const blocked = blockingChecks(m);
    if (!blocked.length) ready++;
    for (const c of blocked) blockedByCheck[c.key] = (blockedByCheck[c.key] || 0) + 1;
  }
  return { total: list.length, published, drafts: list.length - published, ready, blockedByCheck };
}
