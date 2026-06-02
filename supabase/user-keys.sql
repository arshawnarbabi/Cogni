-- Generic per-user key store (metadata only).
-- Secret values are stored encrypted in Supabase Vault (see vault-helpers.sql);
-- key_value is nullable because plaintext secrets are migrated out via
-- user-keys-vault-migration.sql. New writes never store plaintext here.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id  UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL,
  key_value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, key_name)
);

-- Idempotent: relax legacy NOT NULL on existing deployments so plaintext can be removed.
ALTER TABLE user_keys ALTER COLUMN key_value DROP NOT NULL;

ALTER TABLE user_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own keys" ON user_keys;
CREATE POLICY "Users manage their own keys"
  ON user_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
