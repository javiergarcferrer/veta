-- UN DISTRIBUIDOR, LAS MARCAS QUE REALMENTE REPRESENTA
--
-- RE-ESTAMPADA 20260831190000 → 20261220000000 el día que nació. La cadena de
-- veta usa timestamps FUTUROS como secuencia (la última aplicada era
-- 20261219000000), así que la fecha real del calendario quedó DETRÁS de la
-- cadena y el deploy la saltó en silencio: la tabla nunca existió en prod
-- (medido 2026-08-31, con la UI de asignaciones ya publicada encima). La regla
-- vive ahora en tests/migrationOrder.test.js: una migración se nombra después
-- de toda la CADENA, no después del reloj.
--
-- `dealers` nació cuando había UNA marca, así que un distribuidor era
-- implícitamente «un distribuidor de Ligne Roset» y nada en la fila lo decía.
-- Eso deja de ser cierto en cuanto veta sirve a varias: un distribuidor trabaja
-- con Ligne Roset, o con Carl Hansen, o con las dos, y quién representa a quién
-- es un dato del negocio, no una suposición del código.
--
-- ── POR QUÉ UNA TABLA DE UNIÓN Y NO UNA COLUMNA ─────────────────────────────
-- Porque la cardinalidad real es 1..N y porque la asignación tiene que poder
-- llevar sus propios datos con el tiempo (desde cuándo, con qué margen para ESA
-- marca, activa o suspendida por marca). Un `brand_id` en `dealers` obligaría a
-- duplicar la fila del distribuidor —su slug, su token de bandeja, su moneda—
-- una vez por marca, y entonces «Ligne Roset New York» y «Carl Hansen New York»
-- serían dos negocios distintos para el sistema y el mismo para el mundo.
--
-- ── LA REGLA QUE ESTO HACE POSIBLE ──────────────────────────────────────────
-- El catálogo que sirve el embed de un distribuidor es la INTERSECCIÓN de lo
-- que la marca publica y lo que ese distribuidor tiene asignado. Sin la
-- asignación, un distribuidor de sillas vería el sofá modular de otra marca en
-- su propio sitio, con su propio margen aplicado encima — que es la clase de
-- fallo que sólo se descubre cuando un cliente ajeno lo llama para pedirlo.
--
-- ── QUÉ PASA CON `dealers.brand_id` ─────────────────────────────────────────
-- Sigue ahí y sigue significando algo: es la marca PRINCIPAL del distribuidor
-- —la que viste su widget y de la que sale su escalera de grados— mientras que
-- esta tabla dice el conjunto COMPLETO que puede servir. Quitarla ahora sería
-- una migración de datos sobre filas que tres sitios ajenos están leyendo en
-- vivo; convive, y el lector toma la unión de las dos.
--
-- ── COMPATIBILIDAD: NADIE SE QUEDA A OSCURAS ────────────────────────────────
-- El backfill preserva la marca REAL de cada distribuidor (`dealers.brand_id`),
-- y sólo cae a la marca de la casa (`brands.is_house`) para las filas que
-- nacieron antes de que existiera la columna. Sembrarlos a todos contra una
-- marca fija habría reasignado en silencio a cualquiera que ya representara a
-- otra — el error exacto que esta tabla existe para hacer imposible.

create table if not exists public.dealer_brands (
  dealer_id   text not null references public.dealers(id) on delete cascade,
  brand_id    text not null references public.brands(id)  on delete cascade,
  -- Suspender UNA marca de un distribuidor sin borrar la relación ni tocar las
  -- otras: se apaga el catálogo de esa marca en su sitio y se conserva desde
  -- cuándo la representa.
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (dealer_id, brand_id)
);

-- Las dos direcciones en las que se pregunta: «¿qué marcas lleva este
-- distribuidor?» (el embed, en cada carga) y «¿quién vende esta marca?» (la
-- pantalla de la marca).
create index if not exists dealer_brands_dealer_idx on public.dealer_brands (dealer_id);
create index if not exists dealer_brands_brand_idx  on public.dealer_brands (brand_id);

alter table public.dealer_brands enable row level security;

-- Misma autoridad que la fila del distribuidor de la que cuelga: quien puede
-- ver y administrar `dealers` puede ver y administrar sus asignaciones. La
-- lectura PÚBLICA del embed no pasa por aquí — va por la service role dentro de
-- la Edge Function, igual que la fila del distribuidor.
drop policy if exists "team reads dealer brands" on public.dealer_brands;
create policy "team reads dealer brands" on public.dealer_brands
  for select using (
    exists (select 1 from public.dealers d where d.id = dealer_id)
  );

drop policy if exists "team writes dealer brands" on public.dealer_brands;
create policy "team writes dealer brands" on public.dealer_brands
  for all using (
    exists (select 1 from public.dealers d where d.id = dealer_id)
  ) with check (
    exists (select 1 from public.dealers d where d.id = dealer_id)
  );

-- EL BACKFILL. Sin él, todo distribuidor que ya existe se queda sin ninguna
-- marca asignada el día que el lector empiece a exigirla — y como la regla
-- falla CERRADO, eso los apaga a todos a la vez.
--
-- `left join lateral … on true`, no `cross join`: un cross join con una
-- subconsulta vacía no devuelve cero marcas, devuelve cero DISTRIBUIDORES. Sin
-- marca de la casa (una base recién creada) habría descartado también a los que
-- sí tienen `brand_id` propio, que son justamente los que no necesitaban el
-- respaldo. La casa es el respaldo de las filas viejas, nunca un requisito.
--
-- Idempotente: `on conflict do nothing` la deja correr otra vez sin duplicar ni
-- resucitar una asignación que alguien retiró a mano.
insert into public.dealer_brands (dealer_id, brand_id)
select d.id, coalesce(d.brand_id, h.id)
from public.dealers d
left join lateral (
  select b.id from public.brands b where b.is_house limit 1
) h on true
where coalesce(d.brand_id, h.id) is not null
on conflict (dealer_id, brand_id) do nothing;

notify pgrst, 'reload schema';
