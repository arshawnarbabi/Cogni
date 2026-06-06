// ─────────────────────────────────────────────────────────────────────────────
// Context-budget governor (F2) — the ONE place injected tutor-prompt blocks
// compete for space.
//
// The memory roadmap grows the prompt every turn (course digest, recap,
// profiles) while the cost roadmap shrinks it (caps, caching). Without an
// arbiter they sabotage each other and the student pays for it. Every block
// that goes into the tutor's dynamic context gets a hard character budget here;
// new features register a budget instead of independently appending.
//
// Budgets are characters (~4 chars/token). Generous enough not to lobotomize a
// block, hard enough that the per-turn dynamic prompt stays bounded no matter
// how much memory/profile/RAG accumulates.
// ─────────────────────────────────────────────────────────────────────────────

export const CONTEXT_BUDGETS = {
  learning_profile: 4000,  // global learning profile (wiki)
  course_memory: 3200,     // rolling per-course digest (M2) — also capped at write time
  weak_topics: 1200,       // weak-areas list
  professor: 3200,         // professor wiki profile
  topics_list: 4800,       // topic-id list for artifact tools
  rag: 20000,              // retrieved course excerpts (own cached block, C1)
} as const

export type ContextBlock = keyof typeof CONTEXT_BUDGETS

/**
 * Clamp a block to its budget. Cuts at a line boundary where possible so we
 * never inject half a bullet, and marks the truncation so the model knows
 * content was elided (instead of silently reasoning from a cut-off sentence).
 */
export function clampBlock(block: ContextBlock, text: string | null | undefined): string {
  if (!text) return ''
  const budget = CONTEXT_BUDGETS[block]
  if (text.length <= budget) return text

  const slice = text.slice(0, budget)
  const lastBreak = slice.lastIndexOf('\n')
  const cut = lastBreak > budget * 0.5 ? slice.slice(0, lastBreak) : slice
  return `${cut}\n[... trimmed to fit context budget ...]`
}
