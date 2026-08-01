# Brand onboarding — zero to embedded

The runbook a brand (or the operator acting for one) follows to go live. Every
step maps to shipped code; nothing here requires operator SQL beyond the
documented RPCs. Self-serve UI for these steps is the Phase-3.3 admin flow;
until it fully lands, the admin app (`apps/admin`) covers dealers/keys/leads
and the studio (`apps/studio`) covers the model library.

## 0. Prerequisites (operator, once per deployment)

- Supabase project with `infra/supabase/migrations/*` applied in order.
- `apps/api` deployed (Node host) with its Postgres connection as the
  low-privilege role — the service-role key never enters the request path.
- `apps/widget` / `apps/studio` / `apps/admin` deployed as static builds.
- `apps/render` deployed (container with Chromium) behind the API's internal
  secret.

## 1. Create the org + brand

Insert an `orgs` row (kind `brand`) and its `brands` row (name, slug, logo,
theme, locales). Add the brand's first member as `brand_admin`
(`org_members`). RLS makes the org invisible to everyone else from birth.

## 2. Issue keys

Through the `issue_api_key` RPC (or the admin Keys panel): one **publishable**
key (`pk_`) for the widget embed — origin-pinned to the brand's domains — and
optionally one **secret** key (`sk_`) if the brand's backend will pull leads.
The token is shown once; the stored surface is redacted by construction.

## 3. Upload the library (studio)

- Drop the brand's asset folder into the studio. OFML/pCon exports parse with
  the positional library adapter; plain glTF/OBJ/FBX also ingest. Sidecar
  bitmaps pair automatically; multi-piece scenes split by footprint.
- Meshes optimize in Web Workers (crease→weld→quantize, stamped idempotent).
- Per model: **Detect parts** proposes roles (dealer choices always win),
  bind the base SKU + billed part slots, author finish palettes (fan-out
  count shown before commit), review the plan, publish. The fidelity panel
  renders through the widget's own pipeline — a green check there means green
  in front of a customer.
- Rights: the brand attests it owns the uploaded assets. Nothing ships from
  the platform side; each org's assets live under its own storage prefix.

## 4. Prices

Create a `price_lists` row in the brand's currency and load `prices`
(SKU/grade/amount in minor units). Pick the SKU grammar: `lr-8digit-grade`
for graded-ladder catalogs, `simple` for flat SKU+variant sheets
(`sku_grammars`). Only `active` price lists reach the public plane.

## 5. Rules (optional)

Author the collection's ruleset (five declarative types; see
`docs/design-phase1.md` §1). Draft → validate (a dropped rule blocks
activation) → activate. Free-form collections can ship with warnings only —
rules report, they never block a drag.

## 6. Dealers + routing

In the admin app: create dealers (locale, currency label, pricing mode
full/from/hidden + multiplier), add locations (lat/lng, radius or polygon
territory, priority), choose the routing cascade (default
territory → nearest → manual; round-robin opt-in). The live preview routes a
test lead through the real engine. Dealer users get `dealer`-role memberships
scoped to their dealer — they see only their routed leads.

## 7. Embed

Copy the snippet from the SDK (`embedSnippet({apiBase, publishableKey,
collection, locale})`) into the brand's site — a self-sizing iframe. Or mount
programmatically via `VetaWidget.mount(el, options)` and listen for
`configured` / `priced` / `submitted` events. AR, exports, share links and the
QR desktop→phone handoff work out of the box.

## 8. Verify

- Open the embed on the brand's domain (the pk is origin-pinned — a copied
  snippet on a foreign domain is refused).
- Build a piece, pick a fabric, submit a test lead with a real phone.
- Confirm the lead lands in the admin board with its routing stamp and the
  dealer sees it in their portal.
- Check the funnel shows the session (`@veta/analytics` over `/v1/events`).

## Later (wired, pending live setup)

- **Billing**: plan assignment + Stripe subscription via `@veta/billing`'s
  builders (requires the Stripe integration to be authorized at deploy).
- **Shopify**: install the connector — placeholder products per collection,
  cart lines carrying the configured SKU (`@veta/connect-shopify`).
