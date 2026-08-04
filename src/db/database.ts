import { supabase, publicImageUrl, IMAGES_BUCKET } from './supabaseClient.js';
import { normalizeImageForUpload } from './imageNormalize.js';
import { isSharedCatalogImage, imageBytesUrl, DOWNLOAD_IMG_WIDTH } from '../lib/catalogImages.js';
import { parseSearchQuery, rankCatalogMatches } from '../lib/productSearch.js';
import { snake, toRow, fromRow, fromRows, isAtField, type Row } from './rowMapping.js';
import { cacheKey, getCached, setCached, purgeTable, purgeAll } from './queryCache.js';
import {
  tableScopeFor, brandStampFor, catalogBrandScope, getBrandScope, type TableScope,
} from './brandScope.js';
import type { Brand } from './brands.js';
import type {
  Profile,
  Settings,
  Customer,
  Professional,
  Order,
  OrderEmailThread,
  Quote,
  QuoteLine,
  Container,
  ImageRecord,
  Material,
  ModelFabrics,
  QuoteGroup,
  Product,
  Dealer,
  TogoModel,
  TogoRequest,
  LsgStockCommitment,
  Account,
  JournalEntry,
  JournalLine,
  Supplier,
  Expense,
  SalePosting,
  InventoryItem,
  InventoryMovement,
  StockCountSessionRow,
  Purchase,
  ImportLiquidation,
  ImportExpediente,
  PriceListEdition,
  PriceListEntry,
  FixedAsset,
  AssetDepreciation,
  PrepaidExpense,
  PrepaidAmortization,
  Ir2Worksheet,
  ECFSequence,
  EcfReceived,
  EcfCommercialApproval,
  Payment,
  PaymentPlan,
  FiscalPeriod,
  PettyCashFund,
  PettyCashVoucher,
  BankRule,
  BankAccount,
  BankStatement,
  CollectionReminder,
  Budget,
  RecurringTemplate,
  AuditLogEntry,
  Activity,
  PurchaseOrder,
  SavedReport,
  Employee,
  PayrollRun,
  WaMessage,
  GmailMessage,
  WaCampaign,
  EmailCampaign,
  WaConversationState,
  WaGroup,
  WaGroupParticipant,
  WaOptOut,
  ClaudeMessage,
  AgentAction,
  AgentNote,
  ScheduledPost,
  GeneratedImage,
  IgEvent,
  IgMessage,
  IgAccount,
  IgRepost,
  MetaReceipt,
  VendorReceipt,
  DevTodo,
  WaTemplateRejection,
  WaWebhookEvent,
  PibBriefing,
  RateHistory,
  PushSubscriptionRow,
} from '../types/domain.ts';

/**
 * Alcover Soft cloud data layer.
 *
 * Exposes a Dexie-shaped API (`db.<table>.where().equals().toArray()`, etc.)
 * backed by Supabase Postgres + Storage. The React pages continue to import
 * `db`, `newId`, and the image helpers from this module without knowing
 * they're talking to the cloud.
 *
 * Row-name conversion (camelCase ↔ snake_case + timestamp coercion) lives
 * in `./rowMapping.js` so the contract can be tested without a Supabase
 * mock.
 *
 * Mutations call `invalidate()` so the `useLiveQuery` hook refetches.
 */

/* ---------------------------------------------------------------------- */
/*  Table catalog                                                          */
/* ---------------------------------------------------------------------- */

interface TableDef {
  /** Postgres relation name (snake_case). */
  db: string;
  /** Primary-key property as seen from JS code (camelCase). */
  pk: string;
}

/**
 * Map of JS-side table names → their Postgres relation + PK metadata.
 * The shape of `TABLES` is the source of truth for `TableName` and the
 * `db` typed object below.
 */
const TABLES = {
  profiles:      { db: 'profiles',      pk: 'id' },
  brands:        { db: 'brands',        pk: 'id' },
  settings:      { db: 'settings',      pk: 'profileId' },
  images:        { db: 'images',        pk: 'id' },
  customers:     { db: 'customers',     pk: 'id' },
  professionals: { db: 'professionals', pk: 'id' },
  orders:        { db: 'orders',        pk: 'id' },
  quotes:        { db: 'quotes',        pk: 'id' },
  quoteLines:    { db: 'quote_lines',   pk: 'id' },
  quoteGroups:   { db: 'quote_groups',  pk: 'id' },
  containers:    { db: 'containers',    pk: 'id' },
  orderEmailThreads: { db: 'order_email_threads', pk: 'id' },
  materials:     { db: 'materials',     pk: 'id' },
  products:      { db: 'products',      pk: 'id' },
  dealers:       { db: 'dealers',       pk: 'id' },
  togoModels:    { db: 'togo_models',   pk: 'id' },
  togoRequests:  { db: 'togo_requests', pk: 'id' },
  lsgStockCommitments: { db: 'lsg_stock_commitments', pk: 'id' },
  modelFabrics:  { db: 'model_fabrics', pk: 'id' },
  accounts:      { db: 'accounts',        pk: 'code' },
  journalEntries:{ db: 'journal_entries', pk: 'id' },
  journalLines:  { db: 'journal_lines',   pk: 'id' },
  suppliers:     { db: 'suppliers',       pk: 'id' },
  expenses:      { db: 'expenses',        pk: 'id' },
  salesPostings: { db: 'sales_postings',  pk: 'id' },
  inventoryItems:     { db: 'inventory_items',     pk: 'id' },
  inventoryMovements: { db: 'inventory_movements', pk: 'id' },
  stockCountSessions: { db: 'stock_count_sessions', pk: 'id' },
  purchases:          { db: 'purchases',           pk: 'id' },
  importLiquidations: { db: 'import_liquidations', pk: 'id' },
  importExpedientes: { db: 'import_expedientes', pk: 'id' },
  priceListEditions: { db: 'price_list_editions', pk: 'id' },
  priceListEntries:  { db: 'price_list_entries',  pk: 'id' },
  fixedAssets:        { db: 'fixed_assets',        pk: 'id' },
  assetDepreciations: { db: 'asset_depreciations', pk: 'id' },
  prepaidExpenses:      { db: 'prepaid_expenses',      pk: 'id' },
  prepaidAmortizations: { db: 'prepaid_amortizations', pk: 'id' },
  ir2Worksheets:        { db: 'ir2_worksheets',        pk: 'id' },
  ecfSequences:       { db: 'ecf_sequences',       pk: 'id' },
  ecfReceived:            { db: 'ecf_received',             pk: 'id' },
  ecfCommercialApprovals: { db: 'ecf_commercial_approvals', pk: 'id' },
  payments:           { db: 'payments',            pk: 'id' },
  paymentPlans:       { db: 'payment_plans',       pk: 'id' },
  fiscalPeriods:      { db: 'fiscal_periods',      pk: 'id' },
  pettyCashFunds:     { db: 'petty_cash_funds',    pk: 'id' },
  pettyCashVouchers:  { db: 'petty_cash_vouchers', pk: 'id' },
  bankRules:          { db: 'bank_rules',          pk: 'id' },
  bankAccounts:       { db: 'bank_accounts',       pk: 'id' },
  bankStatements:     { db: 'bank_statements',     pk: 'id' },
  collectionReminders:{ db: 'collection_reminders', pk: 'id' },
  budgets:            { db: 'budgets',             pk: 'id' },
  recurringTemplates: { db: 'recurring_templates', pk: 'id' },
  auditLog:           { db: 'audit_log',           pk: 'id' },
  purchaseOrders:     { db: 'purchase_orders',     pk: 'id' },
  savedReports:       { db: 'saved_reports',       pk: 'id' },
  employees:          { db: 'employees',           pk: 'id' },
  payrollRuns:        { db: 'payroll_runs',        pk: 'id' },
  waMessages:         { db: 'wa_messages',         pk: 'id' },
  gmailMessages:      { db: 'gmail_messages',      pk: 'id' },
  waCampaigns:        { db: 'wa_campaigns',        pk: 'id' },
  waConversationState:{ db: 'wa_conversation_state', pk: 'id' },
  waGroups:           { db: 'wa_groups',           pk: 'id' },
  waGroupParticipants:{ db: 'wa_group_participants', pk: 'id' },
  claudeMessages:     { db: 'claude_messages',     pk: 'id' },
  agentActions:       { db: 'agent_actions',       pk: 'id' },
  agentNotes:         { db: 'agent_notes',         pk: 'id' },
  scheduledPosts:     { db: 'scheduled_posts',     pk: 'id' },
  generatedImages:    { db: 'generated_images',    pk: 'id' },
  igEvents:           { db: 'ig_events',           pk: 'id' },
  igMessages:         { db: 'ig_messages',         pk: 'id' },
  igAccounts:         { db: 'ig_accounts',         pk: 'id' },
  igReposts:          { db: 'ig_reposts',          pk: 'id' },
  metaReceipts:       { db: 'meta_receipts',       pk: 'id' },
  vendorReceipts:     { db: 'vendor_receipts',     pk: 'id' },
  devTodos:           { db: 'dev_todos',           pk: 'id' },
  activities:         { db: 'activities',          pk: 'id' },
  waTemplateRejections: { db: 'wa_template_rejections', pk: 'id' },
  waWebhookEvents:    { db: 'wa_webhook_events',    pk: 'id' },
  waOptouts:          { db: 'wa_optouts',           pk: 'id' },
  emailCampaigns:     { db: 'email_campaigns',      pk: 'id' },
  pibBriefings:       { db: 'pib_briefings',        pk: 'id' },
  rateHistory:        { db: 'rate_history',         pk: 'rateDate' },
  pushSubscriptions:  { db: 'push_subscriptions',   pk: 'id' },
} as const satisfies Record<string, TableDef>;

