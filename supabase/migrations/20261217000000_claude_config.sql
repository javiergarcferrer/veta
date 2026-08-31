-- ─────────────────────────────────────────────────────────────────────────────
-- claude_config — la llave de Anthropic que `togo-match` lee.
--
-- `togo-match` (portada de RosetSoft) pide a Claude que ELIJA la referencia que
-- tarifa un modelo subido, entre la lista corta que el navegador ya redujo
-- (lib/togo/modelMatch). La llave es un secreto: tabla de SÓLO ESCRITURA (sin
-- SELECT de cliente), escrita por un RPC SECURITY DEFINER, leída únicamente por
-- la función con el service role — el mismo patrón que lr_etiquette_config.
--
-- SIN LLAVE NO HAY ERROR: la función degrada al mejor candidato del cálculo
-- determinista con una nota honesta («Sin llave API…»), así que Modelos
-- funciona desde el día uno y mejora el día que se pegue una llave.
--
-- Aditiva + idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.claude_config (
  profile_id  text primary key default 'team',
  api_key     text not null,
  model       text not null default 'claude-opus-5',
  updated_at  timestamptz not null default now()
);
alter table public.claude_config enable row level security;
-- Sin políticas de cliente a propósito: sólo el escritor de abajo y el lector
-- con service role tocan la llave.

create or replace function public.save_claude_config(p_api_key text, p_model text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and coalesce(p.active, false)
  ) then
    raise exception 'No autorizado.';
  end if;
  if coalesce(p_api_key, '') !~ '^sk-ant-' then
    -- Atrapa el autofill del gestor de contraseñas antes de romper el canal.
    raise exception 'La llave debe ser una API key de Anthropic (empieza con sk-ant-).';
  end if;
  insert into public.claude_config (profile_id, api_key, model, updated_at)
  values ('team', p_api_key, coalesce(nullif(p_model, ''), 'claude-opus-5'), now())
  on conflict (profile_id) do update
    set api_key = excluded.api_key, model = excluded.model, updated_at = now();
end;
$$;
revoke all on function public.save_claude_config(text, text) from public;
revoke all on function public.save_claude_config(text, text) from anon;
grant execute on function public.save_claude_config(text, text) to authenticated;

notify pgrst, 'reload schema';
