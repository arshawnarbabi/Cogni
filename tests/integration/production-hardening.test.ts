import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'

// Locks in the section-10 security posture: the new operator/config/abuse RPCs
// and tables must be unreachable by the public (anon) Data API. If any of these
// flip to reachable, a regression has opened a hole.

const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

describe('production hardening — anon is denied operator/config/abuse surfaces', () => {
  it('anon cannot call the SECURITY DEFINER operator/config RPCs', async () => {
    const a = await anon.rpc('operator_set_suspended', { p_user_id: '00000000-0000-0000-0000-000000000000', p_suspended: true, p_reason: 'x' })
    const b = await anon.rpc('consume_invite_code', { p_code: 'x', p_email: 'x' })
    const c = await anon.rpc('purge_old_daily_usage')
    expect(a.error).not.toBeNull()
    expect(b.error).not.toBeNull()
    expect(c.error).not.toBeNull()
  })

  it('anon cannot read app_config / invite_codes / audit_log (RLS deny-by-default)', async () => {
    const cfg = await anon.from('app_config').select('*')
    const inv = await anon.from('invite_codes').select('*')
    const aud = await anon.from('audit_log').select('*')
    // RLS with no anon policy returns zero rows (or an error) — never data.
    expect((cfg.data?.length ?? 0)).toBe(0)
    expect((inv.data?.length ?? 0)).toBe(0)
    expect((aud.data?.length ?? 0)).toBe(0)
  })

  it('service role CAN administer (consume an invite code, single-use)', async () => {
    const code = 'test_' + Math.random().toString(36).slice(2)
    await service.from('invite_codes').insert({ code })
    const first = await service.rpc('consume_invite_code', { p_code: code, p_email: 'a@b.com' })
    const second = await service.rpc('consume_invite_code', { p_code: code, p_email: 'a@b.com' })
    expect(first.data).toBe(true)   // claimed
    expect(second.data).toBe(false) // already used
    await service.from('invite_codes').delete().eq('code', code)
  })

  it('list_user_scoped_tables RPC returns tables to service, denied to anon (GDPR export depends on it)', async () => {
    const svc = await service.rpc('list_user_scoped_tables')
    expect(svc.error).toBeNull()
    expect((svc.data?.length ?? 0)).toBeGreaterThan(5) // many user-scoped tables exist
    const an = await anon.rpc('list_user_scoped_tables')
    expect(an.error).not.toBeNull()
  })
})

describe('production hardening — signup gating is enforced at the DB layer (bypass-proof)', () => {
  it('signups_paused blocks even a DIRECT anon signUp (not just the server route)', async () => {
    try {
      await service.from('app_config').update({ signups_paused: true }).eq('id', true)
      const email = `paused_${Math.random().toString(36).slice(2)}@example.com`
      const { data, error } = await anon.auth.signUp({ email, password: 'password123' })
      // The auth.users BEFORE INSERT trigger rejects it → no user created.
      expect(!!error || !data?.user).toBe(true)
    } finally {
      await service.from('app_config').update({ signups_paused: false }).eq('id', true)
    }
  })
})