export type TableName = keyof typeof TABLES;

/**
 * JS table name → domain row type. Every entry maps to the camelCased
 * shape `fromRow` produces; the snake-case Postgres column names never
 * escape this file.
 */
export interface TableRowMap {
  profiles: Profile;
  brands: Brand;
  settings: Settings;
  images: ImageRecord;
  customers: Customer;
  professionals: Professional;
  orders: Order;
  quotes: Quote;
  quoteLines: QuoteLine;
  quoteGroups: QuoteGroup;
  containers: Container;
  orderEmailThreads: OrderEmailThread;
  materials: Material;
  products: Product;
  dealers: Dealer;
  togoModels: TogoModel;
  togoRequests: TogoRequest;
  lsgStockCommitments: LsgStockCommitment;
  modelFabrics: ModelFabrics;
  accounts: Account;
  journalEntries: JournalEntry;
  journalLines: JournalLine;
  suppliers: Supplier;
  expenses: Expense;
  salesPostings: SalePosting;
  inventoryItems: InventoryItem;
  inventoryMovements: InventoryMovement;
  stockCountSessions: StockCountSessionRow;
  purchases: Purchase;
  importLiquidations: ImportLiquidation;
  importExpedientes: ImportExpediente;
  priceListEditions: PriceListEdition;
  priceListEntries: PriceListEntry;
  fixedAssets: FixedAsset;
  assetDepreciations: AssetDepreciation;
  prepaidExpenses: PrepaidExpense;
  prepaidAmortizations: PrepaidAmortization;
  ir2Worksheets: Ir2Worksheet;
  ecfSequences: ECFSequence;
  ecfReceived: EcfReceived;
  ecfCommercialApprovals: EcfCommercialApproval;
  payments: Payment;
  paymentPlans: PaymentPlan;
  fiscalPeriods: FiscalPeriod;
  pettyCashFunds: PettyCashFund;
  pettyCashVouchers: PettyCashVoucher;
  bankRules: BankRule;
  bankAccounts: BankAccount;
  bankStatements: BankStatement;
  collectionReminders: CollectionReminder;
  budgets: Budget;
  recurringTemplates: RecurringTemplate;
  auditLog: AuditLogEntry;
  purchaseOrders: PurchaseOrder;
  savedReports: SavedReport;
  employees: Employee;
  payrollRuns: PayrollRun;
  waMessages: WaMessage;
  gmailMessages: GmailMessage;
  waCampaigns: WaCampaign;
  waConversationState: WaConversationState;
  waGroups: WaGroup;
  waGroupParticipants: WaGroupParticipant;
  claudeMessages: ClaudeMessage;
  agentActions: AgentAction;
  agentNotes: AgentNote;
  scheduledPosts: ScheduledPost;
  generatedImages: GeneratedImage;
  igEvents: IgEvent;
  igMessages: IgMessage;
  igAccounts: IgAccount;
  igReposts: IgRepost;
  metaReceipts: MetaReceipt;
  vendorReceipts: VendorReceipt;
  devTodos: DevTodo;
  activities: Activity;
  waTemplateRejections: WaTemplateRejection;
  waWebhookEvents: WaWebhookEvent;
  waOptouts: WaOptOut;
  emailCampaigns: EmailCampaign;
  pibBriefings: PibBriefing;
  rateHistory: RateHistory;
  pushSubscriptions: PushSubscriptionRow;
}

// Row mapping (snake_case ↔ camelCase + *At timestamp coercion) is in
// `./rowMapping.js` so the conversion contract can be unit-tested
// without standing up @supabase/supabase-js. The bug the test suite
// over there catches: reading `profile.commission_pct` on an object
// that's already been camelCased through fromRow returns undefined.

/* ---------------------------------------------------------------------- */
/*  Invalidation bus (powers useLiveQuery)                                 */
/* ---------------------------------------------------------------------- */

type InvalidateCallback = () => void;

const listeners = new Set<InvalidateCallback>();
export function subscribeInvalidate(cb: InvalidateCallback): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
/**
 * Signal that data changed: purge the read cache, then notify every live-query
 * listener so it refetches. Listener notification is UNCHANGED from before —
 * all listeners always fire, in both call shapes.
 *
 *   invalidate()          → purge the WHOLE cache (bare callers: money-path
 *                           RPC writes and every existing site — byte-identical
 *                           refetch behavior, just with a full cache drop).
 *   invalidate(table)     → purge only that table's cached reads (a scoped
 *   invalidate([t1, t2])    write knows exactly what it touched), then notify.
 */
export function invalidate(tables?: TableName | TableName[]): void {
  if (tables === undefined) {
    purgeAll();
  } else {
    const list = Array.isArray(tables) ? tables : [tables];
    for (const t of list) purgeTable(t);
  }
  for (const cb of [...listeners]) {
    try { cb(); } catch (e) { console.error(e); }
  }
}

/* ---------------------------------------------------------------------- */
/*  Chainable Query — matches Dexie's where().equals().toArray()/sortBy() */
/* ---------------------------------------------------------------------- */

/** The subset of a PostgREST builder `applyFilters` touches. */
interface Filterable {
  eq(column: string, value: unknown): Filterable;
  in(column: string, values: unknown[]): Filterable;
  gt(column: string, value: unknown): Filterable;
  gte(column: string, value: unknown): Filterable;
}

interface Filter {
  field: string;
  value?: unknown;
  values?: unknown[];
  /** 'eq' (equals, the default) · 'in' (anyOf) · 'gte'/'gt' (aboveOrEqual/above). */
  op?: 'eq' | 'in' | 'gte' | 'gt';
}

/**
 * Numeric coercion for the sortBy comparator. A real number passes through;
 * a non-empty, fully-numeric string (e.g. a bigint column PostgREST handed
 * back as "1003") is parsed to a number. Anything else (a name, a UUID, a
 * partly-numeric label like "A12") returns null so the caller falls back to
 * a lexicographic compare — we only want NUMERIC strings to sort numerically.
 */
function asNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * `Query<T>` is the chainable builder returned by `Table<T>.where()` /
 * `Table<T>.orderBy()`. Each chain step returns `this` so call sites
 * can fluently compose: `db.X.where(...).equals(...).reverse().sortBy(...)`.
 *
 * `T` is the camelCased domain row type (`Quote`, `Order`, etc.). The
 * terminal methods (`toArray`, `sortBy`, `first`) all resolve to that
 * row shape; `count` resolves to `number`.
 */
export class Query<T> implements PromiseLike<T[]> {
  private t: TableDef;
  private jsName: TableName;
  private filters: Filter[] = [];
  private pending: string | null = null;
  private orderField: string | null = null;
  private sortField: string | null = null;
  private reversed = false;
  private predicate: ((row: T) => boolean) | null = null;
  private _limit: number | null = null;
  private _ttl: number | undefined = undefined;
  private _columns: string[] | null = null;
  private scoped = false;

  constructor(table: TableDef, jsName: TableName) {
    this.t = table;
    this.jsName = jsName;
  }

  /**
   * Fold the ACTIVE BRAND into this query — the structural half of the brand
   * microenvironment (see `brandScope.ts`). It runs once per query, BEFORE the
   * cache key is built, so a cached read can never be served across a brand
   * switch, and it never overrides a caller who already filtered the scope field
   * itself (the brand admin reads other brands' rows on purpose).
   *
   * Returns false when the active brand owns nothing in this table, and the
   * terminal answers empty without a round-trip.
   */
  private applyBrandScope(): boolean {
    if (this.scoped) return true;
    this.scoped = true;
    const scope: TableScope = tableScopeFor(this.jsName);
    if (!scope) return true;
    if (scope.kind === 'empty') return false;
    if (this.filters.some((f) => f.field === scope.field)) return true;
    this.filters.push({ field: scope.field, value: scope.value });
    return true;
  }

