// Applies the Supabase stub + migration 0001 to a blank database and seeds two
// independent tenants (org A and org B) plus the platform org. Every red-team
// invariant is an attempt by one tenant's credential to reach the other's rows,
// so the fixture is deliberately symmetric: same shapes, different orgs.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'infra', 'supabase', 'migrations');
const STUB_SQL = join(HERE, 'sql', '00_supabase_stub.sql');

export interface OrgFixture {
  slug: string;
  orgId: string;
  brandId: string;
  dealerId: string;
  otherDealerId: string;
  adminUserId: string;
  editorUserId: string;
  dealerUserId: string;
  strangerUserId: string;
  collectionId: string;
  collectionSlug: string;
  draftCollectionId: string;
  modelId: string;
  draftModelId: string;
  priceListId: string;
  sku: string;
  priceMinor: number;
  currency: string;
  configurationId: string;
  shareToken: string;
  leadRoutedId: string;
  leadOtherId: string;
  pk: string;
  pkId: string;
  sk: string;
  skId: string;
  revokedPk: string;
  originPk: string;
}

export interface Fixtures {
  a: OrgFixture;
  b: OrgFixture;
  platformOrgId: string;
  platformAdminUserId: string;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export async function applySchema(client: pg.Client | pg.PoolClient): Promise<void> {
  await client.query(readFileSync(STUB_SQL, 'utf8'));
  for (const file of migrationFiles()) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

async function one<T extends pg.QueryResultRow>(
  c: pg.Client | pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await c.query<T>(sql, params);
  if (!r.rows[0]) throw new Error(`seed: expected a row from ${sql.slice(0, 60)}…`);
  return r.rows[0];
}

async function seedUser(c: pg.Client | pg.PoolClient, email: string): Promise<string> {
  const row = await one<{ id: string }>(
    c,
    'insert into auth.users (email) values ($1) returning id', [email],
  );
  return row.id;
}

/** Issue a key AS the org's brand_admin, so the RPC's own authorization runs. */
async function issueKey(
  c: pg.Client | pg.PoolClient,
  actorUserId: string,
  orgId: string,
  kind: 'publishable' | 'secret',
  scopes: string[],
  origins: string[] = [],
): Promise<{ id: string; token: string }> {
  await c.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', actorUserId]);
  try {
    const row = await one<{ key_id: string; key_token: string }>(
    c,
      'select key_id, key_token from public.issue_api_key($1,$2,$3,$4)',
      [orgId, kind, scopes, origins],
    );
    return { id: row.key_id, token: row.key_token };
  } finally {
    await c.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', '']);
  }
}

const PK_SCOPES = ['catalog:read', 'configurations:write', 'leads:write', 'events:write'];
const SK_SCOPES = ['catalog:read', 'leads:read', 'leads:write'];

async function seedOrg(c: pg.Client | pg.PoolClient, slug: string, priceMinor: number): Promise<OrgFixture> {
  const org = await one<{ id: string }>(
    c,
    "insert into public.orgs (kind, name, slug) values ('brand', $1, $2) returning id",
    [`Org ${slug.toUpperCase()}`, slug],
  );
  const brand = await one<{ id: string }>(
    c,
    'insert into public.brands (org_id, name, slug) values ($1,$2,$3) returning id',
    [org.id, `Brand ${slug}`, `${slug}-brand`],
  );
  const dealer = await one<{ id: string }>(
    c,
    'insert into public.dealers (org_id, brand_id, name, slug, currency) values ($1,$2,$3,$4,$5) returning id',
    [org.id, brand.id, `${slug} dealer one`, `${slug}-d1`, 'USD'],
  );
  const otherDealer = await one<{ id: string }>(
    c,
    'insert into public.dealers (org_id, brand_id, name, slug, currency) values ($1,$2,$3,$4,$5) returning id',
    [org.id, brand.id, `${slug} dealer two`, `${slug}-d2`, 'USD'],
  );
  await c.query(
    'insert into public.dealer_locations (org_id, dealer_id, name, lat, lng) values ($1,$2,$3,$4,$5)',
    [org.id, dealer.id, 'Showroom', 18.47, -69.9],
  );

  const adminUserId = await seedUser(c, `admin@${slug}.test`);
  const editorUserId = await seedUser(c, `editor@${slug}.test`);
  const dealerUserId = await seedUser(c, `dealer@${slug}.test`);
  const strangerUserId = await seedUser(c, `stranger@${slug}.test`);

  await c.query(
    `insert into public.org_members (org_id, user_id, role, dealer_id) values
       ($1,$2,'brand_admin',null), ($1,$3,'brand_editor',null), ($1,$4,'dealer',$5)`,
    [org.id, adminUserId, editorUserId, dealerUserId, dealer.id],
  );

  const collection = await one<{ id: string }>(
    c,
    `insert into public.collections (org_id, brand_id, name, slug, status, render_params)
     values ($1,$2,$3,$4,'published','{"gridCm":2}'::jsonb) returning id`,
    [org.id, brand.id, `${slug} sofas`, `${slug}-sofas`],
  );
  const draftCollection = await one<{ id: string }>(
    c,
    `insert into public.collections (org_id, brand_id, name, slug, status)
     values ($1,$2,$3,$4,'draft') returning id`,
    [org.id, brand.id, `${slug} unreleased`, `${slug}-unreleased`],
  );

  await c.query(
    `insert into public.part_roles (org_id, brand_id, key, label, billing) values
       ($1,$2,'base','{"en":"Base"}'::jsonb,'none'),
       ($1,$2,'exterior','{"en":"Exterior"}'::jsonb,'zone')`,
    [org.id, brand.id],
  );
  await c.query(
    'insert into public.sku_grammars (org_id, brand_id, adapter) values ($1,$2,$3)',
    [org.id, brand.id, 'simple'],
  );
  const material = await one<{ id: string }>(
    c,
    'insert into public.materials (org_id, brand_id, name, category) values ($1,$2,$3,$4) returning id',
    [org.id, brand.id, `${slug} weave`, 'fabric'],
  );
  await c.query(
    'insert into public.material_colors (org_id, material_id, name, code, grade) values ($1,$2,$3,$4,$5)',
    [org.id, material.id, 'Sand', `${slug}-sand`, 'A'],
  );

  const sku = `${slug.toUpperCase()}-SKU-1`;
  const model = await one<{ id: string }>(
    c,
    `insert into public.models (org_id, collection_id, name, slug, status, tags, width_cm, depth_cm, sku)
     values ($1,$2,$3,$4,'published','{seat}',100,100,$5) returning id`,
    [org.id, collection.id, `${slug} seat`, `${slug}-seat`, sku],
  );
  const draftModel = await one<{ id: string }>(
    c,
    `insert into public.models (org_id, collection_id, name, slug, status, sku)
     values ($1,$2,$3,$4,'draft',$5) returning id`,
    [org.id, collection.id, `${slug} prototype`, `${slug}-prototype`, `${sku}-X`],
  );

  const priceList = await one<{ id: string }>(
    c,
    `insert into public.price_lists (org_id, brand_id, label, currency, valid_from, status)
     values ($1,$2,$3,'USD', current_date, 'active') returning id`,
    [org.id, brand.id, `${slug} 2026`],
  );
  await c.query(
    'insert into public.prices (org_id, price_list_id, sku, grade, amount_minor) values ($1,$2,$3,$4,$5)',
    [org.id, priceList.id, sku, '', priceMinor],
  );

  await c.query(
    `insert into public.rulesets (org_id, collection_id, version, status, rules)
     values ($1,$2,1,'active',$3::jsonb)`,
    [
      org.id,
      collection.id,
      JSON.stringify({ schema: 1, rules: [{ id: 'max-pieces', type: 'count', max: 20, severity: 'error' }] }),
    ],
  );

  const shareToken = `share_${slug}_${Math.random().toString(36).slice(2, 10)}`;
  const configuration = await one<{ id: string }>(
    c,
    `insert into public.configurations (org_id, collection_id, build, pricing_snapshot, share_token, status)
     values ($1,$2,$3,$4,$5,'saved') returning id`,
    [
      org.id,
      collection.id,
      JSON.stringify({ pieces: [{ uid: 'p1', modelId: model.id, x: 0, y: 0, rot: 0 }] }),
      JSON.stringify({ amount_minor: priceMinor, currency: 'USD', priced_at: new Date().toISOString() }),
      shareToken,
    ],
  );

  const leadRouted = await one<{ id: string }>(
    c,
    `insert into public.leads (org_id, brand_id, dealer_id, configuration_id, contact, note, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      org.id, brand.id, dealer.id, configuration.id,
      JSON.stringify({ name: `${slug} buyer`, email: `buyer@${slug}.test`, phone: '+18095551212' }),
      'routed lead', `${slug}-lead-1`,
    ],
  );
  const leadOther = await one<{ id: string }>(
    c,
    `insert into public.leads (org_id, brand_id, dealer_id, contact, note, dedupe_key)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [
      org.id, brand.id, otherDealer.id,
      JSON.stringify({ name: `${slug} other buyer`, email: `other@${slug}.test` }),
      'other dealer lead', `${slug}-lead-2`,
    ],
  );

  await c.query(
    "insert into public.events (org_id, session_id, kind, payload) values ($1,$2,'widget.open','{}'::jsonb)",
    [org.id, `sess-${slug}`],
  );

  await c.query(
    'insert into storage.objects (bucket_id, name) values ($1,$2)',
    ['meshes', `org/${org.id}/${slug}-seat.glb`],
  );

  const pk = await issueKey(c, adminUserId, org.id, 'publishable', PK_SCOPES);
  const sk = await issueKey(c, adminUserId, org.id, 'secret', SK_SCOPES);
  const revoked = await issueKey(c, adminUserId, org.id, 'publishable', PK_SCOPES);
  const origin = await issueKey(c, adminUserId, org.id, 'publishable', PK_SCOPES, [`https://${slug}.example`]);

  await c.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', adminUserId]);
  await c.query('select public.revoke_api_key($1)', [revoked.id]);
  await c.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', '']);

  return {
    slug,
    orgId: org.id,
    brandId: brand.id,
    dealerId: dealer.id,
    otherDealerId: otherDealer.id,
    adminUserId,
    editorUserId,
    dealerUserId,
    strangerUserId,
    collectionId: collection.id,
    collectionSlug: `${slug}-sofas`,
    draftCollectionId: draftCollection.id,
    modelId: model.id,
    draftModelId: draftModel.id,
    priceListId: priceList.id,
    sku,
    priceMinor,
    currency: 'USD',
    configurationId: configuration.id,
    shareToken,
    leadRoutedId: leadRouted.id,
    leadOtherId: leadOther.id,
    pk: pk.token,
    pkId: pk.id,
    sk: sk.token,
    skId: sk.id,
    revokedPk: revoked.token,
    originPk: origin.token,
  };
}

export async function seed(c: pg.Client | pg.PoolClient): Promise<Fixtures> {
  const platform = await one<{ id: string }>(
    c,
    "insert into public.orgs (kind, name, slug) values ('platform','VETA','veta') returning id",
  );
  const platformAdminUserId = await seedUser(c, 'root@veta.test');
  await c.query(
    "insert into public.org_members (org_id, user_id, role) values ($1,$2,'platform_admin')",
    [platform.id, platformAdminUserId],
  );

  const a = await seedOrg(c, 'orga', 250_000);
  const b = await seedOrg(c, 'orgb', 990_000);
  return { a, b, platformOrgId: platform.id, platformAdminUserId };
}

// --- plane helpers ----------------------------------------------------------

/** Member plane: role `authenticated` + a stubbed auth.uid(). Always rolls back. */
export async function asMember<T>(
  pool: pg.Pool,
  userId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select set_config($1,$2,true)', ['request.jwt.claim.sub', userId ?? '']);
    await c.query('set local role authenticated');
    const out = await fn(c);
    await c.query('rollback');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Maintenance plane: the migration owner, RLS-bypassing. Never a request path. */
export async function asMaintenance<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Runs a probe expected to be refused; returns the Postgres error message. */
export async function denied(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
