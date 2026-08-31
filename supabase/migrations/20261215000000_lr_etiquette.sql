-- ─────────────────────────────────────────────────────────────────────────────
-- LR ÉTIQUETTE — el catálogo OFICIAL de Ligne Roset llega a VETA.
--
-- Portado de RosetSoft (donde llegó en seis migraciones: sync, fields, config,
-- config_anon, nightly_cron, sync_phase) como UNA migración coherente — este
-- esquema nace aquí completo, no tiene historia que preservar por partes.
--
-- Qué trae:
--   • `lr_etiquette_sync` — una fila con el estado del último import Y la
--     máquina de fases que hace la sincronización REANUDABLE (una Edge Function
--     recibe 2 s de CPU; el catálogo solo ya gasta ~1.4 s, así que una
--     invocación = una fase: idle → catalog → book → images → idle).
--   • Columnas nuevas en `products` — lo que el feed publica y tiene lector:
--     la descripción del fabricante, el diseñador, el volumen de embarque, los
--     bultos, el código de origen (verbatim, NO es ISO 3166) y el dibujo
--     técnico (`spec_image_id`, separado de `image_id`: el esquema no es la
--     foto).
--   • `lr_etiquette_config` — la URL del feed como CREDENCIAL de sólo
--     escritura: el feed no tiene login, poseer el token del path da el
--     catálogo entero, así que la URL se trata como una API key (sin política
--     de lectura; sólo la escribe el RPC y la lee la función con service role).
--   • `link_lr_spec_images` — enlazar dibujos a SKUs en UNA sentencia
--     (spec_image_id es derivable de la referencia; 27.000 UPDATEs no).
--
-- Divergencias deliberadas respecto a RosetSoft (instalación multi-tenant):
--   • sin FK a profiles — aquí 'team' es el perfil de datos, no una fila de
--     profiles; • el guard del RPC comprueba `profiles.active` directamente
--     (VETA no tiene is_active_member); • la política de lectura de la tabla de
--     estado sigue la convención local de import_runs (lectura para el equipo,
--     escritura sólo desde la función).
--
-- Aditiva + idempotente: correr el conjunto contra un proyecto vivo no pisa
-- nada.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── El estado del import, con su máquina de fases ───────────────────────────
create table if not exists public.lr_etiquette_sync (
  profile_id       text primary key default 'team',
  last_run_at      timestamptz,
  last_ok          boolean,
  last_error       text,
  last_written     integer not null default 0,
  last_deactivated integer not null default 0,
  last_images      integer not null default 0,
  -- El Last-Modified de Article.csv tal como el feed lo reporta, para poder
  -- decir «Roset no ha publicado nada nuevo» en vez de reimportar a ciegas.
  feed_modified    text,
  -- El cursor del change-log: DiffArticle.xml pesa 125 MB desde 2021 y sólo se
  -- lee hacia adelante desde el último DATMAJ aplicado.
  diff_cursor      text,
  -- La máquina de fases (ver cabecera). Una fase fuera de la escalera
  -- colgaría la corrida para siempre — el CHECK la hace fallar en el borde.
  phase            text    not null default 'idle',
  catalog_offset   integer not null default 0,
  catalog_modified text,
  drawings_total   integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$ begin
  alter table public.lr_etiquette_sync
    add constraint lr_etiquette_sync_phase_check
    check (phase in ('idle', 'catalog', 'book', 'images'));
exception when duplicate_object then null; end $$;

alter table public.lr_etiquette_sync enable row level security;

-- Convención local (import_runs): el equipo LEE el estado; lo escribe sólo la
-- Edge Function con el service role, así que ninguna superficie puede fingir
-- una corrida verde.
drop policy if exists lr_etiquette_sync_read on public.lr_etiquette_sync;
create policy lr_etiquette_sync_read on public.lr_etiquette_sync
  for select to authenticated
  using (true);

comment on table public.lr_etiquette_sync is
  'Estado del import del feed oficial Ligne Roset «Étiquette» + su máquina de fases. No guarda catálogo ni credencial — truncarla sólo pierde el letrero de «última importación».';

-- ── Lo demás que Article.csv trae y tiene lector ────────────────────────────
alter table public.products add column if not exists catalog_description text;
alter table public.products add column if not exists designer            text;
alter table public.products add column if not exists volume_m3           numeric;
alter table public.products add column if not exists packages            integer;
alter table public.products add column if not exists origin_code         text;
alter table public.products add column if not exists spec_image_id       text;

comment on column public.products.catalog_description is
  'La prosa del fabricante (Article.csv REMARQUE) — no es el campo editable del distribuidor.';
comment on column public.products.origin_code is
  'Article.csv PAYSORI verbatim — código interno de Roset, NO ISO 3166. No hay tabla que lo decodifique; no renderizarlo como país.';
comment on column public.products.spec_image_id is
  'El dibujo técnico (Filaires) espejado. Un esquema, no una foto — image_id sigue siendo la fotografía.';

-- ── La URL del feed, como credencial de sólo escritura ──────────────────────
create table if not exists public.lr_etiquette_config (
  profile_id text primary key default 'team',
  -- La base completa, token incluido. Nunca vuelve a un cliente.
  base_url   text not null,
  updated_at timestamptz not null default now()
);

alter table public.lr_etiquette_config enable row level security;
-- Sin políticas de cliente A PROPÓSITO: sólo el RPC de abajo escribe y sólo la
-- función lr-etiquette (service role) lee.

create or replace function public.save_lr_etiquette_config(p_base_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := btrim(coalesce(p_base_url, ''));
begin
  -- El escritor de la credencial responde a un miembro activo y a nadie más.
  -- Comprobado EN EL CUERPO además del grant: una función SECURITY DEFINER es
  -- tan segura como el grant más flojo que alguien añada después.
  if not exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and coalesce(p.active, false)
  ) then
    raise exception 'No autorizado.';
  end if;

  -- http plano pondría el token en claro en el cable. Rechazar antes que
  -- guardar una credencial que se filtra en su primer uso.
  if v_url !~ '^https://' then
    raise exception 'El enlace del feed debe empezar con https://';
  end if;
  -- El token es un segmento del path; un host pelado es un enlace que no puede
  -- funcionar. Atraparlo aquí gana a un 404 tres pantallas después.
  if v_url !~ '^https://[^/]+/.+' then
    raise exception 'Falta el token en el enlace del feed (https://host/TOKEN/).';
  end if;

  -- Exactamente una barra final: todo path que la función añade es relativo.
  v_url := regexp_replace(v_url, '/+$', '') || '/';

  insert into public.lr_etiquette_config (profile_id, base_url, updated_at)
  values ('team', v_url, now())
  on conflict (profile_id) do update
    set base_url = excluded.base_url, updated_at = now();

  -- Estado no sensible para la tarjeta: el HOST solamente — nunca el token.
  update public.settings
     set lr_etiquette_connected_at = now(),
         lr_etiquette_host = split_part(split_part(v_url, '://', 2), '/', 1)
   where profile_id = 'team';
end;
$$;

-- Supabase concede EXECUTE a `anon` POR DEFECTO al crear una función — ambos
-- revokes son necesarios o el escritor de la credencial queda abierto a
-- tráfico anónimo (la lección de la migración config_anon de RosetSoft).
revoke all on function public.save_lr_etiquette_config(text) from public;
revoke all on function public.save_lr_etiquette_config(text) from anon;
grant execute on function public.save_lr_etiquette_config(text) to authenticated;

alter table public.settings
  add column if not exists lr_etiquette_connected_at timestamptz,
  add column if not exists lr_etiquette_host         text default '';

comment on table public.lr_etiquette_config is
  'La URL base del feed «Étiquette», token incluido — SÓLO ESCRITURA. El feed no tiene login: la URL ES la credencial.';

-- ── Enlazar dibujos a SKUs en una sentencia ─────────────────────────────────
create or replace function public.link_lr_spec_images(p_profile_id text default 'team')
returns integer
language plpgsql
as $$
declare
  v_rows integer;
begin
  update public.products p
     set spec_image_id = i.id
    from public.images i
   where p.profile_id = p_profile_id
     and p.brand = 'ligne-roset'
     and i.kind = 'catalog-lr-spec'
     and i.id = 'lretq-' || left(p.reference, 8)
     and p.spec_image_id is distinct from i.id;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- Sólo la Edge Function (service role) lo llama.
revoke all on function public.link_lr_spec_images(text) from public;
revoke all on function public.link_lr_spec_images(text) from anon;
grant execute on function public.link_lr_spec_images(text) to service_role;

notify pgrst, 'reload schema';