  where(field: (keyof T & string) | string): this {
    // A trailing where() without a matching equals() would silently
    // swallow the filter and return the whole table. Fail-fast at
    // the next call instead of returning corrupt data.
    if (typeof field !== 'string' || !field) {
      throw new Error('where() requires a non-empty field name');
    }
    if (this.pending != null) {
      throw new Error(`where('${field}') called twice without an equals() between them`);
    }
    this.pending = field;
    return this;
  }
  equals(value: unknown): this {
    if (this.pending == null) throw new Error('equals() called without where()');
    // Coerce an *At filter value the same way toRow coerces it on write: a
    // JS millisecond timestamp becomes the ISO-8601 string Postgres stores
    // in the timestamptz column, so `.where('createdAt').equals(ms)` actually
    // matches. Non-At fields (and already-string At values) pass through
    // unchanged so every existing caller behaves identically.
    let v = value;
    if (isAtField(this.pending) && typeof v === 'number' && Number.isFinite(v)) {
      v = new Date(v).toISOString();
    }
    this.filters.push({ field: this.pending, value: v });
    this.pending = null;
    return this;
  }
  anyOf(values: unknown[]): this {
    if (this.pending == null) throw new Error('anyOf() called without where()');
    // Coerce each *At value the same way equals() does, so a set membership
    // filter on a timestamptz field matches the stored ISO strings.
    const field = this.pending;
    const vs = (values || []).map((value) =>
      isAtField(field) && typeof value === 'number' && Number.isFinite(value)
        ? new Date(value).toISOString()
        : value,
    );
    this.filters.push({ field, values: vs });
    this.pending = null;
    return this;
  }
  /**
   * Range filter (Dexie's `above` / `aboveOrEqual`) — `field > value` /
   * `field >= value`, with the same `*At` ms→ISO coercion `equals()` applies.
   *
   * This is what makes an INCREMENTAL read possible: the WhatsApp inbox syncs
   * with `where('profileId').equals(pid).where('updatedAt').aboveOrEqual(mark)`
   * instead of re-downloading the whole corpus for one new message.
   */
  above(value: unknown): this { return this.range('gt', value); }
  aboveOrEqual(value: unknown): this { return this.range('gte', value); }
  private range(op: 'gt' | 'gte', value: unknown): this {
    if (this.pending == null) throw new Error(`${op === 'gt' ? 'above' : 'aboveOrEqual'}() called without where()`);
    let v = value;
    if (isAtField(this.pending) && typeof v === 'number' && Number.isFinite(v)) {
      v = new Date(v).toISOString();
    }
    this.filters.push({ field: this.pending, value: v, op });
    this.pending = null;
    return this;
  }
  orderBy(field: (keyof T & string) | string): this {
    if (typeof field !== 'string' || !field) {
      throw new Error('orderBy() requires a non-empty field name');
    }
    this.orderField = field;
    return this;
  }
  reverse(): this { this.reversed = true; return this; }
  filter(fn: (row: T) => boolean): this {
    if (typeof fn !== 'function') {
      throw new Error('filter() requires a predicate function');
    }
    this.predicate = fn;
    return this;
  }
  limit(n: number): this {
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(`limit() requires a positive integer (got ${n})`);
    }
    this._limit = n;
    return this;
  }
  /**
   * Serve this read from the module-level cache when an identical read landed
   * within `ttlMs`. Position-independent: it only records the TTL and returns
   * `this`, so it can sit anywhere in the chain
   * (`.where().equals().cached(30_000).reverse().sortBy(...)`). The cache key is
   * built at execute time, so the chain may keep mutating after this call.
   */
  cached(ttlMs = 30_000): this { this._ttl = ttlMs; return this; }

  /**
   * Fetch ONLY these fields (camelCase; converted to snake_case for the
   * select list). Rows come back with every other field undefined — use it
   * to keep a table's HEAVY columns server-side on list reads (a Gmail
   * mirror's body_html, a webhook payload jsonb) and fetch the full row only
   * when one item is opened. The projection participates in the `.cached()`
   * key, so a trimmed list and a full read never serve each other.
   */
  columns(fields: ReadonlyArray<keyof T & string>): this {
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => typeof f !== 'string' || !f)) {
      throw new Error('columns() requires a non-empty array of field names');
    }
    this._columns = [...fields];
    return this;
  }

  /**
   * Apply every collected filter step to a PostgREST builder. One place, so the
   * read path, count() and any future terminal share the same semantics.
   *
   * Typed against the narrow `Filterable` shape rather than the builder's own
   * (deeply recursive) generic — inferring through it blows tsc's instantiation
   * depth. The caller casts back to its concrete builder type; the four methods
   * used here all return the same builder at runtime.
   */
  private applyFilters<Q>(query: Q): Q {
    let q = query as Filterable;
    for (const f of this.filters) {
      const col = snake(f.field);
      if (f.values) q = q.in(col, f.values);
      else if (f.op === 'gt') q = q.gt(col, f.value);
      else if (f.op === 'gte') q = q.gte(col, f.value);
      else q = q.eq(col, f.value);
    }
    return q as Q;
  }

  private async _execute(): Promise<T[]> {
    // Catch the "trailing where() without equals()" shape at execution
    // time too. The where() guard above prevents back-to-back
    // where()s, but a single .where('x').toArray() falls through here.
    if (this.pending != null) {
      throw new Error(`Incomplete query: .where('${this.pending}') has no matching .equals()`);
    }
    // The active brand's environment. Applied before the cache key below, so a
    // brand switch can never be served another brand's cached rows.
    if (!this.applyBrandScope()) return [];
    // Read cache: only when a TTL was requested via .cached(). The key covers
    // every input to the raw fetch (filters incl. anyOf sets, orderBy, reverse,
    // limit) — but NOT the JS predicate/sortField, which post-process the same
    // raw rows below and so re-apply over a cached result. count()/get() never
    // reach here, so read-modify-write paths stay 100% fresh.
    const key = this._ttl != null
      ? cacheKey({
          table: this.jsName,
          filters: this.filters,
          orderField: this.orderField,
          reversed: this.reversed,
          limit: this._limit,
          columns: this._columns,
        })
      : null;

    let raw: unknown[] | undefined = key ? getCached(key, this._ttl as number) : undefined;

    if (raw === undefined) {
      const build = () => {
        const select = this._columns ? this._columns.map(snake).join(',') : '*';
        let q = supabase.from(this.t.db).select(select);
        q = this.applyFilters(q);
        if (this.orderField) {
          q = q.order(snake(this.orderField), { ascending: !this.reversed });
        }
        return q;
      };

      if (this._limit) {
        const { data, error } = await build().limit(this._limit);
        if (error) throw error;
        raw = (data as unknown[]) || [];
      } else {
        // No explicit limit → return ALL rows, paging past Supabase's default
        // 1000-row API cap (Settings → API → Max Rows). Without this a large
        // table (the catalog is thousands of SKUs) silently truncates at 1000.
        // Paging needs a stable order; add the primary key when the caller
        // didn't request one so pages don't overlap or skip rows.
        const PAGE = 1000;
        let acc: unknown[] = [];
        for (let from = 0; ; from += PAGE) {
          let q = build();
          // ALWAYS append the PK as the (secondary) sort: a caller-supplied
          // non-unique orderBy leaves ties in no stable order, so page N and
          // N+1 could re-shuffle rows across the boundary — skipping some and
          // duplicating others. The PK tiebreak makes pagination deterministic.
          q = q.order(snake(this.t.pk), { ascending: true });
          const { data, error } = await q.range(from, from + PAGE - 1);
          if (error) throw error;
          const page = (data as unknown[]) || [];
          acc = from === 0 ? page : acc.concat(page);
          if (page.length < PAGE) break;
        }
        raw = acc;
      }
      // Store the PRE-fromRows raw rows. fromRows re-runs on every read below,
      // so a caller mutating a returned row can never corrupt the cache.
      if (key) setCached(key, raw);
    }

    let rows = fromRows<T>(raw);
    if (this.predicate) rows = rows.filter(this.predicate);
    if (this.sortField) {
      const f = this.sortField as keyof T;
      rows.sort((a, b) => {
        const av = a[f] as unknown;
        const bv = b[f] as unknown;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        // Coerce numeric-looking strings (Supabase returns bigint columns as
        // strings under some PostgREST configs) so sortBy('number') sorts
        // numerically — otherwise "10" sorts before "9" lexicographically.
        const na = asNumeric(av);
        const nb = asNumeric(bv);
        if (na != null && nb != null) return na - nb;
        if (typeof av === 'number' && typeof bv === 'number') return av - bv;
        return String(av).localeCompare(String(bv));
      });
      if (this.reversed) rows.reverse();
    }
    return rows;
  }

  async toArray(): Promise<T[]>     { return this._execute(); }
  async sortBy(field: (keyof T & string) | string): Promise<T[]> {
    this.sortField = field;
    return this._execute();
  }
  async first(): Promise<T | null> {
    // Only push the limit down to SQL when there's no JS .filter() predicate.
    // With a predicate, a SQL LIMIT 1 would slice the result set BEFORE the
    // predicate runs — first() could return null while a matching row exists
    // on page 2. Without a predicate the limit is a safe, cheap fast path.
    if (!this.predicate) this._limit = 1;
    const rows = await this._execute();
    return rows[0] || null;
  }
  async count(): Promise<number> {
    if (!this.applyBrandScope()) return 0;
    // Fast path: no JS predicate → let Postgres count with a head request
    // (no rows shipped). This is exact regardless of the 1000-row API cap.
    if (!this.predicate) {
      const q = this.applyFilters(supabase.from(this.t.db).select('*', { count: 'exact', head: true }));
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    }
    // Predicate path: the filter runs in JS, so we must materialize the rows
    // and apply it ourselves. A single select() is capped at Supabase's
    // 1000-row API limit and would undercount on a large table — page past
    // it like _execute does (stable order by PK so pages don't overlap/skip).
    const PAGE = 1000;
    let matched = 0;
    for (let from = 0; ; from += PAGE) {
      let q = this.applyFilters(supabase.from(this.t.db).select('*'));
      q = q.order(snake(this.t.pk), { ascending: true });
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw error;
      const page = (data as unknown[]) || [];
      matched += fromRows<T>(page).filter(this.predicate).length;
      if (page.length < PAGE) break;
    }
    return matched;
  }

  // Thenable, so `await db.X.where(...).equals(...).reverse().sortBy(...)` works.
  then<TResult1 = T[], TResult2 = never>(
    onF?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onR?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this._execute().then(onF, onR);
  }
}

