-- Run this in the Supabase SQL editor after enabling Vault.
-- Creates public-schema wrappers so service-role API routes can store user-scoped secrets by name.

create or replace function store_user_secret(p_user_id uuid, p_secret_name text, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'user_secret_' || p_user_id::text || '_' || p_secret_name;
  existing_id uuid;
begin
  if p_secret_name !~ '^[a-z0-9_]+$' then
    raise exception 'Invalid secret name';
  end if;

  select id into existing_id from vault.secrets where name = secret_name;

  if existing_id is not null then
    perform vault.update_secret(existing_id, p_secret, secret_name, 'Cogni user secret');
  else
    perform vault.create_secret(p_secret, secret_name, 'Cogni user secret');
  end if;
end;
$$;

create or replace function store_user_api_key(p_user_id uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'api_key_' || p_user_id::text;
  existing_id uuid;
begin
  select id into existing_id from vault.secrets where name = secret_name;

  if existing_id is not null then
    perform vault.update_secret(existing_id, p_key, secret_name, 'User AI API key');
  else
    perform vault.create_secret(p_key, secret_name, 'User AI API key');
  end if;
end;
$$;

-- Grant execute to authenticated role so API routes using service key can call it
grant execute on function store_user_secret(uuid, text, text) to service_role;
grant execute on function store_user_api_key(uuid, text) to service_role;
