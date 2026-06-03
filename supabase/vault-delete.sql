-- Run this in the Supabase SQL editor after vault-helpers.sql.
-- Adds delete wrappers so service-role API routes can permanently remove user-scoped
-- secrets (key removal on DELETE, account deletion, calendar disconnect) instead of
-- blanking them to an empty string. Safe to run more than once.

create or replace function delete_user_secret(p_user_id uuid, p_secret_name text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'user_secret_' || p_user_id::text || '_' || p_secret_name;
begin
  if p_secret_name !~ '^[a-z0-9_]+$' then
    raise exception 'Invalid secret name';
  end if;

  delete from vault.secrets where name = secret_name;
end;
$$;

create or replace function delete_user_api_key(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'api_key_' || p_user_id::text;
begin
  delete from vault.secrets where name = secret_name;
end;
$$;

grant execute on function delete_user_secret(uuid, text) to service_role;
grant execute on function delete_user_api_key(uuid) to service_role;
