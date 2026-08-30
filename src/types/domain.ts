/**
 * Central domain types for VETA.
 *
 * WHAT IS NOT HERE ANY MORE. This file carried 144 exported types and 3,708
 * lines — the whole domain of the ERP this product was extracted from: journal
 * entries, payroll runs, fiscal periods, WhatsApp campaigns, Instagram events,
 * DGII filings. VETA has none of those tables and none of that code. 97 of the
 * 144 described nothing that exists here.
 *
 * A type file is a map of the domain, and one that maps a country the product
 * does not operate in is worse than no map: it answers "what does this store?"
 * with somebody else's answer. What remains is reachable from real code —
 * every type here is used outside this file, or used by one that is.
 *
 * Every shape here is the CAMEL-CASED, JS-side projection — what the
 * code actually sees AFTER `db/rowMapping.ts:fromRow` converts a
 * Postgres row. The snake_case column names live in the migrations
 * and never escape `db/database.ts`.
 *
 * `*At` fields are JS millisecond timestamps (numbers), not ISO
 * strings — `fromRow` parses on read, `toRow` re-serialises on write.
 *
 * Optionality reflects what the codebase actually sees: a freshly-
 * created draft may carry nulls / undefineds the DB defaults to,
 * because the round-trip is "client write → server default → next
 * read". When in doubt, prefer `field?: T | null` over `field: T` so
 * downstream code has to consciously handle the missing case.
 */

/* ----------------------------- discriminator enums ----------------------------- */

/**
 * `quote_lines.kind`. Compound articles are NOT a separate kind —
 * they're regular items whose `components` array is non-empty
 * (see `isCompoundLine` in lib/pricing).
 */
export type LineKind = 'item' | 'section';

/**
 * `quotes.status` lifecycle.
 * Pinned by CHECK constraint (migration 20260519200000).
 */
export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'archived';

/**
 * How an assigned professional's cut is settled — chosen per quote.
 * Internal/accounting only; never affects the client PDF (the client
 * always sees the full price). See `lib/commissions.ts`.
 *   • 'commission'     — invoice the client, pay the decorator a commission.
 *   • 'trade_discount' — invoice the decorator at their % off; no commission.
 */
export type DecoratorBilling = 'commission' | 'trade_discount';

/**
 * Floor order ("venta de piso", 15% base commission) vs special order
 * (20%). Sets the assigned professional's base commission rate; chosen via
 * an explicit toggle on the quote, independent of order attachment.
 */
export type OrderType = 'floor' | 'special';

/**
 * A named quote-terms template the dealer keeps in Configuración and applies to
 * a quote with one tap — the NotesAndTermsCard picker writes its `body` into
 * `quote.terms`. `orderType` (optional) tags which preset the picker SUGGESTS
 * for a piso (stock/floor) vs special order, so the match for the quote's
 * current type is highlighted. Stored as a jsonb array on
 * settings.quote_terms_presets (opaque to rowMapping — keys kept verbatim).
 * See lib/quoteTerms (DEFAULT_QUOTE_TERMS_PRESETS + resolveTermsPresetPicker).
 */
export interface QuoteTermsPreset {
  id: string;
  label: string;
  body: string;
  orderType?: OrderType;
}

/**
 * `orders.status` lifecycle — six main stages + cancelled.
 * Pinned by CHECK constraint (migration 20260519200000).
 * Source of truth for labels/timestamps: `lib/orderStages.js`.
 */
export type OrderStatus =
  | 'draft'
  | 'placed'
  | 'confirmed'
  | 'in_transit'
  | 'in_customs'
  | 'received'
  | 'cancelled';

/**
 * `profiles.role`. Determines what UI surfaces the user can see and
 * what RLS lets them do. The 'team' value is reserved for the shared
 * settings row, not a human user.
 */
export type ProfileRole = 'admin' | 'employee' | 'accounting' | 'team';

/**
 * `settings.dop_rate_mode`. Legacy: the app used to let the dealer pick
 * which rate to quote on. The rate is now pulled automatically from
 * Banco Popular and always quoted on venta (see lib/exchangeRate.ts), so
 * nothing reads this field anymore — kept only so old rows still type-check.
 */
export type DopRateMode = 'bsc-buy' | 'bsc-sell' | 'custom';

/** Currency codes the app surfaces. */
export type CurrencyCode = 'USD' | 'DOP';

/** `{ USD: 1, DOP: 60.0, ... }` shape passed to `formatMoney`. */
export type RatesMap = Partial<Record<CurrencyCode, number>> & {
  USD: number;
};

/* --------------------------------- entities --------------------------------- */

