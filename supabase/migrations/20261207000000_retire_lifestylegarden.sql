-- ─────────────────────────────────────────────────────────────────────────────
-- LIFESTYLEGARDEN SALE DEL CATALOGO.
--
-- El catalogo llevaba 109 productos con `brand = 'lifestylegarden'` y ninguna
-- fila en `brands` que apuntara a ese catalogo. Desde que la frontera entre
-- marcas se impone en Postgres eran invisibles para todo el mundo; antes ya lo
-- eran de hecho, porque `brandScope` filtraba por `catalogBrand='ligne-roset'`.
-- Datos que nadie puede alcanzar y nadie mantiene: se retiran.
--
-- QUE SE VA, exactamente:
--   • public.products  where brand = 'lifestylegarden'   (109)
--   • public.images    where kind  = 'catalog-lsg'       (830)
--
-- COMPROBADO ANTES DE BORRAR, y esta es la parte que importa de un borrado
-- masivo — ningun configurator_model, model_fabric, material, ajuste, solicitud ni
-- cotizacion referencia ninguna de esas filas; ninguna imagen esta compartida
-- con un producto de otra marca; y las 109 fotos son punteros a CDN externo
-- (`external_url`, sin bytes en el bucket), asi que el borrado no deja basura
-- en storage ni un solo `image_id` roto. Verificado despues tambien: cero
-- productos y cero modelos apuntando a una imagen que ya no existe.
--
-- SE ARCHIVA ANTES DE BORRARSE. Un borrado masivo sin vuelta atras es una
-- decision que solo se puede tomar una vez, y el coste de poder deshacerla es
-- el espacio que ya ocupaba. La copia vive en el esquema `archive`, que
-- PostgREST no publica, asi que no aparece en ninguna API ni en ninguna
-- pantalla. Deshacer es un `insert into public.products select * from
-- archive.lsg_products`. Cuando el borrado se de por definitivo:
--
--     drop schema archive cascade;
--
-- LO QUE ESTA MIGRACION NO TOCA: el codigo. `BRAND_LIFESTYLEGARDEN`,
-- `ALL_BRANDS`, las tasas de comision por marca y el resto de rutas que nombran
-- LSG siguen en `src/`. Son logica de dinero heredada, y quitarlas es una
-- decision aparte de retirar los datos — no un efecto secundario de ella.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists archive;
comment on schema archive is
  'Copias de seguridad de borrados masivos. Fuera de la lista de esquemas que expone PostgREST, a proposito. Vaciar cuando el borrado se de por definitivo.';

-- Idempotente y seguro en una base recien construida: sobre datos que ya no
-- estan (o nunca estuvieron) el archivo sale vacio y el borrado no toca nada.
-- `if not exists` en vez de `drop`+`create`: una re-ejecucion no puede
-- sustituir una copia con datos por una copia vacia — que es exactamente como
-- se pierde el respaldo justo cuando hace falta.
create table if not exists archive.lsg_products (like public.products including defaults);
create table if not exists archive.lsg_images   (like public.images   including defaults);

insert into archive.lsg_products
  select p.* from public.products p
   where p.brand = 'lifestylegarden'
     and not exists (select 1 from archive.lsg_products a where a.id = p.id);

insert into archive.lsg_images
  select i.* from public.images i
   where i.kind = 'catalog-lsg'
     and not exists (select 1 from archive.lsg_images a where a.id = i.id);

comment on table archive.lsg_products is 'public.products where brand=''lifestylegarden'', archivado antes del borrado';
comment on table archive.lsg_images   is 'public.images where kind=''catalog-lsg'', archivado antes del borrado';

delete from public.products where brand = 'lifestylegarden';
delete from public.images   where kind  = 'catalog-lsg';

notify pgrst, 'reload schema';
