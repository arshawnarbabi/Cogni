-- Move Google Calendar tokens out of public.calendar_connections and into Supabase Vault.
-- Run after vault-helpers.sql and vault-get.sql.

alter table public.calendar_connections
  alter column access_token drop not null;

comment on column public.calendar_connections.access_token is
  'Deprecated. Token secrets are stored in Vault under google_calendar_access_token.';

comment on column public.calendar_connections.refresh_token is
  'Deprecated. Token secrets are stored in Vault under google_calendar_refresh_token.';

update public.calendar_connections
set access_token = null,
    refresh_token = null
where provider = 'google';