export interface Profile {
  id: string;
  name: string;
  email?: string | null;
  role?: ProfileRole;
  active?: boolean;
  /** Seller commission percent on quotes this user creates. 0–50. */
  commissionPct?: number;
  invitedBy?: string | null;
  lastSignInAt?: number | null;
  passwordSetAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Published USD↔DOP rate snapshot (Banco Popular Dominicano), written by
 * the `bpd-rate` Edge Function. `null` means no pull has landed yet.
 */
export interface ExchangeRate {
  buy: number | null;
  sell: number | null;
  updatedAt: number | null;
}

/** A pinned Google Drive folder — a quick-access shortcut on the "Mi Drive"
 *  page. `url` is the Drive web link (derived from the folder id). */
export interface DrivePin {
  id: string;
  name: string;
  url?: string;
}

export interface Settings {
  profileId: string;
  companyName?: string;
  companyAddress?: string;
  companyEmail?: string;
  companyPhone?: string;
  logoImageId?: string | null;
  /**
   * Logo of the exchange-rate source bank (Banco Popular Dominicano), shown
   * next to the converted DOP rate on the client link and the PDF. Uploaded
   * once in Settings (an SVG/PNG); null ⇒ no logo shown. Same image infra as
   * `logoImageId`.
   */
  rateLogoImageId?: string | null;
  defaultCurrency?: CurrencyCode;
  /**
   * Legacy. The rate's single source of truth is now `exchangeRate` (read
   * via effectiveDopRate); this column is no longer written or read for
   * pricing. Kept so older rows still type-check.
   */
  currencyRates?: RatesMap;
  /** Single source of truth for the USD↔DOP rate (Banco Popular venta). */
  exchangeRate?: ExchangeRate;
  /** Banco Popular EUR↔DOP (bpd-rate persists it beside the USD rate) — the
   *  official number for EUR Ligne Roset invoices. Read via effectiveEurRate. */
  eurRate?: ExchangeRate | null;
  /**
   * Legacy aliases of `exchangeRate` (bsc = Banco Santa Cruz, bpd = Banco
   * Popular Dominicano). Read-only fallbacks for rows not yet migrated.
   */
  bsc?: ExchangeRate;
  bpd?: ExchangeRate;
  dopRateMode?: DopRateMode | string;
  defaultMarginPct?: number;
  defaultDiscountPct?: number;
  /** Default monthly interest rate (%) prefilled on a new payment plan; the
   *  dealer can override it per plan. See `lib/paymentPlan` + PaymentPlanCard. */
  paymentPlanMonthlyRatePct?: number;
  quoteTerms?: string;
  /** Named terms templates the dealer applies to a quote with one tap (the
   *  NotesAndTermsCard picker writes the chosen body into `quote.terms`).
   *  Seeded with a piso (stock) + special preset; the orderType tag drives the
   *  picker's "Sugerido" highlight. See lib/quoteTerms. */
  quoteTermsPresets?: QuoteTermsPreset[];
  quoteFooter?: string;
  /** Lower-cased email allow-list for bootstrap-admin promotion. */
  adminEmails?: string[];
  /** Minimum USD value before an order's first container can dispatch. */
  dispatchThreshold?: number;
  /**
   * Accounting tax parameters + posting-account overrides (the role→code map).
   * Defaults live in `lib/accounting/config`; this holds only what the
   * accountant changed. See `resolveAccountingConfig`.
   */
  accountingConfig?: AccountingConfig;
  /** The collections/dunning cadence (lib/accounting/dunning). */
  dunningPolicy?: DunningPolicy;
  /**
   * The "house account" customer whose quotes stock the public storefront
   * (`/#/tienda`). Alcover quotes itself for store inventory; those quotes'
   * line items become the store's products. Chosen once in Settings; null ⇒ the
   * storefront is unconfigured and shows nothing. FK → customers (set null on
   * delete). See `supabase/functions/store` + `core/store`.
   *
   * This is ALSO the COMPANY account: the dealer's own account (Alcover quoting
   * itself for store stock). It's hidden from the Clientes directory and its
   * quotes are priced at dealer cost via `companyDiscountPct` — see
   * `lib/pricing:companyDiscountPctFor`.
   */
  storeCustomerId?: string | null;
  /**
   * Permanent cost discount (0–100%) taken OFF every product price on a
   * COMPANY-account quote (a quote whose customer is `storeCustomerId`) across
   * the dealer's surfaces — the client-preview/PDF order document, the totals
   * dock, the quotes/orders lists and the order detail — so the figures read as
   * dealer cost, not list. Default 60. Never touches the public storefront
   * (retail), regular customer quotes, or accounting/commission math.
   */
  companyDiscountPct?: number;
  /**
   * Storewide promotion on OWN inventory (the Escaparate pieces): percent OFF
   * (null/0 = no promo; clamped 1–90 by `lib/storePromo`) applied at
   * display/sync time — permanent selling prices are never rewritten. Reflected
   * on the Tienda's stock cards (strikethrough), the Shopify mirror
   * (price + compareAtPrice) and Inventario-picker quote seeds (a visible
   * lineDiscountPct). Set from the Inventario board's "Promoción" control.
   */
  storePromoPct?: number | null;
  /** Public promo label ("Día del Padre") — the Tienda's banner line. */
  storePromoLabel?: string | null;
  /**
   * Bumped on every promo change — the Shopify mirror's extra dirtiness stamp:
   * listings whose last sync predates it re-push on the next reconcile even
   * though the item rows themselves didn't change (a promo flip touches no
   * item row).
   */
  storePromoUpdatedAt?: number | null;
  /** Shopify connections — domain + last connection time per store (the Admin
   *  tokens live in the write-only shopify_config table, never here).
   *  shopify* = the alcover.do inventory-mirror store; shopifyLsg* = the
   *  lifestylegarden.do brand-catalog store. */
  shopifyDomain?: string;
  shopifyConnectedAt?: number | null;
  shopifyLsgDomain?: string;
  shopifyLsgConnectedAt?: number | null;
  /** Issuer (emisor) RNC for e-CF / 607. */
  companyRnc?: string;
  /** Non-sensitive e-CF cert status (the .p12 itself lives in ecf_credentials). */
  ecfCertUploadedAt?: number | null;
  /** 'dev' (TesteCF) | 'cert' (CerteCF) | 'prod' (eCF). */
  ecfEnvironment?: string;
  /** Recipient for the monthly Ligne Roset sales report (the supplier's email).
   *  Prefills the "send to Ligne Roset" draft; null ⇒ draft opens with no To. */
  lrReportEmail?: string | null;
  /** WhatsApp Business (Cloud API) — non-sensitive connection status. The
   *  access token / app secret live in the write-only whatsapp_config table,
   *  never here. */
  whatsappConnectedAt?: number | null;
  /** The warehouse crew's WhatsApp group (a wa_groups id). When set, the quote
   *  editor offers "Enviar al almacén" — the picking-list PDF ships straight
   *  to this group from the business number. */
  whatsappWarehouseGroupId?: string | null;
  /** Claude API (Anthropic) — non-sensitive connection status for the JARVIS
   *  uplink. The API key lives in the write-only claude_config table, never
   *  here. Written by the save_claude_config RPC. */
  claudeConnectedAt?: number | null;
  /** Model the claude-chat function answers with (display mirror). */
  claudeModel?: string;
  /** Meta social (Facebook Page + Instagram + Ads) — non-sensitive connection
   *  status for the JARVIS social pulse. Tokens live in the write-only
   *  meta_social_config table, never here. Written by the meta-social
   *  Edge Function's link mode. */
  metaSocialConnectedAt?: number | null;
  /** Display mirrors of what the connection discovered. */
  metaSocialPageName?: string;
  metaSocialIgUsername?: string;
  /** Instagram app id (client_id) — NON-secret mirror so the Settings card can
   *  show the connection is configured and pre-fill the field. The app SECRET
   *  stays write-only in meta_social_config, never here. */
  metaSocialIgAppId?: string;
  /** Conversions API kill switch. ON by default: it reports the dealer's real
   *  outcomes (leads, proposals opened, quotes accepted) so the ad accounts can
   *  optimize for them. Off ⇒ nothing is queued and nothing is retried. */
  metaCapiEnabled?: boolean;
  /** NON-secret mirror of the connected pixel (meta_social_config.pixel_id). */
  metaPixelId?: string;
  /** ms epoch of the last conversion Meta accepted. */
  metaCapiLastAt?: number | null;
  /** Google (Gmail + Drive) connection — ONE OAuth account powers both. The
   *  OAuth client secret + refresh token stay write-only in google_oauth_config;
   *  only these non-sensitive mirrors live here. Set by the google-api Edge
   *  Function's OAuth callback. */
  googleConnectedAt?: number | null;
  /** The connected account's email (display). */
  googleEmail?: string;
  /** Last time the Gmail inbox pulled new mail (google-api `gmailSync`). */
  gmailSyncedAt?: number | null;
  /** Rich-HTML signatures seeded into the Gmail inbox reply composer — the
   *  dealer picks Spanish or English per reply. `gmailSignature` is the
   *  Spanish/default; `gmailSignatureEn` is the English variant. */
  gmailSignature?: string;
  gmailSignatureEn?: string;
  /** OAuth client id — NON-secret mirror so the card shows it's configured and
   *  pre-fills the field. The client SECRET stays in google_oauth_config. */
  googleClientId?: string;
  /** The Drive "RosetSoft" workspace folder id we file per-importation
   *  subfolders under (created on first use). */
  googleDriveRootFolderId?: string;
  /** Team-pinned Drive folders for quick access on the "Mi Drive" page. */
  googleDrivePins?: DrivePin[];
  /** "Sign in with Google" allow-list: only emails on this domain (e.g.
   *  "alcover.do") may use the Login page's Google button. Empty ⇒ the
   *  google-api function falls back to the connected account's domain. */
  googleLoginDomain?: string;
  /** Webhook handshake string shown in Settings to paste into the Meta portal
   *  (not a secret — it only gates webhook REGISTRATION; payloads are
   *  authenticated by the app-secret HMAC signature). */
  whatsappVerifyToken?: string;
  /** The connected number as Meta displays it (e.g. "+1 809-555-0100"). */
  whatsappDisplayNumber?: string;
  whatsappVerifiedName?: string;
  /** Number health mirrors (the rating lives at Meta): quality GREEN/YELLOW/RED
   *  and the current messaging-limit tier (e.g. "TIER_1K"). Set by the
   *  connection test, refreshed by the phone_number_quality_update webhook. */
  whatsappQualityRating?: string;
  whatsappMessagingLimit?: string;
  /** Meta access-token expiry (ms). null/absent ⇒ permanent (never expires) —
   *  the recommended System User token. Written by the connection test from
   *  debug_token; the connection card warns when it's within days of expiring. */
  whatsappTokenExpiresAt?: number | null;
  /** Approved Meta template used to send a quote link to a client who hasn't
   *  written in the last 24h. Empty ⇒ quote sends go as free-form text (only
   *  works inside the 24h window). Picked (not typed) in Settings, which also
   *  stores the metadata sendQuoteLink needs to build the send: */
  whatsappQuoteTemplate?: string;
  /** …its language code (e.g. 'es'), */
  whatsappQuoteTemplateLang?: string;
  /** …its body-variable count ({{n}}), */
  whatsappQuoteTemplateVars?: number | null;
  /** …and whether the link rides a URL BUTTON's {{1}} suffix instead of a
   *  body variable. */
  whatsappQuoteTemplateButton?: boolean | null;
  /** …plus the template's header format ('' | 'IMAGE'). An IMAGE header makes
   *  sendQuoteLink attach the «Su propuesta de diseño» card (the public
   *  og-card jpeg) as the message's picture on every send. */
  whatsappQuoteTemplateHeader?: string;
  /** Mensaje-personalizado template slot (same picker pattern; legacy
   *  "collection" column name): the approved envelope the send_client_message
   *  agent action rides — {{1}} treatment+name, {{2}} the per-client text.
   *  Empty ⇒ the action fails asking for configuration — automatic sends
   *  never fall back to free-form. */
  whatsappCollectionTemplate?: string;
  whatsappCollectionTemplateLang?: string;
  whatsappCollectionTemplateVars?: number | null;
  /** The configurator auto-quote kill switch (ships OFF): on, a new priced
   *  web request is quoted AND sent by togo-quote-worker end-to-end; off,
   *  each becomes a send_togo_quote proposal awaiting one-tap approval. */
  togoAutoQuote?: boolean;
  /** PORTADAS — the dealer's chosen cover per configurator collection,
   *  `{ [collection]: { modelId?, code? } }` (written by the Modelos screen's
   *  CoverPicker, planned by `planHeroPin`). Either half may be absent and
   *  keeps deriving; every pin is re-validated against the live public catalogue
   *  in `resolveCollectionMenu`, so a deactivated piece or a discontinued cloth
   *  falls back instead of breaking the index. */
  togoHeroes?: Record<string, { modelId?: string; code?: string }> | null;
  /** The cobranza agent kill switch (ships OFF): on, agent-collections watches
   *  CxC daily and files warm per-client cobranza messages as
   *  send_client_message proposals for one-tap approval — it never sends. */
  cobranzaAgent?: boolean;
  /** Lifecycle template slots (same picker pattern): the approved UTILITY
   *  templates the order-stage notices ride so they deliver outside the 24h
   *  window. "ship" fires on the zarpó stage advance, "delivery" on the
   *  entregada milestone. Each stores name + language + body-var count + the
   *  URL button's BASE (send side computes the {{1}} suffix from the share
   *  link) + the registered body text (for the exact-preview UI). */
  whatsappShipTemplate?: string;
  whatsappShipTemplateLang?: string;
  whatsappShipTemplateVars?: number | null;
  whatsappShipTemplateButtonBase?: string;
  whatsappShipTemplateBody?: string;
  whatsappDeliveryTemplate?: string;
  whatsappDeliveryTemplateLang?: string;
  whatsappDeliveryTemplateVars?: number | null;
  whatsappDeliveryTemplateButtonBase?: string;
  whatsappDeliveryTemplateBody?: string;
  /** Embedded Signup (coexistence) launch ids — NON-secret: the Meta App ID
   *  and the Facebook Login for Business Configuration ID the browser needs
   *  to open Meta's hosted onboarding dialog (QR scan from the phone app). */
  whatsappAppId?: string;
  whatsappConfigId?: string;
  /** Manual Commerce-catalog id override for the chat's product picker.
   *  Empty ⇒ wa-send auto-discovers the catalog from the token. */
  whatsappCatalogId?: string;
  /** Quick replies (canned responses) the chat composer inserts with one tap.
   *  The text may carry {{nombre}} / {{negocio}} placeholders, filled at insert
   *  time (core/crm fillQuickReply). */
  whatsappQuickReplies?: { id: string; label: string; text: string }[];
  /** Latest status/quality per message template (keyed by template name),
   *  written by wa-webhook from Meta's template webhooks. A template Meta
   *  approved can later be PAUSED/DISABLED — surfaced so quote sends don't
   *  fail silently. `at` is JS ms (opaque to rowMapping inside the JSON). */
  whatsappTemplateStatus?: Record<string, { status?: string; quality?: string; reason?: string; at?: number }>;
}

/**
 * Saved accounting configuration (overrides only — `resolveAccountingConfig`
 * fills the gaps from code defaults). `postingMap` maps a well-known posting
 * role (`salesLocal`, `itbisPayable`, `accountsPayable`…) to a chart account
 * code; the rates are percentages.
 */
export interface AccountingConfig {
  itbisRate?: number;
  dutyRate?: number;
  retentionIsrServicesRate?: number;
  retentionItbisRate?: number;
  postingMap?: Record<string, string>;
  /** Per-fiscal-year DGII inflation multiplier for the Anexo D pooled bases
   *  (Reglamento 139-98 Art. 27) — accountant-entered from the annual DDG-AR1
   *  resolution, never guessed. Key = 'YYYY'. */
  anexoDMultipliers?: Record<string, number>;
}

/** How an expense was/will be settled. */
export type PaymentMethod = 'cash' | 'bank' | 'card' | 'credit';

/** ISO-4217 currencies the dealer transacts in (functional currency = DOP). */
export type Currency = 'DOP' | 'USD';

/** One step of the dunning cadence: a reminder on `offsetDays` relative to the
 *  invoice due date (negative = before, positive = after), with its template. */
export interface DunningStep {
  offsetDays: number;
  template?: string;
}

/** The dunning cadence/policy (stored as JSON on settings). */
export interface DunningPolicy {
  enabled?: boolean;
  channel?: 'whatsapp' | 'email';
  /** Net term in days: due date = invoice date + netDays. */
  netDays?: number;
  steps?: DunningStep[];
}

/** Goods capitalize to inventory; asset/service hit a chart account directly. */
export type PurchaseKind = 'goods' | 'asset' | 'service';

/**
 * One article line of a goods purchase invoice — the item received + qty + the
 * total DOP cost (ex-ITBIS) for the line. `cost / qty` is the kardex IN unit
 * cost. A line with no `itemId` but a `name` is created in inventory on save
 * (matched/deduped by sku + name, like the expediente).
 */
export interface PurchaseLine {
  id: string;
  itemId?: string | null;
  name: string;
  reference?: string;
  qty: number;
  /** Total DOP cost for this line, net of ITBIS (the value that capitalizes). */
  cost: number;
}

/**
 * A purchase (Compra). Posts a balanced asiento (source='purchase'); a goods
 * purchase also creates an inventory IN movement per line. Amounts are DOP.
 */
export interface Purchase {
  id: string;
  profileId: string;
  number?: number | null;
  supplierId?: string | null;
  purchaseAt: number;
  /** Receipt comprobante — an uploaded file (photo/PDF) in the `documents`
   *  bucket or an external link — plus a review/approval flag. */
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
  approvalStatus?: string;
  approvedBy?: string | null;
  approvedAt?: number | null;
  ncf?: string;
  ncfType?: string;
  kind: PurchaseKind;
  /** For asset/service kind: the account debited. Goods use the inventory account. */
  accountCode?: string | null;
  /** DGII 606 casilla 3 (Tipo de Bienes y Servicios Comprados) — accountant's
   *  explicit choice; falls back to the derived code (tipo606For) when unset. */
  tipo606?: string | null;
  /** Free-text memo (shown on the asiento + the merged Compras y gastos list). */
  description?: string;
  /** Legacy single-item goods receipt (itemId + qty). Superseded by `lines`. */
  itemId?: string | null;
  qty: number;
  /** Goods invoice article lines — the kardex IN is one movement per line.
   *  `base` is their summed cost. Empty for asset/service purchases. */
  lines?: PurchaseLine[];
  /** Optional link to the import expediente this local invoice belongs to. */
  expedienteId?: string | null;
  /**
   * Currency the SUPPLIER invoiced in ('DOP' | 'USD' | 'EUR'); defaults to DOP.
   * The books stay in pesos: `base`/`itbis`/`retention*` are ALWAYS DOP. For a
   * foreign document (a Ligne Roset factura in euros) `fxAmount` holds the
   * original importe in `currency` and `fxRate` the fx→DOP rate it was booked at
   * (base = fxAmount × fxRate), so the original figures survive and the pago can
   * book its diferencia cambiaria.
   */
  currency?: string;
  fxAmount?: number | null;
  fxRate?: number | null;
  base: number;
  itbis: number;
  itbisCreditable?: boolean;
  retentionIsr: number;
  retentionItbis: number;
  paymentMethod: PaymentMethod;
  paidAt?: number | null;
  journalEntryId?: string | null;
  /** ANULADO stamp — a posted gasto/compra is never deleted; anular posts the
   *  contra-asiento (dated today) and sets this pair. Fiscal reports keep the
   *  doc as-filed unless it was voided within its own month (the as-filed
   *  rule); operational surfaces (CxP, KPIs, explorador) drop it always. */
  voidedAt?: number | null;
  voidedReason?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface Customer {
  id: string;
  profileId: string;
  /** Shared party number (see Professional.number) — clients and professionals
   *  draw from ONE sequence, so a number is never reused across the two lists.
   *  Allocated by assignPartyNumber on create; preserved when a contact is
   *  converted between the two directories. */
  number?: number;
  name: string;
  /** Fiscal id (RNC / cédula) for the 607. Optional — consumidor final has none. */
  rnc?: string;
  /** DGII estado (e.g. "ACTIVO") cached on a successful RNC lookup — drives the
   *  permanent verification badge + locks the Empresa field. Empty ⇒ unverified. */
  rncStatus?: string;
  /** Secret token for the public estado-de-cuenta link (account-share). Null until shared. */
  statementToken?: string | null;
  /** Nombre comercial (the razón social goes in `name`). */
  company?: string;
  /** Person dealt with at the company — distinct from the razón social. */
  contactName?: string;
  email?: string;
  phone?: string;
  /** Instagram identity: the IGSID (ig_messages threadKey) + display handle —
   *  binds an IG Direct thread to this customer (the WhatsApp-by-phone
   *  pattern) and unlocks "Enviar por Instagram" in the quote send modal. */
  instagramId?: string | null;
  instagramUsername?: string | null;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  notes?: string;
  // ── CRM enrichment (relationship spine) ──────────────────────────────────
  /** Free-form segmentation tags ("VIP", "showroom", "trade"…). */
  tags?: string[];
  /** Where this contact came from ("instagram-ad", "storefront", "referral"…). */
  leadSource?: string | null;
  /** Relationship stage: 'lead' | 'active' | 'dormant' | 'churned' | null. */
  lifecycleStage?: string | null;
  /** profiles.id of the team member who owns this relationship (null = unowned). */
  ownerUserId?: string | null;
  /** ms epoch of the last inbound/outbound touch across any channel. */
  lastContactedAt?: number | null;
  /** Suppress the cobranza agent for this client — it proposes no reminders. */
  doNotContact?: boolean;
  /** The Meta ad click that first brought this person in (`fb.1.<ms>.<fbclid>`),
   *  captured at the landing surface and kept FIRST-TOUCH — a later organic
   *  visit never overwrites it. Replayed on the Purchase event so a sale closed
   *  weeks later still credits the campaign that earned it. */
  metaFbc?: string | null;
  /** ms epoch of that first ad click. */
  metaFbcAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface Professional {
  id: string;
  profileId: string;
  number?: number;
  name: string;
  /** Fiscal id (RNC / cédula) — drives the DGII company-name auto-fill. */
  rnc?: string;
  /** DGII estado cached on a successful lookup — permanent badge + Empresa lock. */
  rncStatus?: string;
  company?: string;
  /**
   * Ligne Roset trade-account number issued to this professional (architect /
   * decorator). Printed next to the decorator on the order-registration
   * document so Ligne Roset books each quote's order to the right trade account.
   */
  tradeNumber?: string;
  email?: string;
  phone?: string;
  /** Instagram identity: the IGSID (ig_messages threadKey) + display handle —
   *  binds an IG Direct thread to this professional (same pattern as
   *  customers.instagramId). */
  instagramId?: string | null;
  instagramUsername?: string | null;
  /** Delivery/visit address — kept separate from freeform `notes`. */
  address?: string;
  /** City — mirrors customers.city; drives the Ciudad directory filter. */
  city?: string;
  notes?: string;
  // ── CRM enrichment (relationship spine) — mirrors Customer ────────────────
  tags?: string[];
  leadSource?: string | null;
  lifecycleStage?: string | null;
  ownerUserId?: string | null;
  lastContactedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * One component inside a compound quote line. Each carries its own
 * spec + pricing; the parent line contributes the shared family +
 * photo + composition name.
 */
export interface LineComponent {
  id: string;
  name?: string;
  reference?: string;
  /** Composed `<grade> · <fabric>` string — same shape as line.subtype. */
  subtype?: string;
  dimensions?: string;
  description?: string;
  /**
   * The catalog's "Description 2" (the model's finish/variant, e.g. "STANDARD
   * SEAT") for this sub-piece — the component twin of the line-level
   * `productDescription`. A READ-ONLY secondary identifier shown under the name
   * on every surface (quote pane, client preview, public link, PDF), kept
   * SEPARATE from the editable `description` so the catalog text never pollutes
   * the dealer's own field. Auto-filled when a product is picked into the
   * component; absent on a hand-typed one. Lives inline on the JSONB component
   * shape — no DB column.
   */
  productDescription?: string;
  qty?: number;
  unitPrice?: number;
  /**
   * Price RANGE for a component quoted WITHOUT a chosen material — the mirror
   * of the line-level priceMin/priceMax, one level down. Both set ⇒ the
   * component (and the compound that holds it) shows "min – max"; picking a
   * material clears them and pins `unitPrice`. Lives on the JSONB component
   * shape — no DB column.
   */
  priceMin?: number | null;
  priceMax?: number | null;
  /**
   * When true, the component is shown to the customer as an opt-in
   * add-on but excluded from the compound's subtotal. Mirrors the
   * line-level isOptional flag — see lib/pricing:compoundSubtotal,
   * which skips optional components when summing.
   *
   * Lives on the JSONB component shape (no DB column change needed
   * — components are stored as `quote_lines.components`). Default
   * false on every new component.
   */
  isOptional?: boolean;
  /**
   * The dealer designated this component as a CLIENT-toggleable optional
   * add-on (mirrors the line-level `optionalOffered`). Stable across client
   * picks, so the recipient can fold the sub-piece IN and back OUT on the
   * public share link; `isOptional` is the current include/exclude state.
   * Also lives on the JSONB component shape — no DB column.
   */
  optionalOffered?: boolean;
  /**
   * Component-level ALTERNATIVE (pick-one among sub-pieces) — the mirror of the
   * line-level alternativeGroup / isSelectedAlternative, scoped within one
   * compound. Members share an `alternativeGroup`; exactly one carries
   * `isSelectedAlternative` and is the one that counts toward the compound
   * subtotal (see lib/constants:isPricedComponent). Both live on the JSONB
   * component shape — no DB column. Mutually exclusive with `isOptional`.
   */
  alternativeGroup?: string | null;
  isSelectedAlternative?: boolean;
  /**
   * Fabric swatch image (by `images.id`) chosen via the SwatchPicker
   * for this component. Distinct from the parent line's imageId
   * (the product photo). Lives inline on the JSONB component shape.
   */
  swatchImageId?: string | null;
  /** Alternative-material options with price deltas (see MaterialOptions). */
  materialOptions?: MaterialOptions | null;
  /**
   * Module grouping — the catalog-agnostic link that turns a flat component list
   * into a MODULAR product (see lib/modules). Components sharing a `moduleGroup`
   * are the elements of ONE *component product* ("complete element" in Ligne
   * Roset terms) inside the modular; `moduleName` is that module's display label.
   * Authored by the dealer at assembly time (NOT derived from the catalog — the
   * price list carries no composition), so it works for every model. Both live
   * inline on the JSONB component shape — no DB column. Absent on a plain,
   * ungrouped component (which renders as its own single-element module).
   */
  moduleGroup?: string | null;
  moduleName?: string | null;
  /**
   * Module-level OPTIONAL — set on every element of a module (a component
   * product) to offer the WHOLE module as an opt-in add-on, excluded from the
   * total (the module twin of the line-level isOptional, distinct from a single
   * element's `isOptional`). Components may be optional add-ons but are never
   * alternatives — pick-one lives at the module/line level. Lives inline on the
   * JSONB component shape; no DB column. See lib/constants:isPricedComponent.
   */
  moduleOptional?: boolean;
  /**
   * Module-level ALTERNATIVE (pick-one among component products) — set on every
   * element of a module, the module twin of the line-level alternativeGroup.
   * Modules sharing `moduleAlternativeGroup` are siblings; the one whose members
   * carry `moduleSelected` is the priced choice (see isPricedComponent). Pick-one
   * lives at the module/line level — components themselves never carry it. Inline
   * on the JSONB shape; no DB column.
   */
  moduleAlternativeGroup?: string | null;
  moduleSelected?: boolean;
  /**
   * Top-down PLAN geometry for a piece placed in the Togo configurator
   * (the public embed `src/pages/embed/TogoEmbed.jsx`). Each placed Togo piece is one module of a
   * modular line; its position rides inline on the JSONB component so a configured
   * layout round-trips with the quote — no `layout` column, no migration. Absent
   * on a normally-added component. Centimetres; `rot` ∈ {0, 90, 180, 270}. Built
   * by `core/quote/views/configuratorView.js` (buildTogoComponents).
   */
  plan?: {
    pieceId: string;
    x: number;
    y: number;
    rot: number;
    widthCm: number;
    depthCm: number;
  } | null;
}

/**
 * Material options — present the same line/component in alternative upholstery
 * materials with the PRICE DELTA vs. the chosen base. Deltas are DERIVED at
 * render time from the catalog (a material's grade → the model SKU's price at
 * that grade), never frozen, so they stay correct if list prices change. The
 * line's own subtype/unitPrice stay the base; options are informational and do
 * NOT change the quote total.
 */
export interface MaterialOption {
  /** Grade letter of this option's material — drives its SKU price. */
  grade: string;
  /** Display label, e.g. "SOFT TOUCH" or "MATERIAL · COLOR". */
  label: string;
  /** Color code, for the Ligne Roset swatch fallback, when known. */
  code?: string | null;
  /** Uploaded swatch image (by images.id), when one exists. */
  swatchImageId?: string | null;
}

export interface MaterialOptions {
  /** Grade of the line's current (base) material — the $0 reference. */
  baseGrade: string;
  /** Display label of the base material. */
  baseLabel: string;
  options: MaterialOption[];
}

export interface QuoteLine {
  id: string;
  quoteId: string;
  kind: LineKind;
  sortOrder?: number;
  /**
   * The kardex item this line was inserted from (InventoryPicker). Quoting
   * moves no stock; this link lets invoicing offer the salida prefilled.
   */
  inventoryItemId?: string | null;
  /**
   * Sold FROM STOCK — set by either Inventario tab (Ligne Roset on-hand, which
   * also carries `inventoryItemId`, and LifestyleGarden, which mirrors the LSG
   * Shopify store and has no kardex row). It is what separates an INVENTORY
   * order from a CATALOG one: stock is paid in full (no anticipo) and can never
   * be a pedido especial. See lib/quoteKind.
   */
  fromStock?: boolean | null;

  /* Identity */
  family?: string;
  reference?: string;
  name?: string;
  subtype?: string;
  dimensions?: string;
  /**
   * Dealer-authored description — the editable, PDF-facing "Descripción". Free
   * for the dealer to write (on simple AND compound/modular lines); starts empty
   * on a fresh catalog insert.
   */
  description?: string;
  /**
   * The catalog's "Description 2" (the model's finish/variant, e.g. "STANDARD
   * HEADBOARD"), parsed from the price list. A READ-ONLY secondary identifier
   * shown under the name on every surface — kept SEPARATE from `description` so
   * the catalog text never pollutes the dealer's editable field. Auto-filled on
   * a catalog insert; absent on a compound parent (it has no single product).
   */
  productDescription?: string;
  pageRef?: string;
  imageId?: string | null;
  /**
   * Fabric swatch image (by `images.id`) chosen via the SwatchPicker.
   * Distinct from `imageId`, which is the product photo (the sofa).
   * A line can carry both. Renders in the editor's grade/fabric row
   * and in the client preview + PDF next to the subtype.
   */
  swatchImageId?: string | null;
  /**
   * Additional product photos beyond the cover `imageId` — the dealer can
   * attach several angles / detail shots so the client sees the piece properly
   * on the share link. Ordered; the gallery shown is [imageId, ...extraImageIds].
   * Stored as a jsonb array (db column extra_image_ids); null/absent ⇒ no extras.
   */
  extraImageIds?: string[] | null;
  /** Alternative-material options with price deltas (see MaterialOptions). */
  materialOptions?: MaterialOptions | null;

  /* Pricing — ignored when `components` is non-empty (compound mode). */
  qty?: number;
  unitPrice?: number;
  /** The catalog's pre-sale LIST price (Product.listPriceUsd) snapshotted when
   *  the line was added — set only when the store had a markdown (LSG's −40%).
   *  `unitPrice` stays the SALE price (the base every margin/discount compounds
   *  on), so a dealer's extra 10% nets 0.6 × 0.9 off list — never 40+10=50.
   *  Renderers strike this list and show the combined %-off (lineListUnit). */
  listPriceUsd?: number | null;
  /** Real wholesale cost (USD) snapshotted from the catalog when the line was
   *  added; drives the per-order margin view. Frozen so a later price-list
   *  update never rewrites an accepted order's margin. */
  unitCost?: number;
  /** products.brand snapshotted at catalog insert — drives the per-brand
   *  commission split (blendedCommissionPct): LifestyleGarden lines earn 10%,
   *  Ligne Roset the order-type rate (15 floor / 20 special). null = a
   *  pre-stamping / manual / service line, treated as ligne-roset (house brand). */
  brand?: string | null;
  lineMarginPct?: number;
  lineDiscountPct?: number;
  /** SIN ITBIS — exento. Only a producto personalizado may carry it, and
   *  `lib/pricing:lineTaxExempt` — never this raw field — is what the money
   *  reads. */
  taxExempt?: boolean;
  /**
   * Price RANGE for a line quoted WITHOUT a chosen material — the model's
   * cheapest→priciest fabric grade, snapshotted from the catalog when the line
   * is added (mirrors how `unitPrice` is snapshotted). Both set ⇒ the line
   * shows "min – max" instead of a single total and the quote total widens to a
   * range; picking a material clears them and pins `unitPrice`. Null on a
   * normal line. See lib/pricing:isRangeLine / computeTotalsRange.
   */
  priceMin?: number | null;
  priceMax?: number | null;

  /* Compound article — non-empty array makes this line compound. */
  components?: LineComponent[];
  /**
   * Composition tier of a compound line (see lib/modules). A `'componentProduct'`
   * — Ligne Roset's "complete element" — is one product made of elements (the
   * default, and how every existing compound reads when this is absent). A
   * `'modular'` is made of several component products, so its components are
   * grouped into named modules (`LineComponent.moduleGroup`) and the surfaces
   * render it grouped-by-module under one image. Only meaningful when
   * `components` is non-empty; ignored on a normal line.
   */
  compoundKind?: 'componentProduct' | 'modular';

  /* Product options + alternatives.
   *   isOptional               line currently EXCLUDED from the quote
   *                            total. isPricedLine (lib/constants) keys
   *                            off this; flipping it is what includes /
   *                            excludes the add-on.
   *   optionalOffered          the dealer designated this STANDALONE line
   *                            as an optional add-on the CLIENT may toggle
   *                            in or out on the public share link. Stable
   *                            across client picks, so the recipient can
   *                            turn an optional ON and back OFF (a true
   *                            toggle), unlike `isOptional` which the
   *                            include/exclude flips. A toggled-in optional
   *                            is `optionalOffered=true` + `isOptional=false`.
   *   alternativeGroup         id shared by sibling lines the
   *                            customer picks between; null means
   *                            the line is standalone.
   *   isSelectedAlternative    within a group, exactly one line
   *                            has this true and is the one that
   *                            counts toward the total. The others
   *                            still render so the customer sees
   *                            the menu.
   * Pricing math in lib/constants:isPricedLine respects isOptional +
   * the alternative flags (NOT optionalOffered — that's a UI/affordance
   * marker only); a DB CHECK constraint forbids the meaningless
   * combination (optional + alternative).
   */
  isOptional?: boolean;
  optionalOffered?: boolean;
  alternativeGroup?: string | null;
  isSelectedAlternative?: boolean;

  /**
   * Conjunto ("set") — the TAKE-ALL twin of `alternativeGroup`. Lines
   * sharing the same `setGroup` string are distinct standalone products
   * SOLD TOGETHER (e.g. an armchair + an ottoman). UNLIKE alternatives,
   * EVERY member is priced normally and counts toward the quote total;
   * they're just visually grouped and roll up to one "Total del
   * conjunto" = the simple SUM of each member's own `lineTotal` (see
   * lib/pricing:setSubtotal). There is NO separate set price and NO
   * set-level discount — each piece keeps its own price / qty / discount.
   *
   * null / undefined means the line is standalone.
   *
   * Mutually exclusive with `isOptional` and `alternativeGroup`: a line
   * in a set must be neither optional nor an alternative (the take-all
   * "all of these" semantic contradicts "maybe this" and "pick one").
   * The QuoteBuilder handlers strip those flags when a line joins a set
   * and a DB CHECK constraint (migration 20260523120000) forbids the
   * combination — mirroring the existing optional-xor-alternative rule.
   *
   * Because every set member is priced, isPricedLine (lib/constants)
   * needs NO special case for sets.
   */
  setGroup?: string | null;

  /* Internal-only — never rendered in client-facing surfaces. */
  notes?: string;
}

/**
 * A catalog product — one priced SKU of a BRAND catalog. The searchable
 * catalog behind "Agregar artículo": picking one autofills the quote line and
 * snapshots `cost` onto it for the margin view. `priceUsd` is the list
 * (Retail) price; `cost` is the real wholesale cost. Each brand imports in its
 * own manner (see PRODUCT_BRANDS in lib/constants): Ligne Roset from the
 * price-list CSV, LifestyleGarden from the team's Shopify store.
 */
export interface Product {
  id: string;
  profileId: string;
  /** Brand catalog this row belongs to — a PRODUCT_BRANDS id. */
  brand?: string;
  reference: string;
  name?: string;
  subtype?: string;
  dimensions?: string;
  family?: string;
  familyCode?: string;
  category?: string;
  priceUsd?: number;
  /** LSG rows: the pre-sale LIST price (Shopify compareAtPrice) when the store
   *  runs a markdown (e.g. the permanent −40%) — always > priceUsd when set.
   *  Quotes snapshot it (QuoteLine.listPriceUsd) so the sale renders as a
   *  baked-in discount; null for LR rows and unmarked-down variants. */
  listPriceUsd?: number | null;
  cost?: number;
  /** LSG rows: sellable units in the store (Shopify inventoryQuantity),
   *  refreshed on each catalog sync. Null = not tracked / pre-stock sync.
   *  Gates the quote builder (out-of-stock can't be quoted) and the client
   *  catalog PDF. */
  stockQty?: number | null;
  /** Cover photo (→ images.id) — LSG rows, a CDN POINTER row written by the
   *  sync's pointer pass (external_url, no stored bytes); quote lines
   *  snapshot it on insert. Null for LR rows. */
  imageId?: string | null;
  /** The brand store's own CDN cover URL (= imageSrcs[0]) — the render
   *  fallback while a pointer is pending (ImageView fallbackUrl). */
  imageSrc?: string;
  /** FULL CDN gallery, cover first — every product photo on the store. */
  imageSrcs?: string[] | null;
  /** LSG only: the gallery's first NON-packshot shot — the supplier's lifestyle
   *  photography, chosen at import by pixel shape (shopify-sync
   *  `lifestyleSrcOf`) because `imageSrcs` keeps only urls. The cover is a
   *  cutout on white: right on a quote line and in the catalog PDF, wrong in an
   *  ad. Only ad-facing surfaces read this; null/empty means use the cover. */
  lifestyleImageSrc?: string | null;
  /** Pointer ids for imageSrcs[1..] — copied onto a quote line's
   *  extraImageIds on catalog insert so the client sees the whole gallery. */
  extraImageIds?: string[] | null;
  active?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A Togo configurator model — one dealer-managed entry in the picture catalog
 * (the Togo workspace → Modelos tab, `/togo/modelos`). The dealer uploads the
 * model's DWG (converted IN the
 * browser to a top-down plan `svg` + measured cm footprint) and binds it to a
 * Ligne Roset family (`productRoot`) so the configurator prices it by grade. The
 * configurator's palette is the set of these rows — no more name-matching.
 */
/**
 * A Ligne Roset dealer that embeds the SHARED public Togo configurator on its own
 * site. One `dealers` row per dealer: its `slug` keys the `?dealer=` embed lookup,
 * its `inboxToken` gates a private, login-less lead inbox (`#/dealer/:token`), and
 * its locale/currency/usdRate/pricingMode/priceMultiplier only change how prices
 * are PRESENTED — the model catalog stays one catalog maintained by Alcover.
 * Alcover manages these from the Togo workspace's "Distribuidores" tab. A lead with
 * `togo_requests.dealerId` null is Alcover's own ("Directo").
 */
export interface Dealer {
  id: string;
  profileId: string;
  /** URL-safe key for the `?dealer=` embed lookup (unique per profile). */
  slug: string;
  name: string;
  contactEmail?: string | null;
  /** Configurator UI + inbox language. */
  locale: 'es' | 'en' | 'fr' | 'de';
  /** ISO 4217 display currency. */
  currency: string;
  /** USD → display-currency conversion rate. Live: the served price is
   *  retail USD × priceMultiplier × usdRate, labelled `currency`. */
  usdRate: number;
  /** How retail prices are shown in this dealer's configurator. */
  pricingMode: 'full' | 'from' | 'hidden';
  /** Applied to retail USD prices for this dealer. */
  priceMultiplier: number;
  /** The collections this dealer CARRIES — its widget serves only these.
   *  NULL/empty means the WHOLE catalog (never "nothing": an empty catalog
   *  would un-stock the dealer's widget, so no surface may offer it). */
  collections?: string[] | null;
  logoUrl?: string | null;
  /** Private, globally-unique token gating the dealer's lead inbox. */
  inboxToken: string;
  active: boolean;
  notes?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface TogoModel {
  id: string;
  profileId: string;
  /** Dealer label, e.g. "Sillón Togo". */
  name: string;
  /** Bound Ligne Roset family root (8-digit SKU prefix) → pricing + grade list. */
  productRoot?: string | null;
  /** The ELEMENTO COMPLETO family root — LR's cheaper whole-piece ladder, used
   *  instead of base + componentes when every componente rides the SAME
   *  material. Null ⇒ the piece always prices by parts. */
  completeRoot?: string | null;
  /** Optional specific SKU within the family. */
  productReference?: string | null;
  /** Modular family/collection this piece belongs to (Togo, Prado, …). The
   *  configurator palette and the Modelos tab group by it. Null ⇒ 'Togo'. */
  collection?: string | null;
  /** LR library CATEGORY detected from a FOLDER import — what the piece is
   *  ("Beds", "Sofa"), read from the path. Null for single-file uploads. */
  category?: string | null;
  /** LR library GROUP — the level above `category` ("Upholstery",
   *  "Occasional"), also read from the path on a folder import. Named
   *  productGroup because `group` is a reserved SQL word. Null when unknown. */
  productGroup?: string | null;
  /** Measured top-down footprint (centimetres). */
  widthCm: number;
  depthCm: number;
  /** Converted top-down plan markup (stroke=currentColor), rendered inline. */
  svg: string;
  sortOrder?: number;
  /** Real 3D model file (public Storage URL) uploaded in Modelos — when set, the
   *  configurator renders it instead of the procedural geometry. */
  meshUrl?: string | null;
  /** Mesh fixups: scale = drawing units → cm (null ⇒ auto-fit to footprint);
   *  upAxis 'y' (default) | 'z' (CAD Z-up); rotateY in degrees. */
  meshScale?: number | null;
  meshUpAxis?: string | null;
  /** Mesh-pipeline version this model's 3D file was last exported through
   *  (ALCOVER_MESH_V). 0/absent = never re-exported, so the studio's automatic
   *  pass picks it up; recorded here so an up-to-date catalogue costs no
   *  downloads to verify. */
  meshV?: number | null;
  meshRotateY?: number | null;
  /** The ORIGINAL export the servable `meshUrl` GLB was converted from (public
   *  Storage URL) — kept so a mesh stays re-convertible when the converter
   *  improves, since the DWG → pCon → FBX → GLB chain can't be walked backwards
   *  from the GLB. Admin/audit only; the configurator never fetches it. */
  meshSourceUrl?: string | null;
  /** The source file's original name (e.g. "togo_sofa.fbx") — what identifies
   *  the drop when Ligne Roset reissues a piece's geometry. */
  meshSourceName?: string | null;
  /** When the mesh (or its source) last changed — the staleness clock, JS ms
   *  (rowMapping converts `*At` ↔ timestamptz). Separate from `updatedAt`,
   *  which any edit to the row touches. */
  ingestedAt?: number | null;
  /** The BAKED catalogue thumbnail (public Storage URL) and the STORE KEY it was
   *  baked under (`togoThumbStoreKey` — content + frame + cloth). With them the
   *  configurator's piece list is plain <img>s; without them, or with a stamp
   *  that no longer matches the row, it renders each tile from the mesh as it
   *  always did. Written by the studio's automatic bake pass, never by hand. */
  thumbUrl?: string | null;
  thumbStamp?: string | null;
  /** Same pair for this piece's DRESSED render, when it is its collection's
   *  cover: the one fabricked image worth baking, since the collection index is
   *  the configurator's first screen. */
  heroThumbUrl?: string | null;
  heroThumbStamp?: string | null;
  active?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** One placed piece in a web Togo request — mirrors the configurator placement. */
export interface TogoRequestItem {
  /** The `togo_models.id` the visitor placed. */
  modelId: string;
  x: number;
  y: number;
  /** Rotation in degrees (0/90/180/270). */
  rot: number;
}

/** The visitor's contact captured by the public widget. */
export interface TogoRequestContact {
  name?: string;
  phone?: string;
  email?: string;
}

/**
 * A lead from the PUBLIC Togo configurator widget (`#/embed/togo`). Captured by
 * the `togo-embed` Edge Function into `togo_requests` and held on the Togo
 * workspace's Solicitudes tab until the dealer promotes it into the regular quote
 * pipeline (→ a draft quote). `items` replay through the same configurator VM as
 * the internal builder; `status` walks pending → converted | dismissed.
 */
export interface TogoRequest {
  id: string;
  profileId: string;
  /** 'contacted' is set by a dealer from its own inbox (`#/dealer/:token`); the
   *  rest are app-side transitions. */
  status: 'pending' | 'contacted' | 'converted' | 'dismissed';
  contact: TogoRequestContact;
  items: TogoRequestItem[];
  note?: string | null;
  /** The retail estimate (USD) the visitor saw at submit — a display snapshot. */
  estimateUsd?: number | null;
  /** Which dealer this lead belongs to (`dealers.id`); null ⇒ Alcover's own
   *  embed ("Directo"). */
  dealerId?: string | null;
  /** The draft quote created when the request was promoted. */
  quoteId?: string | null;
  /** The visitor-captured composition render (`images.id`, `togosnap-<id>` —
   *  a SHARED row deleteImage refuses): shown on the Solicitudes card and
   *  attached as the quote line's cover by promote/togo-quote-worker. */
  snapshotImageId?: string | null;
  /** The Meta ad click that produced this lead (`fb.1.<ms>.<fbclid>`), carried
   *  until the dealer promotes it — that is when it moves onto the contact. */
  metaFbc?: string | null;
  /** togo-quote-worker's claim/outcome column (separate from `status`):
   *  null = fresh (eligible) → 'processing' → 'queued' (proposal awaiting
   *  approval) | 'done' (quoted + sent) | 'skipped' | 'failed'. Pre-feature
   *  rows are stamped 'skipped' by the migration. */
  autoState?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * ONE FROZEN QUOTE — a configurator build turned into a priced document.
 *
 * Read-only from the browser, and the type says so: every field is `readonly`
 * because there is no write path here to use them with. RLS grants
 * `authenticated` a SELECT and no write at all, and the `veta_quotes_frozen`
 * trigger refuses any change but a state advance even to the service role. The
 * document is created by the `togo-embed` Edge Function, from the catalog as it
 * stood at that instant, and a later price-list edit, markup change or FX move
 * must never restate something a customer has already been sent.
 *
 * So: `lines`, `totals` and `currency` are the money AS FROZEN, already
 * factored into the quote's own currency — nothing downstream re-converts them.
 * A wrong quote is superseded by a new one, never edited into another.
 */
export interface VetaQuote {
  readonly id: string;
  readonly profileId: string;
  /** Per-profile document number (1001, 1002, …). */
  readonly number: number;
  /** The configurator lead it was made from; survives the lead's removal. */
  readonly requestId?: string | null;
  readonly dealerId?: string | null;
  /** The brand silo this document belongs to (`brands.id`) — stamped at freeze
   *  from the dealer, else the lead; null = the manufacturer's own embed,
   *  visible to whole-install members only. SET-ONCE at the trigger: a
   *  document does not change house after the fact. */
  readonly brandId?: string | null;
  /** FROZEN identity: renaming a dealer must not restate a document sent under
   *  the old name. */
  readonly brandName: string;
  readonly status: 'draft' | 'sent' | 'accepted' | 'declined';
  readonly currency: string;
  readonly customer: { name?: string; phone?: string; email?: string };
  readonly note?: string | null;
  /** The frozen priced pieces, exactly as quoted. */
  readonly lines: unknown[];
  /** { total, pieces, priced, unpriced, currency } — frozen with the lines. */
  readonly totals: Record<string, unknown>;
  /** The composition render the visitor built (`images.id`). */
  readonly snapshotImageId?: string | null;
  /** The login-less customer link (#/q/<token>); `shareEnabled` is the revoke
   *  gate — off kills the link without dropping the token, so re-enabling
   *  restores the SAME URL. */
  readonly shareToken?: string | null;
  readonly shareEnabled: boolean;
  readonly viewCount: number;
  readonly firstViewedAt?: number | null;
  readonly sentAt?: number | null;
  readonly acceptedAt?: number | null;
  readonly declinedAt?: number | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/**
 * Per-model fabric availability, keyed by the family root (`splitSkuGrade`).
 * Captured from a Ligne Roset product page (`lr-catalog` single-product mode):
 * `patternNames` are the fabrics that model actually offers, stored normalized
 * (`fabricKey`) so they match `Material.name`. Used to restrict the material
 * picker to in-grade AND offered fabrics. See `src/lib/modelFabrics.js`.
 */
export interface ModelFabrics {
  id: string;            // the family root (e.g. "15420000")
  profileId: string;
  sourceUrl?: string | null;
  title?: string | null;
  patternNames: string[];
  fetchedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * One pinned fabric in a quote's curated material library ("Paleta del
 * proyecto"). Mirrors the swatch picker's emit shape ({ grade, fabric,
 * swatchImageId }) plus a stable id for keying/removal, so a pinned entry
 * applies to a line/component through the exact same path a fresh pick does
 * (grade reprice included). `fabric` is the composed "MATERIAL · COLOR (#code)".
 */
export interface QuoteMaterial {
  id: string;
  grade: string;
  fabric: string;
  swatchImageId?: string | null;
}

export interface Quote {
  id: string;
  profileId: string;
  customerId?: string | null;
  professionalId?: string | null;
  orderId?: string | null;
  /** auth.uid() of the user who closed the deal; commission attribution. */
  createdByUserId?: string | null;

  number?: number | null;
  status: QuoteStatus;

  /** Quote-level commission override for the professional. null = inherit. */
  commissionPct?: number | null;

  /**
   * Floor order ('floor', 15% base commission) vs special order ('special',
   * 20%). Sets the professional's base rate AND the commission payout timing:
   * a floor order pays on the deposit; a special order is tied to a
   * container/order and pays on the balance (see commissionOwedAt).
   * Defaults to 'floor'.
   */
  orderType?: OrderType;

  /**
   * How the assigned professional's cut is settled for accounting — the
   * SAME rate, two AR directions. Internal only; the client PDF always
   * shows the full price. Defaults to 'commission'. Only meaningful when
   * `professionalId` is set.
   */
  decoratorBilling?: DecoratorBilling;

  currencyCode?: CurrencyCode;
  /** Snapshot at draft time; live-overlaid in the workspace + PDF. */
  rates?: RatesMap;
  /**
   * Per-quote MANUAL USD→DOP override. When set (> 0) it replaces the live
   * Banco Popular rate on this quote while it's still open — a negotiated FX
   * the dealer pins for one client — and is the figure frozen onto `rates`
   * at accept. null/0 ⇒ follow the live bank rate (the default). Resolved by
   * lib/exchangeRate:quoteRateState, the single rate funnel.
   */
  manualRate?: number | null;
  marginPct?: number;
  discountPct?: number;
  /**
   * Friends & Family courtesy discount (%) — a SECOND quote-level discount,
   * independent of `discountPct`. Unlike the regular discount (which is drawn
   * out of the professional's commission dollar-for-dollar), the courtesy is
   * NOT drawn out: it lowers the base the commission is computed on, so the
   * designer earns the same % on the post-courtesy amount — a proportional
   * reduction, not a full one (see lib/commissions:commissionBreakdown). Shows
   * as a separate "Friends & Family" line on the client's bill. Applied after
   * `discountPct`, before ITBIS. Clamped to [0, 100]; default 0.
   */
  courtesyDiscountPct?: number;
  shipping?: number;

  terms?: string;
  notes?: string;

  /* Status-stepper timestamps. Only the active stage carries one. */
  sentAt?: number | null;
  acceptedAt?: number | null;
  declinedAt?: number | null;
  /** Why the quote was declined (win/loss learning) — optional free text or a
   *  preset, captured at decline. A plain field; does not affect status. */
  declineReason?: string | null;
  archivedAt?: number | null;
  /** Set by the load-time auto-archive sweep when IT archived this quote
   *  (null = a person archived it). Compared against archivedAt by
   *  lib/quoteStages:isAutoArchived to label the list row. */
  autoArchivedAt?: number | null;

  /* Lifecycle signals (see 20260917000000_quote_lifecycle_signals.sql).
   * emailedAt = last Gmail send of this quote (counts as dealer contact in
   * JARVIS follow-ups); lastViewedAt/viewCount = the client opened the public
   * link (stamped server-side by quote-share GET); picksUpdatedAt = the client
   * changed their picks on the link (quote-share POST). */
  emailedAt?: number | null;
  lastViewedAt?: number | null;
  viewCount?: number;
  picksUpdatedAt?: number | null;

  /* Accepted-quote milestones (live on the QUOTE, not the order). The deposit
   * is only SIGNALLED here (depositReceivedAt); the amount lives in the books
   * as a cobro — see core/accounting/deposits. */
  depositReceivedAt?: number | null;
  balancePaidAt?: number | null;
  deliveredAt?: number | null;

  /* When the assigned professional's commission on this quote was PAID
   * OUT (Contabilidad tracking). null = pending. See commissionOwedAt()
   * in lib/commissions for when it becomes owed. */
  commissionPaidAt?: number | null;
  /* The professional commission $ frozen at payout time (snapshotted when
   * commissionPaidAt is set), so a later order_type toggle / base-rate change
   * can't restate what was paid. null = not paid → recompute live. */
  commissionPaidAmount?: number | null;

  /* When the SELLER (vendedor) commission on this quote was paid out.
   * null = pending. The seller's cut is earned once the deposit lands;
   * this is its sibling of commissionPaidAt (the professional's cut). */
  sellerCommissionPaidAt?: number | null;
  /* The seller commission $ frozen at payout time (sibling of
   * commissionPaidAmount), so editing the seller's profile commission_pct
   * later can't restate what was paid. null = not paid → recompute live. */
  sellerCommissionPaidAmount?: number | null;

  /* Public share link. `shareToken` is a random secret embedded in the
   * shareable URL (#/q/<token>); `shareEnabled` gates whether the link
   * resolves (lets the dealer revoke without losing the token).
   *
   * `clientSelections` is LEGACY: the share link used to store a recipient's
   * picks separately here, but the owner chose a single source of truth — the
   * `quote-share` function now applies picks directly to `quote_lines`, so this
   * column is no longer written. Kept (nullable) only so old rows type-check. */
  shareToken?: string | null;
  shareEnabled?: boolean;
  clientSelections?: ClientSelections | null;

  /** Curated per-quote material library — the fabrics pinned to this project,
   *  surfaced first in the material picker. See QuoteMaterial. */
  materialLibrary?: QuoteMaterial[] | null;

  createdAt?: number;
  updatedAt?: number;
}

/**
 * What a share-link recipient picked, persisted on the quote (plan A —
 * non-destructive). `alternatives` maps an alternativeGroup id to the line
 * id the client chose within it; `optionals` maps an optional line id to
 * whether the client wants it included; `materials` maps a line OR compound
 * component id to the material GRADE the client re-quoted it in (the base
 * grade, or one of the line's `materialOptions`). Absent keys fall back to
 * the dealer's own selection / the line's default base material.
 */
export interface ClientSelections {
  alternatives?: Record<string, string>;
  optionals?: Record<string, boolean>;
  materials?: Record<string, string>;
  updatedAt?: number;
}

export interface Order {
  id: string;
  profileId: string;
  customerId?: string | null;
  number?: number;
  name?: string;
  status: OrderStatus;
  notes?: string;
  deliveryAddress?: string;

  /* Stage timestamps — match orderStages.js timestampField names. */
  placedAt?: number | null;
  confirmedAt?: number | null;
  inTransitAt?: number | null;
  inCustomsAt?: number | null;
  receivedAt?: number | null;
  cancelledAt?: number | null;

  createdAt?: number;
  updatedAt?: number;
}

export interface ImageRecord {
  id: string;
  kind: string;
  ownerId?: string | null;
  label?: string;
  contentType?: string | null;
  size?: number | null;
  /** Object path in the images bucket — null on a CDN pointer row. */
  storagePath?: string | null;
  /**
   * Remote CDN url (LSG catalog photos, kind 'catalog-lsg'): the row is a
   * POINTER — no bytes live in our bucket. Resolvers (ImageView,
   * downloadImageBytes) serve straight from this url.
   */
  externalUrl?: string | null;
  createdAt?: number;
}

/* --------------------------------- materials --------------------------------- */

/**
 * `materials.category`. Fabrics + outdoor are priced per linear yard;
 * leather is priced per square meter and uses thickness (mm) instead
 * of width (in).
 */
/** `com` = Customer's Own Material — alternate telas from houses outside the
 *  Ligne Roset book (Dedar, Pierre Frey, Kvadrat…). Prices and quotes like the
 *  rest; the category only keeps them in their own section. */
export type MaterialCategory = 'fabric' | 'leather' | 'outdoor' | 'com';

export interface MaterialColor {
  name: string;
  /** LR sku-fragment for the color, e.g. "4479" / "5312". */
  code: string;
  /**
   * Optional swatch image attached to the color, by `images.id`. The
   * material's "hero" thumbnail is simply the first color that carries
   * one — there is no separate material-level photo. The LR seed leaves
   * this null on all 850 imported colors; the dealer attaches them as
   * needed, including inline from the quote line's swatch slot.
   */
  imageId?: string | null;
}

export interface Material {
  id: string;
  profileId: string;
  category: MaterialCategory;
  /** Display name, e.g. "ALCANTARA - A", "DIVA", "CHARTRES". NOTE: this string
   *  IS the printed fabric label (composeFabricLabel stamps "<name> · <color>"
   *  onto the quote line) — never prefix the house into it, that's `house`. */
  name: string;
  /** The HOUSE that publishes the material — "Ligne Roset" for the base book,
   *  "Kvadrat" / "Dedar" / "Pierre Frey" for the COM alternates. Labels and
   *  filters only; it never reaches the printed fabric string. */
  house?: string | null;
  /**
   * Single-letter grade — drives pricing tier on the parent product.
   * Maps to GRADE_GROUPS in lib/subtype. May be null on user-added
   * materials that haven't been graded yet.
   */
  grade?: string | null;
  /** LR wear-resistance code, e.g. "3C", "2B", "A". */
  wearRating?: string | null;
  /** Martindale / double-rubs count, e.g. 50000. */
  wearDoubleRubs?: number | null;
  /**
   * Numeric measure — width in inches for fabrics/outdoor, thickness
   * in millimetres for leather. The companion `measureUnit` field
   * disambiguates.
   */
  measure?: number | null;
  measureUnit?: 'in' | 'mm' | null;
  /** USD per `priceUnit`. */
  price?: number | null;
  priceUnit?: 'yard' | 'sm' | null;
  composition?: string | null;
  colors: MaterialColor[];
  notes?: string | null;
  /**
   * Set by a full catalog sync when this material is no longer offered
   * anywhere on the Ligne Roset site. Kept (not deleted) so dealer-only data
   * — per-yard price, grade, uploaded color photos, COM entries — survives;
   * `null` means active / on-site.
   */
  discontinuedAt?: number | null;
  /**
   * Set by a complete price-list (PDF) import when this material isn't found
   * in the price list — so it carries no current grade/price. Kept, not
   * deleted (it may be a website-only or custom entry); `null` means present
   * in the price list.
   */
  notInPricelistAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/* ------------------------------ pricing math ------------------------------ */

/**
 * The shape `computeTotals` expects per line. `lineForTotals(line)`
 * is the canonical mapping from a `QuoteLine` (including compounds)
 * into this shape.
 */
export interface PricingLine {
  qty: number;
  basePrice: number;
  lineMarginPct?: number;
  lineDiscountPct?: number;
  /** SIN ITBIS, already resolved through `lib/pricing:lineTaxExempt`. */
  taxExempt?: boolean;
}

export interface PricingQuote {
  marginPct?: number;
  discountPct?: number;
  /** Friends & Family courtesy discount (%) — see Quote.courtesyDiscountPct. */
  courtesyDiscountPct?: number;
  shipping?: number;
}

export interface Totals {
  subtotal: number;
  marginAmt: number;
  discountAmt: number;
  /** Friends & Family courtesy discount $ — dealer-absorbed, never drawn from
   *  the professional's commission. See lib/pricing:computeTotals. */
  courtesyDiscountAmt: number;
  taxableBase: number;
  /** The slice of `taxableBase` charged no ITBIS (lines marked sin ITBIS): the
   *  tax fell on `taxableBase − exemptBase + shipping`. See lib/pricing. */
  exemptBase: number;
  taxAmt: number;
  shipping: number;
  grandTotal: number;
  taxPct: number;
}

/* ------------------------------ accounting ------------------------------ */