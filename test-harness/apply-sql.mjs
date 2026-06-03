// Applies supabase/setup.sql to the local Supabase Postgres.
// Enables the Vault extension first (the combined file leaves it commented as a
// manual/dashboard step). Idempotent — safe to re-run.
import { readFileSync } from 'node:fs'
import pg from 'pg'

const DB = process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const client = new pg.Client({ connectionString: DB })
await client.connect()
try {
  await client.query('create extension if not exists supabase_vault cascade;')
  const sql = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8')
  await client.query(sql)
  // sanity: count tables + the vault RPCs
  const t = await client.query(
    "select count(*)::int n from information_schema.tables where table_schema='public'"
  )
  const f = await client.query(
    "select count(*)::int n from pg_proc where proname in ('store_user_secret','get_user_secret','delete_user_secret','review_card_atomic','match_material_chunks')"
  )
  console.log(`setup.sql applied OK — public tables: ${t.rows[0].n}, key RPCs present: ${f.rows[0].n}/5`)
} catch (e) {
  console.error('APPLY FAILED:', e.message)
  process.exitCode = 1
} finally {
  await client.end()
}
