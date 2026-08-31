-- ─────────────────────────────────────────────────────────────────────────────
-- CARL HANSEN & SØN — la tercera marca fabricante, y la primera cuyo
-- configurador ya estaba ESCRITO sin que ninguna fila lo reclamara.
--
-- El configurador existe entero: el registro lo nombra
-- (src/brands/configurators — `/configurador/carl-hansen`), main.jsx monta su
-- página (pages/embed/CarlHansenEmbed.jsx), la Edge Function `carl-hansen` le
-- sirve modelos y composiciones leyendo carlhansen.com al vuelo, y
-- src/brands/carl-hansen/* trae su precio, su árbol de selección y sus
-- muestras. Lo ÚNICO que faltaba era esta fila — y sin ella la marca no
-- aparece en el carril de marcas, su entorno no se puede abrir, y todo ese
-- código es alcanzable sólo tecleando la URL. El mismo error que esta cadena
-- ya pagó dos veces: el juego `fredericia` sin fila (ver 20261210000000) y los
-- 109 productos LifestyleGarden que ninguna marca reclamaba (ver la migración
-- que los retira).
--
-- QUÉ TRAE Y QUÉ NO. Trae la identidad y el discriminador
-- (`settings.catalogBrand`) bajo el que entrarán sus referencias cuando haya
-- importador. NO trae productos ni materiales: hoy su configurador NO lee las
-- tablas de este esquema — compone una pieza por sus ejes leyendo la tienda
-- pública de Carl Hansen a través de la función `carl-hansen` (transporte sin
-- caché, a propósito: ver su cabecera). Por eso los módulos son los GENÉRICOS:
-- declarar el juego de Ligne Roset o el de Anthom sería mentir sobre de dónde
-- vienen los datos. Cuando el importador de catálogo de Carl Hansen se traiga
-- de RosetSoft, cambiar los módulos es una edición en «Marcas», no esta fila.
--
-- MONEDA USD porque los archivos de precio de la tienda que lee el
-- configurador son ex-IVA en dólares (`VAT0-USD` — ver
-- src/brands/carl-hansen/price.ts); `locale` español como el resto.
--
-- Idempotente como todas: `on conflict (slug) do nothing` — correr el conjunto
-- contra un proyecto vivo no toca la fila ni sus ajustes.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.brands (id, slug, name, kind, locale, currency, active, branding, modules, settings)
values (
  'carl-hansen',
  -- El slug ES el contrato con el registro de configuradores
  -- (CONFIGURATORS[].brandSlug === brands.slug): así es como el carril de
  -- marcas sabe que esta marca tiene configurador propio y a qué ruta va.
  'carl-hansen',
  'Carl Hansen & Søn',
  'manufacturer',
  'es',
  'USD',
  true,
  -- Sin logo hasta que se suba desde «Marcas»; el negro de la casa para la
  -- ficha (la marca viste monocromo, como Fredericia).
  jsonb_build_object('logoUrl', null, 'primaryColor', '#1c1c1c'),
  -- Los ids son los del registro (src/brands/modules/index.js): el juego
  -- genérico entero, explícito ranura por ranura como escribe modulesValue().
  jsonb_build_object(
    'set', 'generic',
    'geometry', 'generic-folders',
    'materials', 'generic-swatches',
    'catalog', 'generic-sku'
  ),
  jsonb_build_object('catalogBrand', 'carl-hansen')
)
on conflict (slug) do nothing;

notify pgrst, 'reload schema';
