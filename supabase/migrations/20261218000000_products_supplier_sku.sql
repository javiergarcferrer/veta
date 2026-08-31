-- ─────────────────────────────────────────────────────────────────────────────
-- products.supplier_sku — el SKU DE FÁBRICA de una variante.
--
-- El enriquecedor de Fredericia (fredericia-catalog + FredericiaEnrichBar)
-- cruza las filas que Anthom ya precia con la ficha del FABRICANTE, y una de
-- las cosas que el fabricante publica es su propio SKU para esa variante — el
-- código que va en el pedido que sale hacia la fábrica, distinto de la
-- referencia con la que el distribuidor nos la vende. Un hecho del dominio con
-- lector claro: quien arma el pedido.
--
-- NOTA DE PORTE: upstream (RosetSoft) escribe este campo desde su barra
-- equivalente pero NINGUNA migración suya crea la columna — el guardado
-- fallaría en PGRST204. Aquí la columna nace con su escritor (avisado arriba
-- como hallazgo, no plegado en este diff).
--
-- LA REGLA DEL ARCHIVO (20261215): quien ensancha products alinea el archivo
-- posicional de LSG, o la re-ejecución del conjunto y el camino de
-- restauración documentado en 20261207 dejan de casar.
--
-- Aditiva + idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.products add column if not exists supplier_sku text;

comment on column public.products.supplier_sku is
  'El SKU del FABRICANTE para esta variante (p. ej. el de la ficha de Fredericia) — el código del pedido a fábrica, no la referencia del distribuidor.';

-- Alinear el archivo de LSG con la forma nueva de products (ver 20261215).
do $$
declare r record;
begin
  if to_regclass('archive.lsg_products') is null then return; end if;
  for r in
    select a.attname, format_type(a.atttypid, a.atttypmod) as coltype
      from pg_attribute a
     where a.attrelid = 'public.products'::regclass
       and a.attnum > 0 and not a.attisdropped
       and not exists (
         select 1 from pg_attribute b
          where b.attrelid = 'archive.lsg_products'::regclass
            and b.attnum > 0 and not b.attisdropped
            and b.attname = a.attname)
     order by a.attnum
  loop
    execute format('alter table archive.lsg_products add column %I %s', r.attname, r.coltype);
  end loop;
end $$;

notify pgrst, 'reload schema';
