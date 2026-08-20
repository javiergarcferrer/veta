-- ─────────────────────────────────────────────────────────────────────────────
-- FREDERICIA — la segunda marca fabricante de este despliegue, y la primera que
-- se compra a un DISTRIBUIDOR.
--
-- Fredericia Furniture (y Erik Jørgensen, la casa que compró y sigue vendiendo
-- con su propio prefijo `EJ`) no nos vende directo: le compramos a ANTHOM
-- DESIGN HOUSE, y lo que Anthom publica es su tienda. Eso cambia de dónde sale
-- el catálogo, no cómo funciona el producto — por eso esto es UNA FILA, no una
-- rama: `brands.modules` nombra el juego de módulos que lee sus archivos
-- (`src/brands/modules/fredericia.js`), exactamente como la fila de Ligne Roset
-- nombra el suyo.
--
-- POR QUÉ HACE FALTA LA MIGRACIÓN, y no basta con crearla desde «Marcas»: el
-- juego `fredericia` existe en el registro desde que se escribió, pero un juego
-- de módulos sólo llega a ejecutarse cuando UNA MARCA lo apunta. Sin esta fila
-- el importador de Anthom no tiene a dónde escribir y el módulo es código que
-- nadie puede alcanzar — el mismo error que dejó 109 productos LifestyleGarden
-- sin ninguna fila en `brands` que los reclamara (ver la migración que los
-- retira). Se crea aquí para que el despliegue traiga la marca ya utilizable.
--
-- QUÉ TRAE Y QUÉ NO. Trae la identidad, la moneda, los módulos y —lo que de
-- verdad decide si el catálogo es alcanzable— `settings.catalogBrand`, el
-- discriminador `products.brand` bajo el que entran sus referencias. NO trae ni
-- un producto: el catálogo se importa desde la tienda («Fredericia» en el nav),
-- y sembrar precios desde una migración los congelaría el día que se escribió
-- este archivo.
--
-- MONEDA USD porque Anthom cotiza en dólares y `products.price_usd` es lo que
-- guarda la app; `locale` español como el resto del back-office.
--
-- Idempotente como todas: `on conflict (slug) do nothing`, así que correr el
-- conjunto contra un proyecto vivo no toca la fila ni sus ajustes. Si algún día
-- hay que CAMBIAR los módulos de esta marca, se cambia desde «Marcas» o con una
-- migración nueva — no reescribiendo ésta, que ya corrió.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.brands (id, slug, name, kind, locale, currency, active, branding, modules, settings)
values (
  'fredericia',
  'fredericia',
  'Fredericia',
  -- Fabricante: vende piezas y quiere aislamiento. Que su tela venga de una
  -- casa (Kvadrat) es una suscripción, no un cambio de naturaleza.
  'manufacturer',
  'es',
  'USD',
  true,
  jsonb_build_object('logoUrl', null, 'primaryColor', '#1c1c1c'),
  -- Los ids son los del registro (src/brands/modules/index.js). Geometría y
  -- materiales son los genéricos A PROPÓSITO — ver la cabecera de
  -- modules/fredericia.js: su 3D vive tras el login de distribuidor de
  -- Fredericia y su tela es de Kvadrat, que ya es una casa de materiales aquí.
  jsonb_build_object(
    'set', 'fredericia',
    'geometry', 'generic-folders',
    'materials', 'generic-swatches',
    'catalog', 'fredericia-anthom'
  ),
  jsonb_build_object('catalogBrand', 'fredericia')
)
on conflict (slug) do nothing;

notify pgrst, 'reload schema';