/** Resolve when the browser regains connectivity, or after `maxMs`. When the
 *  device KNOWS it is offline (`navigator.onLine === false`) every timed retry
 *  fails instantly and just burns the ladder — parking until the `online`
 *  event turns those into one useful attempt the moment the link is back.
 *  No-op outside the browser (node scripts) and while the link looks up. */
function whenBackOnline(maxMs: number): Promise<void> {
  if (typeof navigator === 'undefined' || typeof window === 'undefined' || navigator.onLine !== false) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); window.removeEventListener('online', done); resolve(); };
    const timer = setTimeout(done, maxMs);
    window.addEventListener('online', done);
  });
}

/** Options for `Table.bulkPut`. */
export interface BulkPutOptions {
  chunkSize?: number;
  retries?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * `Table<T>` is the Dexie-shaped facade for a single Postgres relation.
 * The `T` generic parameter is the camelCased domain row type, which
 * makes `await db.quotes.toArray()` return `Promise<Quote[]>` and
 * `await db.profiles.get(id)` return `Promise<Profile | null>` without
 * a manual cast at the call site.
 */
export class Table<T> {
  readonly jsName: TableName;
  private t: TableDef;

  constructor(jsName: TableName) {
    this.jsName = jsName;
    this.t = TABLES[jsName];
  }
  where(field: (keyof T & string) | string): Query<T>   { return new Query<T>(this.t, this.jsName).where(field); }
  orderBy(field: (keyof T & string) | string): Query<T> { return new Query<T>(this.t, this.jsName).orderBy(field); }
  toArray(): Promise<T[]>     { return new Query<T>(this.t, this.jsName).toArray(); }
  count(): Promise<number>    { return new Query<T>(this.t, this.jsName).count(); }
  /** Start a chain pre-configured to serve from the read cache within `ttlMs`;
   *  fully chainable afterwards (`db.quotes.cached(30_000).reverse().sortBy(…)`). */
  cached(ttlMs = 30_000): Query<T> { return new Query<T>(this.t, this.jsName).cached(ttlMs); }

  async get(id: string | null | undefined): Promise<T | null> {
    if (id == null) return null;
    const pkCol = snake(this.t.pk);
    const { data, error } = await supabase
      .from(this.t.db).select('*').eq(pkCol, id).limit(1).maybeSingle();
    if (error) throw error;
    return (fromRow<T>(data) as T | null) ?? null;
  }

  async put(record: T): Promise<T[keyof T] | undefined> {
    // Validate the PK is actually present before upserting. Without this a
    // record missing its conflict key upserts a NULL-PK row (or errors deep
    // in PostgREST) and put() returns undefined — a silent no-op the caller
    // mistakes for success. Fail fast with a readable error instead.
    const pkVal = (record as Record<string, unknown> | null | undefined)?.[this.t.pk];
    if (pkVal == null || pkVal === '') {
      throw new Error(`put(${this.t.db}): missing primary key '${this.t.pk}'`);
    }
    // Stamp the ACTIVE BRAND on a row that doesn't name one: a model imported
    // while brand B is open belongs to brand B, whatever the caller remembered
    // to pass. A row that already carries a brand is left alone.
    const stamp = brandStampFor(this.jsName, record as unknown as Record<string, unknown>);
    const row = toRow({ ...(record as unknown as Row), ...(stamp || {}) });
    const { error } = await supabase
      .from(this.t.db).upsert(row, { onConflict: snake(this.t.pk) });
    if (error) throw error;
    invalidate(this.jsName);
    return pkVal as T[keyof T] | undefined;
  }

  /**
   * Batched upsert with retry. Use for bulk imports — one Supabase round-trip
   * per chunk instead of one per row. The catalog import script can land a
   * ~7500-row variant table in ~15 requests this way.
   *
   *   chunkSize  rows per request (500 is the community-validated sweet spot
   *              for PostgREST upserts; the 1000-row default is the SELECT
   *              return cap, not a write cap, but we stay well under it to
   *              keep payload + transaction time bounded)
   *   retries    extra attempts per batch after the initial try (5 → 6 total;
   *              the ~30s ladder is sized to outlast a PHONE connection blip,
   *              not just a server hiccup — see the delay comment below)
   *   onProgress (done, total) called after each successful batch
   */
  async bulkPut(records: T[], { chunkSize = 500, retries = 5, onProgress }: BulkPutOptions = {}): Promise<number> {
    if (!Array.isArray(records)) {
      throw new Error('bulkPut: records must be an array');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error(`bulkPut: chunkSize must be a positive integer (got ${chunkSize})`);
    }
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Error(`bulkPut: retries must be a non-negative integer (got ${retries})`);
    }
    // Same brand stamp as put(), per row (see brandScope.ts).
    const rows = records.map((r) => {
      const stamp = brandStampFor(this.jsName, r as unknown as Record<string, unknown>);
      return toRow({ ...(r as unknown as Row), ...(stamp || {}) });
    });
    if (!rows.length) return 0;
    const conflictKey = snake(this.t.pk);
    let done = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      let lastErr: { message?: string } | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const { error } = await supabase
          .from(this.t.db)
          .upsert(chunk, { onConflict: conflictKey });
        if (!error) { lastErr = null; break; }
        lastErr = error;
        if (attempt < retries) {
          // iOS Safari surfaces a killed/blipped fetch as `TypeError: Load
          // failed` with no HTTP status, and a real-world phone blip lasts
          // 5-30s. The old 600ms·2^n ladder (~4s total) spent every attempt
          // inside a single blip — the 2026-07 price-list import died on its
          // FIRST batch exactly that way. 1s/2s/4s/8s/15s (~30s) rides it out.
          const delay = Math.min(1000 * Math.pow(2, attempt), 15_000) + Math.random() * 400;
          await new Promise((r) => setTimeout(r, delay));
          await whenBackOnline(45_000);
        }
      }
      if (lastErr) {
        throw new Error(
          `bulkPut ${this.t.db}: failed batch ${i}-${i + chunk.length} after ${retries + 1} attempts: ${lastErr.message || lastErr}`
        );
      }
      done += chunk.length;
      onProgress?.(done, rows.length);
    }
    invalidate(this.jsName);
    return done;
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    const pkCol = snake(this.t.pk);
    const { error } = await supabase
      .from(this.t.db).update(toRow(patch as unknown as Row)).eq(pkCol, id);
    if (error) throw error;
    invalidate(this.jsName);
  }

  /**
   * Apply the SAME patch to many rows in ONE request (the update twin of
   * `bulkDelete`). Per-row `update()` costs a round-trip AND an `invalidate()`
   * each — marking a 20-message thread read used to fire 20 writes and 20 full
   * refetches of the inbox. This is one write and one invalidate.
   */
  async bulkUpdate(ids: string[] | null | undefined, patch: Partial<T>): Promise<void> {
    if (!ids?.length) return;
    const pkCol = snake(this.t.pk);
    const { error } = await supabase
      .from(this.t.db).update(toRow(patch as unknown as Row)).in(pkCol, ids);
    if (error) throw error;
    invalidate(this.jsName);
  }

  async delete(id: string): Promise<void> {
    const pkCol = snake(this.t.pk);
    const { error } = await supabase.from(this.t.db).delete().eq(pkCol, id);
    if (error) throw error;
    invalidate(this.jsName);
  }

  async bulkDelete(ids: string[] | null | undefined): Promise<void> {
    if (!ids?.length) return;
    const pkCol = snake(this.t.pk);
    const { error } = await supabase.from(this.t.db).delete().in(pkCol, ids);
    if (error) throw error;
    invalidate(this.jsName);
  }
}

/**
 * The typed `db` object — `{ profiles: Table<Profile>, settings:
 * Table<Settings>, ... }`. Each entry is a `Table<T>` where `T` is
 * the matching domain row type from `TableRowMap`.
 */
export type Db = { [K in TableName]: Table<TableRowMap[K]> };

export const db: Db = Object.fromEntries(
  (Object.keys(TABLES) as TableName[]).map((k) => [k, new Table(k)]),
) as Db;

/**
 * The catalog brand a product helper must read under.
 *
 * `products` is partitioned by its own `brand` column (it always was), so the
 * active brand environment reaches these RPC/raw helpers here rather than
 * through the Query scope. An explicit `brand` argument always wins — the LSG
 * catalog book and any deliberate cross-brand read still work.
 *
 * `blocked` means: a brand IS open and it has no catalog of its own, so the
 * honest answer is nothing. Falling through unfiltered would show the dealer
 * another manufacturer's SKUs and prices.
 */
function catalogScope(brand?: string): { brand?: string; blocked: boolean } {
  if (brand) return { brand, blocked: false };
  const scoped = catalogBrandScope();
  if (scoped) return { brand: scoped, blocked: false };
  return { brand: undefined, blocked: !!getBrandScope() };
}

/** Max query tokens sent to retrieval — mirrors search_catalog_models' six
 *  unrolled slots, so a long paste can neither explode the filter nor silently
 *  lose its tail to a slot that does not exist. */
