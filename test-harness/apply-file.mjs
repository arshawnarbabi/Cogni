// Applies an arbitrary SQL file to the local Supabase Postgres (verification
// harness for migrations). Usage: node test-harness/apply-file.mjs <path.sql>
import { readFileSync } from 'node:fs'
import pg from 'pg'

const DB = process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const file = process.argv[2]
if (!file) {
  console.error('usage: node test-harness/apply-file.mjs <path.sql>')
  process.exit(1)
}

const client = new pg.Client({ connectionString: DB })
await client.connect()
try {
  await client.query('create extension if not exists supabase_vault cascade;')
  const sql = readFileSync(file, 'utf8')
  await client.query(sql)
  console.log(`OK: ${file} applied cleanly`)
} catch (e) {
  console.error(`APPLY FAILED (${file}):`, e.message)
  process.exitCode = 1
} finally {
  await client.end()
}
