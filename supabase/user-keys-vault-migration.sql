-- One-time migration: move any plaintext per-user secrets still held in
-- public.user_keys (e.g. OpenAI keys set before Vault storage was added) into the
-- Vault, then remove the plaintext rows. Idempotent: once rows are migrated and
-- deleted, re-running is a no-op. Requires vault-helpers.sql to be applied first.

do $$
declare
  r record;
begin
  for r in
    select user_id, key_name, key_value
    from public.user_keys
    where key_value is not null
      and key_value <> ''
      and key_name ~ '^[a-z0-9_]+$'
  loop
    -- Store under the same name the app reads via get_user_secret().
    perform public.store_user_secret(r.user_id, r.key_name, r.key_value);
    -- Drop the plaintext copy now that the Vault holds it.
    delete from public.user_keys
    where user_id = r.user_id and key_name = r.key_name;
  end loop;
end $$;