const SEARCH_MAX_TOKENS = 6;

/** How many MODELS the picker hydrates. A model is up to ~23 SKU rows (one per
 *  fabric grade), so this is the real cost driver — and capping by model is the
 *  whole point: capping by ROW is what used to cut the answer out of the set. */
const SEARCH_MODEL_LIMIT = 120;

/**
 * Catalog search that returns MODELS, best match first — the quick search
 * behind every product picker.
 *
 * WHY THIS EXISTS RATHER THAN `searchProducts`. The picker lists models, but
 * `searchProducts` caps SKU ROWS alphabetically. An upholstered model is ~23
 * rows, so against production "exclusif sofa" matched 1196 rows across 17
 * models and a 500-row cap kept only the 8 alphabetically-first ones —
 * `EXCLUSIF SOFA` itself never reached the client, and no client-side ranking
 * can order a row it was never given.
 *
 * Two hops, each doing the job it is good at:
 *
 *   1. RETRIEVAL — `search_catalog_models` ANDs the folded query tokens across
 *      every searchable field (now including the SECOND DESCRIPTION LINE,
 *      `subtype` + `dimensions`) and returns ONE lightweight row per model, so
 *      the cap counts models. It does no scoring.
 *   2. RANKING — `rankCatalogMatches` (lib/productSearch) orders that index by
 *      real relevance, and only the top `modelLimit` models are hydrated into
 *      full rows. Relevance lives in exactly ONE place, client-side.
 *
 * Rows come back grouped by model IN RANK ORDER, so a caller that pipes them
 * straight into `groupFamilies` gets its models best-first for free (Map keeps
 * insertion order).
 */
export async function searchCatalogModels(
  profileId: string,
  term: string,
  { brand, modelLimit = SEARCH_MODEL_LIMIT }: { brand?: string; modelLimit?: number } = {},
): Promise<Product[]> {
  const { phrase, tokens } = parseSearchQuery(term);
  if (!phrase) return [];
  // The open brand's catalog (see catalogScope) — an explicit `brand` wins.
  const scope = catalogScope(brand);
  if (scope.blocked) return [];

  const { data, error } = await supabase.rpc('search_catalog_models', {
    p_profile_id: profileId,
    p_brand: scope.brand ?? null,
    p_tokens: tokens.slice(0, SEARCH_MAX_TOKENS),
    p_phrase: phrase,
    p_limit: 2000,
  });
  // Deploy window: Vercel can serve this bundle before Supabase has applied the
  // migration that creates the function. Fall back to the old row-capped search
  // rather than showing "sin coincidencias" — the ranking below still applies,
  // it just ranks a smaller candidate set until the migration lands.
  if (error) {
    console.warn('[catalog] search_catalog_models unavailable, falling back:', error.message);
    return searchProducts(profileId, term, 1000, scope.brand);
  }

  type IndexRow = {
    search_root: string;
    name?: string | null;
    subtype?: string | null;
    reference?: string | null;
    dimensions?: string | null;
    family?: string | null;
    category?: string | null;
  };
  const index = (data as IndexRow[] | null) || [];
  if (!index.length) return [];

  const ranked = rankCatalogMatches(
    index,
    term,
    (row) => ({
      name: row.name,
      subtype: row.subtype,
      // The model key, not the member SKU: the grade letter is noise here and
      // the dealer types the root when they type a reference at all.
      reference: row.search_root,
      family: row.family,
      category: row.category,
      dimensions: row.dimensions,
    }),
    (a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }),
  );
  const roots = ranked.slice(0, Math.max(1, modelLimit)).map((r) => r.item.search_root);
  if (!roots.length) return [];

  // Hydrate the winning models whole — every grade row, so prices and the
  // fabric step are complete. Chunked under the 1000-row API cap.
  //
  // Group rows by the SAME key Postgres generated `search_root` with, NOT by
  // lib/catalog `splitSkuGrade`: the column deliberately accepts any trailing
  // letter where the app accepts only real grade letters, so for a SKU like
  // `15420000T` the two disagree and a splitSkuGrade lookup would miss.
  const searchRootOf = (reference: unknown): string => {
    const ref = String(reference ?? '');
    return /^[0-9]{8}[A-Za-z]$/.test(ref) ? ref.slice(0, 8) : ref;
  };
  const rank = new Map(roots.map((root, i) => [root, i]));
  const CHUNK = 40;
  const pages: unknown[][] = [];
  for (let i = 0; i < roots.length; i += CHUNK) {
    const slice = roots.slice(i, i + CHUNK);
    let q = supabase.from('products').select('*').eq('profile_id', profileId).in('search_root', slice);
    if (scope.brand) q = q.eq('brand', scope.brand);
    const { data: rows, error: rowsError } = await q.order('reference');
    if (rowsError) throw rowsError;
    pages.push((rows as unknown[]) || []);
  }

  const products = fromRows<Product>(pages.flat());
  // Model rank first, then a stable order inside the model.
  return products.sort((a, b) => {
    const ra = rank.get(searchRootOf(a.reference)) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(searchRootOf(b.reference)) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || String(a.reference).localeCompare(String(b.reference));
  });
}

/**
 * Server-side catalog search. The product catalog is tens of thousands of SKUs
 * — far past Supabase's default 1000-row API cap — so list pages and the
 * quote-builder picker must NOT load the whole table client-side (that was a
 * multi-second hang + a false "empty" flash). This filters in Postgres: an OR
 * of case-insensitive substring matches across the fields a dealer searches by
 * (reference / name / family), ordered by name and capped at `limit`. An empty
 * term returns the first `limit` rows by name — a bounded browse set. Names are
 * whitespace-normalized at import (priceListCsv.squish) so a single-space query
 * matches a double-spaced source name.
 *
 * `brand` (optional — a products.brand id, lib/constants) narrows to ONE brand
 * catalog; omitted, the search spans every brand (the quote builder quotes
 * them all). Same contract on catalogCategories / productsByCategory.
 */
export async function searchProducts(profileId: string, term: string, limit = 400, brand?: string): Promise<Product[]> {
  const scope = catalogScope(brand);
  if (scope.blocked) return [];
  let q = supabase.from('products').select('*').eq('profile_id', profileId);
  if (scope.brand) q = q.eq('brand', scope.brand);
  const needle = term.trim();
  if (needle) {
    // PostgREST or() is a comma-separated list and ilike treats % as the
    // wildcard; strip the characters that would break that filter grammar, and
    // collapse whitespace runs so a single-spaced query matches regardless of
    // how the term was typed (the catalog data is normalized to single spaces).
    // Strip every character that has meaning in PostgREST's or() grammar or in
    // ilike: `,` and `()` delimit the or() list, `*` is PostgREST's ilike
    // wildcard, `%` is SQL's, `:` introduces a cast/operator hint, and `\` is
    // the escape char (a trailing one would swallow the next token). Removing
    // them keeps a pasted reference like "ABC:123\" or "x*(y)" from breaking
    // the filter. Then collapse whitespace so a single-spaced query matches
    // the single-spaced catalog data regardless of how it was typed.
    const safe = needle.replace(/[%,()*:\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (safe) {
      // Match EVERY whitespace-separated token (AND), each against any of the
      // searchable fields (OR) — so "pukka sofa" finds "PUKKA MEDIUM SOFA": the
      // words needn't be adjacent or in order, which the old single
      // `%pukka sofa%` substring required. `category` is searchable too (the
      // type word often lives only there). Chained `.or()` calls are ANDed by
      // PostgREST; tokens are capped so a long paste can't explode the filter.
      for (const tok of safe.split(' ').slice(0, 6)) {
        q = q.or(`reference.ilike.%${tok}%,name.ilike.%${tok}%,family.ilike.%${tok}%,category.ilike.%${tok}%`);
      }
    }
  }
  const { data, error } = await q.order('name').limit(limit);
  if (error) throw error;
  return fromRows<Product>(data as unknown[] | null | undefined);
}

/** A catalog category bucket — the category label + how many SKUs it holds. */
export interface CatalogCategory {
  category: string;
  count: number;
}

/**
 * The distinct product categories for a profile, each with its SKU count, in
 * ONE round-trip. The catalog browser lists every category up-front (collapsed)
 * and only loads a category's products when it's opened, so it must never pull
 * the whole (tens-of-thousands-row) table just to learn the category names.
 *
 * Fast path: the `catalog_categories` SQL function (a server-side GROUP BY,
 * which PostgREST can't express over its REST grammar). Fallback — used when
 * that function isn't deployed yet or errors — pages the lightweight `category`
 * column and dedupes client-side: slower, but it works under the existing
 * team-read RLS so the page degrades gracefully instead of breaking.
 */
export async function catalogCategories(profileId: string, brand?: string): Promise<CatalogCategory[]> {
  const scope = catalogScope(brand);
  if (scope.blocked) return [];
  // p_brand is passed only when filtering, so the call still matches the old
  // single-arg function signature on a DB the brand migration hasn't reached.
  const { data, error } = await supabase.rpc(
    'catalog_categories',
    scope.brand ? { p_profile_id: profileId, p_brand: scope.brand } : { p_profile_id: profileId },
  );
  if (!error && Array.isArray(data)) {
    return (data as Array<{ category?: string | null; sku_count?: number | string }>).map((r) => ({
      category: (r.category || '').trim(),
      count: Number(r.sku_count) || 0,
    }));
  }
  if (error) console.warn('[catalog] catalog_categories RPC unavailable, falling back:', error.message);
  return catalogCategoriesFallback(profileId, scope.brand);
}

async function catalogCategoriesFallback(profileId: string, brand?: string): Promise<CatalogCategory[]> {
  const PAGE = 1000;
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('products')
      .select('category')
      .eq('profile_id', profileId);
    if (brand) q = q.eq('brand', brand);
    const { data, error } = await q
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as Array<{ category?: string | null }>) || [];
    for (const r of page) {
      const key = (r.category || '').trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (page.length < PAGE) break;
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

/**
 * Every product in one category, ordered by name — the lazy payload behind a
 * catalog category card. Pages past Supabase's 1000-row API cap so a large
 * category (Upholstery) comes back whole; an empty `category` matches the
 * null/blank bucket. The caller groups these into models via `groupFamilies`.
 */
export async function productsByCategory(profileId: string, category: string, brand?: string): Promise<Product[]> {
  const scope = catalogScope(brand);
  if (scope.blocked) return [];
  const PAGE = 1000;
  let out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('products').select('*').eq('profile_id', profileId);
    if (scope.brand) q = q.eq('brand', scope.brand);
    q = category ? q.eq('category', category) : q.or('category.is.null,category.eq.');
    const { data, error } = await q.order('name').order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as unknown[]) || [];
    out = from === 0 ? page : out.concat(page);
    if (page.length < PAGE) break;
  }
  return fromRows<Product>(out);
}

/**
 * Every product of ONE brand catalog, ordered by name — the whole-catalog
 * reads (the LSG catalog PDF export) come through here instead of paging the
 * categories one by one. Pages past the 1000-row API cap like the rest.
 */
export async function productsByBrand(profileId: string, brand: string): Promise<Product[]> {
  const PAGE = 1000;
  let out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products').select('*')
      .eq('profile_id', profileId).eq('brand', brand)
      .order('name').order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as unknown[]) || [];
    out = from === 0 ? page : out.concat(page);
    if (page.length < PAGE) break;
  }
  return fromRows<Product>(out);
}

