// Dumps a normalized signature of the public schema (tables, columns, indexes,
// functions, policies, check constraints) for diffing two migration paths.
// Usage: node test-harness/schema-signature.mjs > /tmp/sig.txt
import pg from 'pg'

const DB = process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const c = new pg.Client({ connectionString: DB })
await c.connect()

const out = []

const cols = await c.query(`
  select table_name, column_name, data_type, is_nullable, coalesce(column_default, '') as col_default
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, column_name`)
for (const r of cols.rows) {
  // Normalize volatile defaults (sequences etc. aren't used here, keep as-is)
  out.push(`COL ${r.table_name}.${r.column_name} ${r.data_type} null=${r.is_nullable} default=${r.col_default}`)
}

const idx = await c.query(`
  select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`)
for (const r of idx.rows) out.push(`IDX ${r.indexname}: ${r.indexdef}`)

const fns = await c.query(`
  select p.proname, pg_get_function_identity_arguments(p.oid) as args,
         pg_get_function_result(p.oid) as result, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' order by p.proname, args`)
for (const r of fns.rows) out.push(`FN ${r.proname}(${r.args}) -> ${r.result} secdef=${r.prosecdef}`)

const pol = await c.query(`
  select tablename, policyname, cmd, coalesce(qual,'') as qual, coalesce(with_check,'') as with_check
  from pg_policies where schemaname = 'public' order by tablename, policyname`)
for (const r of pol.rows) out.push(`POL ${r.tablename}.${r.policyname} ${r.cmd} qual=${r.qual} check=${r.with_check}`)

const chk = await c.query(`
  select rel.relname, con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public' and con.contype in ('c','u','p','f')
  order by rel.relname, con.conname`)
for (const r of chk.rows) out.push(`CON ${r.relname}.${r.conname}: ${r.def}`)

// Function privileges for the sensitive RPCs (anon must not execute)
for (const fn of ['review_card_atomic', 'claim_jobs', 'consume_daily_quota']) {
  const r = await c.query(
    `select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname=$1`, [fn])
  for (const row of r.rows) out.push(`PRIV ${row.proname} anon_exec=${row.anon_exec}`)
}

console.log(out.sort().join('\n'))
await c.end()
