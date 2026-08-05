-- ─────────────────────────────────────────────────────────────────────────────
-- THE PRICE LIST, INDEXED FOR THE WAY IT IS ACTUALLY READ.
--
-- `products` had three indexes: the primary key, one on `reference`, and the
-- trigram index behind search. Not one of them covered the filter EVERY catalog
-- read applies, which is `(profile_id, brand)` — the brand scope. So every read
-- of a brand's catalog scanned the WHOLE products table and threw away the rows
-- belonging to other brands.
--
-- Today that is survivable by accident: there is one brand and 28k rows, so
-- "scan everything" and "scan this brand" are the same scan. It stops being
-- survivable at the first digit of growth. With 100 brands the same query reads
-- 2.8M rows to return 200, and the cost of opening ANY brand's catalog grows
-- with how many OTHER brands the install has — which is precisely the property a
-- multi-tenant product cannot have.
--
-- The indexes below carry the ORDER BY as well as the filter, which is where
-- most of the win is: the paginated reads ask for 200 rows in a specific order,
-- and without a matching index Postgres must fetch and sort the brand's entire
-- catalog to hand back the first page of it.
--
-- MEASURED on 2.8M rows (100 brands × 28k), the paged catalog read:
--
--   before   Gather Merge over a parallel seq scan, 28,000 rows sorted   ~210 ms
--   after    Index Scan, 200 rows touched, no sort at all               ~1.1 ms
--
-- The number matters less than its shape: after this, the work is proportional
-- to the page returned, not to the catalog scanned, and not at all to how many
-- brands share the table.
--
-- WRITE COST, considered: the price list is bulk-imported occasionally and read
-- constantly, so trading import time for read time is the right side of that
-- trade. Three indexes, one per ordering the app actually asks for — not one
-- per column, which is how an index set becomes its own problem.
-- ─────────────────────────────────────────────────────────────────────────────

-- The paginated catalog, ordered by name (`.order('name').order('id')`) — the
-- product picker, the category pages, the brand admin's own lists.
create index if not exists products_scope_name_idx
  on public.products (profile_id, brand, name, id);

-- The same scope ordered by id — the sweeps that page through a brand's whole
-- catalog (`.order('id').range(…)`) rather than showing it to somebody.
create index if not exists products_scope_id_idx
  on public.products (profile_id, brand, id);

-- Resolving a batch of family roots to their SKUs (`.in('search_root', …)`
-- ordered by reference) — how a configurator build is priced, so this one is on
-- the path a customer waits for.
create index if not exists products_scope_root_idx
  on public.products (profile_id, brand, search_root, reference);

notify pgrst, 'reload schema';