/** Just the PRICING columns of a brand's catalog (reference/name/price/cost),
 *  paged. Feeds the price-list archive snapshot — the full `select *` (image
 *  arrays, pointer ids) would move megabytes for a 27k-row list; four columns
 *  keep it lean. */
export async function productPricesByBrand(
  profileId: string, brand: string,
): Promise<{ reference: string; name: string; priceUsd: number; cost: number }[]> {
  const PAGE = 1000;
  let out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products').select('reference, name, price_usd, cost')
      .eq('profile_id', profileId).eq('brand', brand)
      .order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as unknown[]) || [];
    out = from === 0 ? page : out.concat(page);
    if (page.length < PAGE) break;
  }
  return fromRows(out);
}

/* ---------------------------------------------------------------------- */
/*  Sequential numbering                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Assign the next sequential `number` for a per-profile collection
 * (quotes, orders, containers). The rule is:
 *
 *     next = max(existing number) + 1, or `start` if no rows exist.
 *
 * The dealer's mental model — and the reason the previous
 * persisted-counter approach was wrong — is that the *current numeric
 * top* is the source of truth, not a counter that only ratchets up:
 *
 *   • Delete the highest-numbered row (the most recent one) and that
 *     number is *reused* by the next create. Counters never gave that
 *     back; they kept advancing past holes.
 *
 *   • Delete a non-highest row (a middle one) and the hole stays. The
 *     next create still goes above the current top. The dealer's words:
 *     "si borro la #3 y voy por la #5, la siguiente no puede tener el
 *     número 3". Chronology beats hole-filling.
 *
 *   • A counter persisted in `settings` was also fragile: the previous
 *     code did `put(quote with number=N)` then `settings.put({counter:
 *     N})` as two separate writes. If the second one failed (network
 *     blip, page close), the next create would re-issue N. Computing
 *     from the table itself removes that desync entirely.
 *
 * Concurrency: with multiple dealers active in the team, the read
 * here can race against another browser's read+write. Migration
 * 20260519160000 added `UNIQUE(profile_id, number)` constraints on
 * the three numbered tables, so a duplicate INSERT now errors with
 * Postgres `23505` (unique_violation) instead of silently double-
 * issuing. Callers that need to be safe under that race should use
 * `assignSequenceNumber()` below, which wraps the read + insert in a
 * retry loop. Direct `nextSequenceNumber` callers continue to work
 * but will see a save error on the (rare) collision.
 *
 *   tableName  one of TABLES keys ('quotes', 'orders', 'containers').
 *   profileId  scopes the query (numbers don't collide across profiles
 *              even though right now there's only the 'team' profile).
 *   start      the value to use when no rows exist yet. Picked so the
 *              first issued number isn't #1 — dealers prefer
 *              #1001/#101 since "Cotización #1" looks rookie. Defaults:
 *              quotes 1001, orders 101, containers 101.
 */
export async function nextSequenceNumber(
  tableName: TableName,
  profileId: string,
  start: number,
): Promise<number> {
  const tbl = TABLES[tableName];
  if (!tbl) throw new Error(`Unknown table ${tableName}`);
  const { data, error } = await supabase
    .from(tbl.db)
    .select('number')
    .eq('profile_id', profileId)
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = data as Array<{ number?: number | string | null }> | null;
  return computeNextSequenceNumber(rows?.[0]?.number ?? null, start);
}

/** Arguments to `assignSequenceNumber`. The `build` lambda receives the
 *  freshly-computed `number` and returns the full row to insert. */
export interface AssignSequenceNumberArgs<T> {
  table: TableName;
  profileId: string;
  start: number;
  build: (number: number) => T;
  maxAttempts?: number;
}

/**
 * Race-safe assign-and-insert: compute the next sequence number,
 * build the record with that number, and insert. Retries on
 * unique-violation (another browser tab won the race) up to
 * `maxAttempts` times before giving up — by that point we're past
 * "concurrent click" and into "something else is wrong".
 *
 * Callers pass a `build(number)` lambda that returns the row to
 * insert; the helper takes care of the read → write loop.
 *
 *   const id = newId();
 *   await assignSequenceNumber({
 *     table: 'quotes',
 *     profileId,
 *     start: 1001,
 *     build: (number) => ({ id, profileId, number, ... }),
 *   });
 */
export async function assignSequenceNumber<T>({
  table, profileId, start, build, maxAttempts = 5,
}: AssignSequenceNumberArgs<T>): Promise<T> {
  // Fail-fast at the boundary so a typo'd table name doesn't burn
  // five round-trips before surfacing.
  const tbl = db[table as TableName] as unknown as Table<T> | undefined;
  if (!tbl) throw new Error(`assignSequenceNumber: unknown table '${table}'`);
  if (typeof profileId !== 'string' || !profileId) {
    throw new Error('assignSequenceNumber: profileId must be a non-empty string');
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new Error(`assignSequenceNumber: start must be a non-negative integer (got ${start})`);
  }
  if (typeof build !== 'function') {
    throw new Error('assignSequenceNumber: build must be a function');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`assignSequenceNumber: maxAttempts must be a positive integer (got ${maxAttempts})`);
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const number = await nextSequenceNumber(table, profileId, start);
    const record = build(number);
    if (!record || typeof record !== 'object') {
      throw new Error('assignSequenceNumber: build() must return a record object');
    }
    try {
      await tbl.put(record);
      return record;
    } catch (err) {
      lastErr = err;
      // Postgres unique_violation. Another browser took our slot; loop
      // back and recompute against the new max. Anything else is a
      // real failure — surface immediately rather than burn the retry
      // budget on an error that won't resolve itself (FK violation,
      // RLS, network).
      if ((err as { code?: string } | null)?.code !== '23505') throw err;
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------------- */
/*  Shared party numbering (customers ⇄ professionals)                     */
/* ---------------------------------------------------------------------- */

/** The two tables that share one number space. A number issued to one is
 *  never reused for the other — the directory is a single dichotomous list. */
const PARTY_TABLES = ['customers', 'professionals'] as const;

/**
 * Pure core of the shared party sequence: the next number is one past the
 * higher of the two directories' current maxima. Nulls (an empty table) drop
 * out; strings coerce (PostgREST can hand bigints back as strings). With both
 * null it starts at `start`.
 *
 *   computeNextPartyNumber(null, null, 1)   === 1
 *   computeNextPartyNumber(95,   40,   1)   === 96   // pros lead
 *   computeNextPartyNumber(40,  '112', 1)   === 113  // customers lead, coerced
 */
export function computeNextPartyNumber(
  customerMax: number | string | null | undefined,
  professionalMax: number | string | null | undefined,
  start = 1,
): number {
  const nums = [customerMax, professionalMax]
    .filter((v) => v != null)
    .map((v) => Number(v));
  if (nums.length === 0) return start;
  return Math.max(...nums) + 1;
}

/**
 * Next number in the shared party sequence for a profile — max(number) across
 * BOTH customers and professionals, plus one. This is what keeps client and
 * professional numbers from ever colliding: they draw from the same pool.
 */
export async function nextPartyNumber(profileId: string, start = 1): Promise<number> {
  const tops = await Promise.all(
    PARTY_TABLES.map(async (t) => {
      const { data, error } = await supabase
        .from(TABLES[t].db)
        .select('number')
        .eq('profile_id', profileId)
        .not('number', 'is', null)
        .order('number', { ascending: false })
        .limit(1);
      if (error) throw error;
      const rows = data as Array<{ number?: number | string | null }> | null;
      return rows?.[0]?.number ?? null;
    }),
  );
  return computeNextPartyNumber(tops[0], tops[1], start);
}

/** Arguments to `assignPartyNumber`. `table` is the destination directory;
 *  `build(number)` returns the full row to insert with the allocated number. */
export interface AssignPartyNumberArgs<T> {
  table: 'customers' | 'professionals';
  profileId: string;
  build: (number: number) => T;
  start?: number;
  maxAttempts?: number;
}

/**
 * Race-safe assign-and-insert against the SHARED party sequence: compute the
 * next number across both directories, build the row, insert into `table`.
 * On a unique-violation (another tab took the slot) it recomputes and retries.
 * Mirrors `assignSequenceNumber` but reads the max across customers AND
 * professionals so the two lists stay one dichotomy.
 */
export async function assignPartyNumber<T>({
  table, profileId, build, start = 1, maxAttempts = 5,
}: AssignPartyNumberArgs<T>): Promise<T> {
  const tbl = db[table as TableName] as unknown as Table<T> | undefined;
  if (!tbl) throw new Error(`assignPartyNumber: unknown table '${table}'`);
  if (typeof profileId !== 'string' || !profileId) {
    throw new Error('assignPartyNumber: profileId must be a non-empty string');
  }
  if (typeof build !== 'function') {
    throw new Error('assignPartyNumber: build must be a function');
  }
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const number = await nextPartyNumber(profileId, start);
    const record = build(number);
    if (!record || typeof record !== 'object') {
      throw new Error('assignPartyNumber: build() must return a record object');
    }
    try {
      await tbl.put(record);
      return record;
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string } | null)?.code !== '23505') throw err;
    }
  }
  throw lastErr;
}

