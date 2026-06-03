// Stores the BYOK AI keys into the test user's local Supabase Vault (the app
// reads them from Vault, not env). Keys come from env — never written to a file.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

if (process.env.ANTHROPIC_KEY) {
  const { error } = await db.rpc('store_user_api_key', { p_user_id: seed.userId, p_key: process.env.ANTHROPIC_KEY })
  if (error) throw new Error('store anthropic: ' + error.message)
  console.log('stored Anthropic key in vault for', seed.userId)
}
if (process.env.OPENAI_KEY) {
  const { error } = await db.rpc('store_user_secret', { p_user_id: seed.userId, p_secret_name: 'openai_key', p_secret: process.env.OPENAI_KEY })
  if (error) throw new Error('store openai: ' + error.message)
  console.log('stored OpenAI key in vault')
}
console.log('done')
