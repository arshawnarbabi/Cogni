// Image content moderation via OpenAI's omni-moderation model, using the user's
// own OpenAI key (BYOK). Returns flagged=true when the image violates policy.
//
// Posture: we screen uploaded images and BLOCK flagged content (the Acceptable
// Use Policy commits to this). Because moderation runs on the user's BYOK OpenAI
// key, it can only run when the user has a key configured — `checked` reports
// whether a real check happened so the caller can log coverage gaps. We fail
// OPEN on infra errors (don't block a legit upload on a transient API failure),
// but a flagged result is authoritative.
//
// NOTE (operator): for stronger guarantees independent of the user's key — and
// for any legally-required CSAM detection/reporting — add a platform-funded
// moderation/hash-matching provider. This BYOK check is a baseline, not a
// substitute for that obligation.

export type ModerationResult = { flagged: boolean; checked: boolean; categories: string[] }

export async function moderateImage(
  openaiKey: string | null | undefined,
  image: { base64: string; mimeType: string },
): Promise<ModerationResult> {
  if (!openaiKey) return { flagged: false, checked: false, categories: [] }
  try {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: openaiKey })
    const res = await client.moderations.create({
      model: 'omni-moderation-latest',
      input: [{ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }],
    })
    const result = res.results[0]
    const categories = result
      ? Object.entries(result.categories).filter(([, v]) => v === true).map(([k]) => k)
      : []
    return { flagged: result?.flagged === true, checked: true, categories }
  } catch (e) {
    console.error('[moderation] image check failed', e)
    return { flagged: false, checked: false, categories: [] }
  }
}