/**
 * Pure-function core of nextSequenceNumber, extracted so the rule can be
 * unit-tested without a Supabase round-trip.
 *
 *   computeNextSequenceNumber(null,   1001) === 1001    // empty table
 *   computeNextSequenceNumber(1003,   1001) === 1004    // top + 1
 *   computeNextSequenceNumber('1003', 1001) === 1004    // coerces strings
 *
 * The string-coerce branch handles Supabase returning bigints as strings
 * for some PostgREST configurations — without `Number()` we'd land on
 * "10031" instead of 1004.
 */
export function computeNextSequenceNumber(
  currentMax: number | string | null | undefined,
  start: number,
): number {
  if (currentMax == null) return start;
  return Number(currentMax) + 1;
}

/* ---------------------------------------------------------------------- */
/*  IDs                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Generate a unique id for a new row.
 *
 * crypto.randomUUID() is the source of truth — 122 bits of entropy
 * gives effectively-zero collision probability even at high write
 * concurrency, which the previous `Date.now() + 6 base36 chars`
 * scheme couldn't guarantee (~26 bits of randomness; two clients
 * writing in the same millisecond could collide, and Supabase would
 * silently overwrite one of the rows on upsert).
 *
 * The fallback covers older browser engines that predate
 * crypto.randomUUID (Safari < 15.4, etc.) and any non-secure-context
 * test environment where the API isn't exposed. It's the legacy
 * scheme — good enough for the rare environments that need it, since
 * the production app runs on a secure context.
 *
 * Existing rows in the DB keep their old-shape ids; both shapes live
 * side-by-side in TEXT primary-key columns without issue.
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------------- */
/*  Images — backed by the `images` Storage bucket + `images` table       */
/* ---------------------------------------------------------------------- */

export async function fileToBlob(file: Blob | File): Promise<Blob> {
  if (file instanceof Blob) return file;
  const buf = await (file as File).arrayBuffer();
  return new Blob([buf], { type: (file as File).type || 'application/octet-stream' });
}

function extensionForType(type: string | null | undefined): string {
  if (!type) return 'bin';
  const m = type.match(/^image\/([a-z0-9]+)/i);
  if (!m) return 'bin';
  return m[1].toLowerCase().replace('jpeg', 'jpg');
}

// Per-call defaults for image upload validation. iPhone photos (HEIC, or
// oversized 48 MP JPEGs) are normalized to web/Shopify-safe JPEG/PNG by
// normalizeImageForUpload BEFORE these gates run — see db/imageNormalize.ts —
// so what actually lands in the bucket is always renderable by Shopify's
// productSet fetch and by non-Apple browsers. The gates below are the
// backstop for what normalization passes through (SVG logos, GIFs, already
// web-safe rasters) and for devices that can't decode an exotic format
// (normalization throws its own dealer-readable error in that case).
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;     // 10 MB
const IMAGE_ALLOWED_MIME = /^image\/(png|jpe?g|webp|gif|svg\+xml|avif|heic|heif)$/i;

/** Arguments to `saveImage`. `kind` is the owning entity ('quoteLine',
 *  'professional', 'settings-logo', ...); `ownerId` is the owning row's
 *  primary key. */
export interface SaveImageArgs {
  kind: string;
  ownerId?: string | null;
  file: Blob | File;
  label?: string;
}

/**
 * Upload a file to the images bucket and write the corresponding
 * `images` table row. Returns the new image id.
 *
 * Throws (rejects) at the boundary on:
 *   • zero-byte file (the dealer dragged a corrupted preview)
 *   • non-image MIME type (someone dropped a PDF / docx into ImageDrop)
 *   • file larger than IMAGE_MAX_BYTES (a stray raw photo)
 *
 * The thrown Error message is surfaced inline by ImageDrop — keep it
 * short and dealer-readable rather than the underlying Supabase
 * error.
 */
export async function saveImage({ kind, ownerId, file, label = '' }: SaveImageArgs): Promise<string> {
  if (!file) throw new Error('No se recibió ningún archivo.');
  const raw = await fileToBlob(file);

  if (!raw.size || raw.size <= 0) {
    throw new Error('El archivo está vacío.');
  }
  // iPhone HEIC → JPEG, oversized camera output → ≤2048px. Runs BEFORE the
  // size/MIME gates so a 12 MB 48-megapixel shot normalizes into range
  // instead of bouncing.
  const blob = await normalizeImageForUpload(raw);
  if (blob.size > IMAGE_MAX_BYTES) {
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    throw new Error(`Imagen demasiado grande (${mb} MB). Máximo ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
  }
  const mime = blob.type || '';
  if (!IMAGE_ALLOWED_MIME.test(mime)) {
    throw new Error(`Formato no soportado: ${mime || 'desconocido'}. Usa PNG, JPG, WEBP, GIF, SVG, AVIF o HEIC.`);
  }

  const id = newId();
  const ext = extensionForType(blob.type);
  const storagePath = `${id}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(IMAGES_BUCKET)
    .upload(storagePath, blob, {
      contentType: blob.type || 'application/octet-stream',
      cacheControl: '31536000',
      upsert: false,
    });
  if (upErr) throw upErr;
  await db.images.put({
    id,
    kind,
    ownerId,
    label,
    contentType: blob.type || 'application/octet-stream',
    size: blob.size,
    storagePath,
  });
  return id;
}

export async function deleteImage(id: string | null | undefined): Promise<void> {
  if (!id) return;
  // Shared catalog pointers (LSG photos) are owned by the sync and referenced
  // from many products/lines — never delete one on behalf of a single owner.
  if (isSharedCatalogImage(id)) return;
  const rec = await db.images.get(id);
  if (rec?.storagePath) {
    await supabase.storage.from(IMAGES_BUCKET).remove([rec.storagePath]).catch(() => {});
  }
  await db.images.delete(id);
}

/** deleteImage, UNLESS a quote line still references the row. The Inventario
 *  picker seeds a piece's photo id straight onto the quote line (a SHARED
 *  row — quote flows never delete image rows), so replacing/retaking the
 *  piece's photo must not blank the picture on an already-sent quote. When a
 *  reference exists the row is simply left behind — an orphan is the cheap,
 *  correct outcome; deletion proceeds normally when nothing references it. */
export async function deleteImageUnlessQuoteLinked(id: string | null | undefined): Promise<void> {
  if (!id) return;
  const refs = await db.quoteLines.where('imageId').equals(id).toArray().catch(() => null);
  // A failed check reads as "referenced" — never delete on uncertainty.
  if (!refs || refs.length > 0) return;
  await deleteImage(id);
}

/** Fetch raw image bytes — used by the PDF generator to embed images. */
export async function downloadImageBytes(
  id: string | null | undefined,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!id) return null;
  const rec = await db.images.get(id);
  // CDN pointer row (LSG / LR / Kvadrat catalog photo): the bytes live on the
  // brand's CDN, never in our bucket — fetch them from there, width-capped for
  // print and routed through our CORS proxy when that CDN sends no
  // `Access-Control-Allow-Origin` (`imageBytesUrl`). Without that routing the
  // browser blocks the read and the photo exports as an empty tile even though
  // the on-screen <img> shows it.
  if (rec?.externalUrl) {
    const r = await fetch(imageBytesUrl(rec.externalUrl, DOWNLOAD_IMG_WIDTH)).catch(() => null);
    if (!r?.ok) return null;
    const buf = await r.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType: r.headers.get('content-type') || '' };
  }
  if (!rec?.storagePath) return null;
  const { data, error } = await supabase.storage.from(IMAGES_BUCKET).download(rec.storagePath);
  if (error || !data) return null;
  const buf = await data.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType: rec.contentType || data.type };
}

