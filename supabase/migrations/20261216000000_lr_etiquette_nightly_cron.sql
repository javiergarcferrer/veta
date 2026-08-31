-- ─────────────────────────────────────────────────────────────────────────────
-- La sincronización «Étiquette» nocturna, para que nadie tenga que acordarse.
--
-- pg_cron llama a la función con `{cron:true}` (Bearer service key) cada noche;
-- la función corre LA MISMA operación que el botón (`{sync:true}`), así que las
-- dos no pueden divergir. El job se registra A TRAVÉS de la función (que conoce
-- su propia URL y su llave por su entorno), de modo que aquí no se codifica
-- ninguna URL de proyecto: la primera sincronización manual lo instala.
--
-- 07:00 UTC = 03:00 en República Dominicana — la sala está cerrada, el feed
-- ocioso, y una corrida que se alargue no choca con nadie cotizando.
--
-- Aditiva + idempotente: safe de re-correr.
-- ─────────────────────────────────────────────────────────────────────────────

-- En Supabase ambas extensiones existen y esto las instala; en un Postgres
-- pelado (el harness de tests, un entorno local) no hay .so que cargar, así
-- que degrada con un aviso en vez de tumbar la cadena entera de migraciones —
-- la función de abajo se crea igual y el job se registra donde sí se puede.
do $$ begin
  create extension if not exists pg_cron;
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_cron/pg_net no instalables aquí (%) — el job nocturno se registra en Supabase, donde sí existen', sqlerrm;
end $$;

-- El DEFINER vive en `veta` (la doctrina de helpers_off_the_api); la función
-- Edge lo alcanza por el envoltorio plano de `public`, que es lo único que
-- PostgREST expone a supabase.rpc().
create or replace function veta.ensure_lr_etiquette_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'lr-etiquette-nightly') then
    perform cron.unschedule('lr-etiquette-nightly');
  end if;
  -- 10 minutos de timeout: los dibujos drenan por tandas, y una tanda cortada
  -- simplemente deja el resto para mañana — nada se pierde ni queda a medias.
  perform cron.schedule('lr-etiquette-nightly', '0 7 * * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb, timeout_milliseconds:=600000);');
end $$;

revoke all on function veta.ensure_lr_etiquette_cron(text, text) from public;
revoke all on function veta.ensure_lr_etiquette_cron(text, text) from anon;
grant execute on function veta.ensure_lr_etiquette_cron(text, text) to service_role;

create or replace function public.ensure_lr_etiquette_cron(p_url text, p_secret text)
returns void
language sql
as $$ select veta.ensure_lr_etiquette_cron(p_url, p_secret) $$;
revoke all on function public.ensure_lr_etiquette_cron(text, text) from public;
revoke all on function public.ensure_lr_etiquette_cron(text, text) from anon;
grant execute on function public.ensure_lr_etiquette_cron(text, text) to service_role;
-- El envoltorio corre como service_role, que necesita USAGE sobre `veta` para
-- resolver el definer (a `authenticated` se lo dio helpers_off_the_api).
grant usage on schema veta to service_role;

notify pgrst, 'reload schema';
