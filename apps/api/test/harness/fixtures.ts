// THE RULES FIXTURES, AS TENANT DATA.
//
// `packages/rules/test/fixtures/*` are authored share-ready (design §1.10): the
// package replays them against the engine directly, and WP-1.4 replays THE SAME
// FILES through the HTTP path. This helper is the bridge — it turns one fixture
// file into a real published collection (models with the fixture's tags and
// footprints, an active ruleset carrying the fixture's rules verbatim, a price
// per model on the org's active list) so a case's pieces can be POSTed as a
// configuration and the STORED verdict compared to the pinned one.
//
// The only rewrite between fixture and wire is the model id: a fixture names
// models by key ('vira-seat'), the database by uuid. Everything else — uids,
// coordinates, rotations, picks — is sent exactly as authored, because anything
// this file "helped with" would be a difference the parity test stops seeing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { PlacedPiece, RuleCatalog, Verdict } from '@veta/rules';
import { REPO_ROOT, type OrgFixture } from './seed.ts';

export const RULES_FIXTURES_DIR = join(REPO_ROOT, 'packages', 'rules', 'test', 'fixtures');

/** Both authored cases files, by name — the parity test iterates this list. */
export const FIXTURE_FILES = ['togo-freeform.cases.json', 'vira-strict.cases.json'] as const;

export interface FixtureCase {
  name: string;
  pieces: PlacedPiece[];
  verdict: Verdict;
}

export interface CaseFile {
  ruleset: string;
  catalog: RuleCatalog;
  cases: FixtureCase[];
}

export interface SeededFixture {
  file: string;
  /** The ruleset document as authored, byte-for-byte what the collection stores. */
  ruleset: unknown;
  collectionId: string;
  collectionSlug: string;
  /** fixture model key → the seeded model's uuid. */
  modelIdByKey: Record<string, string>;
  /** fixture model key → its seeded price, in minor units. */
  priceMinorByKey: Record<string, number>;
  cases: FixtureCase[];
  /** True when the ruleset carries an error rule (the strict save gate applies). */
  strict: boolean;
}

export function readFixture(file: string): { cases: CaseFile; ruleset: unknown } {
  const cases = JSON.parse(readFileSync(join(RULES_FIXTURES_DIR, file), 'utf8')) as CaseFile;
  const ruleset = JSON.parse(readFileSync(join(RULES_FIXTURES_DIR, cases.ruleset), 'utf8')) as unknown;
  return { cases, ruleset };
}

function slugOf(catalog: RuleCatalog, file: string): string {
  const first = Object.values(catalog.modelById)[0];
  return String(first?.collection || file.replace(/\..*$/, ''));
}

/** A case's pieces with fixture model keys rewritten to the seeded uuids. */
export function wirePieces(pieces: readonly PlacedPiece[], modelIdByKey: Record<string, string>): PlacedPiece[] {
  return pieces.map((piece) => ({
    ...piece,
    modelId: modelIdByKey[String(piece.modelId)] ?? String(piece.modelId),
  }));
}

/**
 * Seed one fixture file as a published collection of `org`. Prices are seeded on
 * the org's EXISTING active list so the parity test also sees real money flow
 * through the same save.
 */
export async function seedFixture(
  c: pg.Client | pg.PoolClient,
  org: OrgFixture,
  file: string,
): Promise<SeededFixture> {
  const { cases, ruleset } = readFixture(file);
  const slug = slugOf(cases.catalog, file);

  const collection = await c.query<{ id: string }>(
    `insert into public.collections (org_id, brand_id, name, slug, status, render_params)
     values ($1,$2,$3,$4,'published','{}'::jsonb) returning id`,
    [org.orgId, org.brandId, `${slug} fixture`, slug],
  );
  const collectionId = collection.rows[0]!.id;

  const modelIdByKey: Record<string, string> = {};
  const priceMinorByKey: Record<string, number> = {};
  let n = 0;
  for (const [key, model] of Object.entries(cases.catalog.modelById)) {
    n += 1;
    const row = await c.query<{ id: string }>(
      `insert into public.models
         (org_id, collection_id, name, slug, status, tags, width_cm, depth_cm, mount, sku, sort_order)
       values ($1,$2,$3,$4,'published',$5,$6,$7,$8::jsonb,$9,$10) returning id`,
      [
        org.orgId,
        collectionId,
        key,
        key,
        model.tags ?? [],
        model.widthCm,
        model.depthCm,
        model.mount ? JSON.stringify(model.mount) : null,
        key,
        n,
      ],
    );
    modelIdByKey[key] = row.rows[0]!.id;
    // Distinct per model, so a mis-mapped model shows up as a wrong TOTAL rather
    // than as a coincidence.
    const priceMinor = 100_000 + n * 1_000;
    priceMinorByKey[key] = priceMinor;
    await c.query(
      'insert into public.prices (org_id, price_list_id, sku, grade, amount_minor) values ($1,$2,$3,$4,$5)',
      [org.orgId, org.priceListId, key, '', priceMinor],
    );
  }

  await c.query(
    `insert into public.rulesets (org_id, collection_id, version, status, rules)
     values ($1,$2,1,'active',$3::jsonb)`,
    [org.orgId, collectionId, JSON.stringify(ruleset)],
  );

  const rules = (ruleset as { rules?: Array<{ severity?: string }> }).rules ?? [];
  return {
    file,
    ruleset,
    collectionId,
    collectionSlug: slug,
    modelIdByKey,
    priceMinorByKey,
    cases: cases.cases,
    strict: rules.some((rule) => (rule?.severity ?? 'error') === 'error'),
  };
}

export async function seedFixtures(
  c: pg.Client | pg.PoolClient,
  org: OrgFixture,
  files: readonly string[] = FIXTURE_FILES,
): Promise<SeededFixture[]> {
  const out: SeededFixture[] = [];
  for (const file of files) out.push(await seedFixture(c, org, file));
  return out;
}