/* ---------------------------------------------------------------------- */
/*  Profiles + Settings                                                    */
/* ---------------------------------------------------------------------- */

// Single-tenant: every authenticated team member operates on the shared
// 'team' profile. Customers and quotes are scoped to this single profile
// id so all team members see the same data.
export const TEAM_PROFILE_ID = 'team';

/**
 * Delete duplicate profile rows that share an email (case-insensitive).
 *
 * Two profile rows with the same email is always a bug — Supabase Auth
 * enforces uniqueness on `auth.users.email`, so any duplicate in
 * `public.profiles` means at least one row is an orphan (its auth.users
 * counterpart is gone) or a leftover from a previous failed delete.
 *
 * The dealer keeps hitting this state in production because (a) the
 * unique-email index that would block it lives in migration
 * 20260518150000, which hasn't propagated yet, and (b) the older
 * `delete-user` Edge Function was failing on its post-delete UPDATE
 * (the missing `updated_at` column), leaving auth gone but profile
 * alive — so the next invite would create a second profile for the
 * same email.
 *
 * We pick a "winner" per email group:
 *   1. active=true beats active=false
 *   2. then most recent (lastSignInAt > updatedAt > createdAt)
 * and DELETE every other row. The deletes hit `public.profiles` over
 * the Supabase REST API under the caller's RLS — no edge function,
 * no service-role key, no local-only state. The Users page's live
 * query refetches because `bulkDelete` calls `invalidate()`, so the
 * list reflects Postgres truth on the next render.
 *
 * Returns the list of deleted ids so callers can log/notify.
 * Idempotent: a second call on a clean dataset deletes nothing.
 */
export async function dedupeProfilesByEmail(): Promise<string[]> {
  const all = await db.profiles.toArray();
  const byEmail = new Map<string, Profile[]>();
  for (const p of all) {
    if (!p.email || p.id === TEAM_PROFILE_ID) continue;
    const key = String(p.email).toLowerCase().trim();
    if (!key) continue;
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(p);
  }
  const toDelete: string[] = [];
  for (const rows of byEmail.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => {
      // Active wins over inactive.
      if (!!a.active !== !!b.active) return a.active ? -1 : 1;
      // Then most recent signal wins. `lastSignInAt` is the strongest
      // proof of life; fall back through updatedAt and createdAt so a
      // freshly-invited row (lastSignInAt null) still has a comparable
      // timestamp.
      // Nullish chaining (not ||) so a legitimate epoch-0 timestamp isn't
      // skipped as if it were absent — only null/undefined fall through.
      const ta = a.lastSignInAt ?? a.updatedAt ?? a.createdAt ?? 0;
      const tb = b.lastSignInAt ?? b.updatedAt ?? b.createdAt ?? 0;
      return tb - ta;
    });
    for (let i = 1; i < rows.length; i++) {
      toDelete.push(rows[i].id);
    }
  }
  if (toDelete.length) {
    await db.profiles.bulkDelete(toDelete);
  }
  return toDelete;
}

export async function ensureDefaultProfile(): Promise<string> {
  // Make sure the team profile + settings row exist (the SQL schema bootstraps
  // these, but we tolerate empty databases too). The 'team' row is special:
  // it holds shared company settings, not a real user, so its `role` is
  // 'team' rather than 'admin' / 'employee'.
  await db.profiles.put({ id: TEAM_PROFILE_ID, name: 'Team', role: 'team', active: true }).catch(() => {});
  const cur = await db.settings.get(TEAM_PROFILE_ID);
  if (!cur) await db.settings.put({ profileId: TEAM_PROFILE_ID, adminEmails: [] }).catch(() => {});

  // Bootstrap-admin promotion. The team settings row carries an
  // `adminEmails` list (lowercase email strings). On first sign-in,
  // any user whose email matches gets role='admin' + active=true; the
  // very first auth event for `javier@alcover.do` self-bootstraps the
  // org. Every other new user lands inactive and waits for an admin to
  // approve them via the Users page.
  const { data } = await supabase.auth.getUser();
  const u = data?.user;
  if (u) {
    const settings = await db.settings.get(TEAM_PROFILE_ID).catch(() => null);
    const adminEmails = Array.isArray(settings?.adminEmails) ? settings!.adminEmails! : [];
    const email = (u.email || '').toLowerCase().trim();
    const isAllowlistedAdmin = !!email && adminEmails.map((e) => String(e).toLowerCase().trim()).includes(email);
    // "Sign in with Google" users authenticate passwordless every time, so they
    // never go through the SetPassword gate — the google-api login flow stamps
    // user_metadata.google_login when it provisions/authenticates them.
    const meta = (u.user_metadata || {}) as { name?: string; google_login?: boolean };
    const isGoogleLogin = !!meta.google_login;

    const existing = await db.profiles.get(u.id).catch(() => null);
    const now = Date.now();
    if (!existing) {
      // First time we've seen this user. Create their profile row.
      // Allowlisted admins land already-activated; everyone else
      // starts pending. `lastSignInAt` is stamped now because this
      // codepath only runs when a real auth session exists — i.e.
      // the user is signing in right now.
      await db.profiles.put({
        id: u.id,
        name: (u.user_metadata && (u.user_metadata as { name?: string }).name) || (u.email?.split('@')[0]) || 'Member',
        email: u.email || null,
        role: isAllowlistedAdmin ? 'admin' : 'employee',
        active: isAllowlistedAdmin,
        commissionPct: 0,
        lastSignInAt: now,
        // Bootstrap-admin code path: this user typed a password into
        // the Supabase dashboard's Add User screen, so they already
        // have one. Stamping password_set_at on creation skips the
        // SetPassword gate for them. Every other path (the edge
        // function invitation flow) leaves this field null on the
        // initial profile row so the invitee gets routed through the
        // password-setup screen on their first sign-in.
        // Google-login users are passwordless → skip that gate too.
        passwordSetAt: isAllowlistedAdmin || isGoogleLogin ? now : null,
      }).catch(() => {});
    } else {
      // Update lastSignInAt on every sign-in. Two extra behaviors
      // depend on what the existing row looks like:
      //
      //   1. Invitation acceptance — if the row was created by the
      //      invite-user edge function (active=false, lastSignInAt=
      //      null), this is the moment the invitee clicks the magic
      //      link for the first time. Flip them to active=true. From
      //      then on they're a working employee.
      //
      //   2. Bootstrap-admin promotion — if the user's email is in
      //      settings.admin_emails but they aren't currently an
      //      active admin, promote them. This keeps the dealer from
      //      ever locking themselves out by allowing the allowlist
      //      to be edited after the first signup.
      //
      // The two patches compose: an invited user whose email is in
      // the admin allowlist arrives as active=true + role=admin in
      // one round-trip.
      const patch: Partial<Profile> = { lastSignInAt: now };
      const isFirstAcceptance = !existing.active && !existing.lastSignInAt;
      if (isFirstAcceptance) {
        patch.active = true;
      }
      if (isAllowlistedAdmin && (!existing.active || existing.role !== 'admin')) {
        patch.role = 'admin';
        patch.active = true;
      }
      // An invited user who signs in with Google instead of setting a password:
      // stamp passwordSetAt so the SetPassword gate doesn't strand them.
      if (isGoogleLogin && !existing.passwordSetAt) {
        patch.passwordSetAt = now;
      }
      // Surface the failure rather than swallow it — the silent
      // `.catch(() => {})` here previously hid the trigger error
      // ('42501 No puedes cambiar tu propio estado activo') that
      // was breaking the invitation acceptance flow. With the
      // first-acceptance carve-out in migration 20260519220000
      // this update should now succeed; a console.warn keeps the
      // boot non-fatal but at least gives a future maintainer a
      // breadcrumb if the trigger changes again.
      try {
        await db.profiles.update(u.id, patch);
      } catch (e) {
        console.warn('[ensureDefaultProfile] profile-activation update failed:', e);
      }
    }

    // Self-heal: if a previous failed-delete cycle left an orphan
    // profile row with the same email as this user, blow it away
    // now so the admin Users page doesn't show two rows for one
    // person on the next render. Runs on every sign-in / app
    // boot — once Postgres has a clean dataset this is a no-op,
    // and the unique-email index from migration 20260518150000
    // makes it structurally impossible afterwards.
    await dedupeProfilesByEmail().catch((e) => {
      console.warn('[profiles] dedupe failed:', e);
    });
  }
  return TEAM_PROFILE_ID;
}

export async function getSettings(profileId: string): Promise<Settings | null> {
  return db.settings.get(profileId);
}

export async function updateSettings(profileId: string, patch: Partial<Settings>): Promise<void> {
  const cur = (await db.settings.get(profileId)) || { profileId } as Settings;
  await db.settings.put({ ...cur, ...patch, profileId });
}
